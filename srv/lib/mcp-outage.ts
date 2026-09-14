import type {
  IMcpFailureClassifier,
  McpError,
  McpFailureKind,
} from '@mcp-abap-adt/llm-agent';
import { isMcpUnavailable } from '@mcp-abap-adt/llm-agent';
import type { ProbeStatus } from './probe-classifier';

/**
 * The connection is gone, as distinct from a tool that ran and failed.
 *
 * The distinction cannot rest on how a message happens to read. A tool's own
 * "forbidden", "timed out" or "currently editing" is domain feedback: escalating
 * it would close a destination that is working. So the handler raises this type
 * deliberately, and everything else stays feedback.
 */
export class McpUnavailableError extends Error {
  readonly code = 'mcp_unavailable';
  constructor(
    readonly destination: string,
    reason: string,
    readonly status: ProbeStatus,
    options?: { cause?: unknown },
  ) {
    // The wording is not cosmetic. On the embedded transport the wrapper
    // catches this and returns only `error.message` as a string — the class,
    // the code and the cause are all dropped — and `McpClientAdapter` escalates
    // a returned error only when `toMcpError` recognises it as
    // MCP_NOT_CONNECTED or MCP_NO_RESPONSE. Anything else stays ordinary tool
    // feedback and the classifier is never consulted at all.
    //
    // So the message carries two things: the underlying cause verbatim, which
    // is where a real ECONNRESET, EHOSTUNREACH or "socket hang up" survives,
    // and the phrase "no response from", which is both true of a system we
    // could not reach and one of the signatures that mapper knows.
    super(`no response from SAP system ${destination}: ${reason}`, options);
    this.name = 'McpUnavailableError';
  }
}

/**
 * The statuses that mean nothing reached SAP.
 *
 * Not a new judgement: `classifyProbe` already draws these lines for
 * `ProbeDestination` and for the `destination_unreachable` answer the chat
 * handlers give. All this does is say which of its verdicts close a
 * destination. An auth failure does not — the system answered, and said no —
 * and neither does a path error or a backend error, both of which mean SAP ran
 * something.
 */
export const OUTAGE_STATUSES: ReadonlySet<ProbeStatus> = new Set([
  'tunnel_timeout',
  'no_scc_registration',
  'wrong_location_id',
  'dns_or_network',
]);

/**
 * Read the verdict the connector already reached, and mark it only if it means
 * the system is gone.
 *
 * `CloudSdkAbapConnection` classifies its own failures and appends `[status]`
 * to the message (`srv/connections/CloudSdkAbapConnection.ts`). Reading that
 * tag is the point: calling `classifyProbe` again from here would re-classify
 * with fields this side does not have — the real HTTP status lives at
 * `error.response.status`, not `error.status`, and the proxy type is not on the
 * error at all — so the second verdict would sometimes disagree with the first,
 * and the one with less information would win.
 *
 * The message keeps the original verbatim, which is where a real ECONNRESET or
 * "socket hang up" survives the string-only crossing described above.
 */
export function asOutage(
  error: unknown,
  destination: string,
): McpUnavailableError | undefined {
  const message = describeCause(error);
  const tagged = /\[([a-z_]+)\]/.exec(message);
  const status = tagged?.[1] as ProbeStatus | undefined;
  if (!status || !OUTAGE_STATUSES.has(status)) return undefined;
  return new McpUnavailableError(destination, message, status, {
    cause: error,
  });
}

const MAX_CAUSE_DEPTH = 5;

/** The marker, on the error or anywhere in its cause chain. */
export function isUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== 'object' || cur === null || seen.has(cur)) return false;
    seen.add(cur);
    if ((cur as { code?: unknown }).code === 'mcp_unavailable') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The mapped codes that close a destination.
 *
 * The library's `MCP_UNAVAILABLE_CODES` is close but not the same list, and the
 * difference is deliberate rather than an oversight in either place. That set
 * answers "did this fail at the transport level", and includes `MCP_HTTP_403`
 * and `MCP_HTTP_404` — which for us mean the server **answered**: a 403 is an
 * authorisation verdict and a 404 is a path. Closing a destination on either
 * would take a working system out of service for every caller because one
 * request was wrong.
 *
 * So the library establishes the fact and this narrows it, which is the same
 * division of labour as everywhere else in this design.
 */
export const OUTAGE_MCP_CODES: ReadonlySet<string> = new Set([
  'MCP_NOT_CONNECTED',
  'MCP_NO_RESPONSE',
  'MCP_TIMEOUT',
  'MCP_TRANSPORT',
  'MCP_HTTP_502',
  'MCP_HTTP_503',
]);

/**
 * Whether a failure that has already crossed the wrapper means the system is
 * gone.
 *
 * This is the **downstream** predicate, and it exists because `isUnavailable`
 * cannot work here. Our typed marker does not survive the embedded transport —
 * the wrapper keeps only `error.message` — so by the time a handler reads
 * `result.error` there is an `McpError` with a mapped code and nothing else.
 * A handler asking `isUnavailable` would find no marker and close nothing,
 * which is precisely how this path failed silently.
 */
export function isOutageError(error: unknown): boolean {
  if (isUnavailable(error)) return true;
  return (
    isMcpUnavailable(error) && OUTAGE_MCP_CODES.has((error as McpError).code)
  );
}

/**
 * The library's seam for the fact. The decision stays ours.
 *
 * `classify` is **async** and takes an `McpError` — the shape the adapter has
 * already mapped the failure into — not a bare `Error`. It also offers
 * `probeHealth`, which this implementation does not use: an outage we have
 * already identified needs no second opinion, and probing here would put a
 * network call on a failure path.
 */
export const outageClassifier: IMcpFailureClassifier = {
  async classify(error: McpError): Promise<McpFailureKind> {
    return isOutageError(error) ? 'unavailable' : 'tool-error';
  },
};

/**
 * A short reason for a log line or a closed-destination record.
 *
 * Defined here because the three channels need the same one and none of them
 * has it: an earlier draft of this plan called `describeCause` an existing
 * helper, and there is no such symbol anywhere in `srv/`.
 */
export function describeCause(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

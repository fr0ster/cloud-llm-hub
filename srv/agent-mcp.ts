/**
 * Planner/controller MCP surface — a SEPARATE MCP endpoint that exposes two
 * tools for an external planner (e.g. Claude Code):
 *
 *   - `list_destinations` — the SAP systems this instance can reach, so the
 *     planner can choose one.
 *   - `execute_step` — delegate ONE concrete step to the SmartAgent executor on
 *     the chosen destination and return its text.
 *
 * The division of labour lives in `execute_step`'s description: the connecting
 * client is the planner/controller; the agent behind the tool is a stateless
 * executor. The full ABAP tool set stays on `/mcp/stream/http`; this is an
 * additive, parallel surface.
 *
 * Auth is unchanged: SAP credentials arrive in `x-sap-login` / `x-sap-password`
 * headers (set by the auth proxy's defaults or overridden by the client). The
 * server stores no credentials. The destination is chosen per call (the
 * `destination` argument), so the SAP connection is built lazily inside the
 * `execute_step` handler — `list_destinations` and the MCP handshake need no
 * connection at all.
 */

import './env-setup';

import { randomUUID } from 'node:crypto';
import type { SapConfig } from '@mcp-abap-adt/connection';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cds from '@sap/cds';
import type { Request } from 'express';
import { z } from 'zod';
import { getSmartAgent, runWithRequestConnection } from './agent-manager';
import { createConnection } from './connections/connectionFactory';
import { resolveDestinationSapConfig } from './connections/destinationResolver';
import { resolveExposition } from './lib/exposition';
import { setRequestResponsible } from './lib/responsible';
import { runWithSessionId } from './request-session';

/**
 * The contract. Read by the connecting MCP client (the planner/controller) the
 * moment it lists tools — this is what makes the role split self-documenting.
 */
const EXECUTE_STEP_DESCRIPTION = [
  'Delegate ONE step to the ABAP/SAP executor agent — describe the OUTCOME you want, and get its result.',
  '',
  'You say WHAT, the executor decides HOW. State the goal in plain business/domain terms. Do NOT prescribe the approach — do not name SAP transactions, GUI steps, MCP tools, function modules, or endpoints. Your theoretical knowledge of HOW something is usually done in SAP (e.g. "run ST22", "use SE11") is very likely WRONG here: the executor works through ADT and picks the right tool itself — telling it HOW only pushes it down a wrong path. Name the subject/outcome (the WHAT — e.g. "the latest short dumps", "table VBAK’s definition"), never the method (the HOW). If it cannot do something, it will tell you.',
  '',
  'Roles. The agent is a capable ABAP executor: it knows the system and selects the right MCP tools by analysing your request, but it does NOT plan, keeps NO state between calls, and cannot adjust based on earlier results. YOU are the planner and controller.',
  '',
  'ONE object per step — keep every step MINIMAL. Each call is an isolated unit of work with its own connection and its own executor session, so one object = one step = one call. NEVER batch several objects into a single step: a long step can exceed the client timeout, and a step cut mid-flight leaves objects created-but-INACTIVE and LOCKED by the orphaned session — which then blocks every later attempt to activate them.',
  '',
  'Parallel is allowed — sequencing is only for real dependencies. Steps that do not depend on each other’s result MAY be dispatched in parallel; only a step that needs a previous step’s outcome waits for it. Do not serialise work that has no dependency between its parts.',
  '',
  'Step granularity — split every CREATE, group only the ACTIVATION. Creating and activating are separate concerns. Independent objects (domains, data elements, tables): one step each, created and activated in their own step, and those steps may run in parallel. Mutually dependent objects (e.g. CDS views linked by composition, a projection view with its behavior definition and implementation): create EACH one in its OWN step WITHOUT activating it — these creates may run in parallel too — then, once ALL of them have completed, run ONE step that activates the whole set together. Group activation applies ONLY to objects that genuinely depend on each other, never to everything.',
  '',
  'Example — building a RAP business object, one object per step in dependency order: (1) each domain in its own step, all in parallel; (2) each data element in its own step, in parallel, after the domains are active; (3) each table/structure in its own step; (4) each CDS interface view in its own step; (5) the CDS projection view, its behavior definition and its behavior implementation — create each in its OWN step in parallel WITHOUT activating, then ONE step that activates all three together (they are mutually dependent and only become consistent as a unit); (6) service definition; (7) service binding. Minimal steps throughout; only the mutually dependent set shares an activation step.',
  '',
  "Verify after every create — do NOT trust a create step's reply alone. Creating and activating ABAP objects can take time and may not finish (or may fail) even when the create step returned text. So after each step that creates something, run SEPARATE verification step(s) — but verify the state that step was SUPPOSED to reach: after a create-AND-activate step (an independent object), check it EXISTS and is ACTIVE; after a create-WITHOUT-activation step (one member of a mutually dependent set), check only that it EXISTS — being inactive there is the CORRECT expected state, not a failure, so never poll it for ACTIVE; check that whole set is ACTIVE only after its shared activation step. Give it a little time first, then re-check a FEW times (poll) until you confirm the expected state, or you get an error. Only move on once the current layer is verified in its expected state. On a confirmed error, analyse it and REACT — fix and retry, change the plan, or ask the user what to do — do not push on as if it succeeded.",
  '',
  'How to use:',
  '- Plan: split the goal into MINIMAL steps that each express ONE concrete outcome for ONE object; one call per step. Mark which steps are independent (dispatch those in parallel) and which must wait for another step’s result. Where a set of objects only becomes consistent as a unit, plan their creates as separate parallel steps and ONE shared activation step after all of them finish. Keep each step about WHAT, not HOW.',
  '- Pick the system: `destination` is OPTIONAL. If THIS MCP server is already bound to one system (a default `X-SAP-Destination` is configured for the connection), omit it — every step runs there. Pass `destination` only when ONE connection can reach several systems and you want to choose per call (see `list_destinations`). To compare two systems, the usual setup is two MCP servers (one per system) — route by server, not by this argument.',
  '- ANALYSE each response before the next step; the executor can err or hallucinate. An impossible request answered confidently is an error or a problem, not success — surface it; do not accept the hallucination.',
  '- CORRECT the plan from what the executor actually returns; do not assume success just because text came back.',
  '',
  'Each call is independent — pass everything the step needs here; nothing carries over.',
  '',
  "Every result ends with the executor's token usage (prompt/completion/total) and iteration/tool-call counts. Use it to track and budget what the executor spends across your plan.",
].join('\n');

export interface AgentMcpResult {
  transport: StreamableHTTPServerTransport;
  cleanup: () => Promise<void>;
}

/** MCP text result helper. */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Build the per-request SAP connection for a chosen destination, using the
 * credentials carried in the request headers (set by the auth proxy or the
 * client). Mirrors the fail-closed per-request policy used by the other
 * channels; throws on a missing/invalid credential instead of writing a
 * response (the caller turns it into an MCP tool error).
 */
async function buildConnectionForDestination(
  req: Request,
  destination: string,
): Promise<IAbapConnection> {
  const sapLogin = (req.headers['x-sap-login'] as string | undefined)?.trim();
  const sapPassword = req.headers['x-sap-password'] as string | undefined;
  const sapClient = (req.headers['x-sap-client'] as string | undefined)?.trim();

  const resolved = await resolveDestinationSapConfig(
    destination,
    req.headers.authorization?.replace('Bearer ', ''),
  );

  const requiresUserCredentials =
    (resolved.proxyType ?? '').toLowerCase() === 'onpremise' ||
    resolved.authenticationType === 'NoAuthentication';
  if (requiresUserCredentials && (!sapLogin || !sapPassword)) {
    throw new Error(
      `Destination "${destination}" requires your SAP username and password (x-sap-login / x-sap-password).`,
    );
  }

  const sapConfig: SapConfig = { ...resolved.sapConfig };
  if (sapLogin && sapPassword) {
    sapConfig.authType = 'basic';
    sapConfig.username = sapLogin;
    sapConfig.password = sapPassword;
    sapConfig.jwtToken = undefined;
  }
  if (sapClient) sapConfig.client = sapClient;

  const conn = createConnection({
    sapConfig,
    destinationName: resolved.destinationName,
  });
  await conn.connect();
  return conn as unknown as IAbapConnection;
}

/**
 * Build the per-request single-purpose MCP server for `/mcp/agent/stream/http`.
 * No SAP connection or agent is resolved here — both tool handlers do their own
 * lazy work, so the MCP handshake and `list_destinations` never depend on a
 * destination being reachable.
 */
export async function createAgentMcpServerForRequest(
  req: Request,
): Promise<AgentMcpResult> {
  const log = cds.log('agent-mcp');

  // Captured once (the user/roles are stable for the request); the destination
  // is per call, so it is read from the tool arguments below.
  const userId = cds.context?.user?.id ?? 'anonymous';
  const exposition = resolveExposition(
    ['MCP_Reader', 'MCP_Analyst', 'MCP_Developer', 'MCP_Full'].filter(
      (role) => cds.context?.user?.is?.(role) ?? false,
    ),
  );

  const server = new McpServer({
    name: 'cloud-llm-hub-agent',
    version: '1.0.0',
  });

  // --- list_destinations --------------------------------------------------
  server.registerTool(
    'list_destinations',
    {
      description:
        'List the SAP systems (destinations) this instance can reach. Pick one and pass its `name` as the `destination` argument of execute_step. Reachability is confirmed when you actually run a step — if a destination is down the executor reports it.',
      inputSchema: {},
    },
    async () => {
      const { getAvailableDestinations } = await import(
        './lib/btp-destinations'
      );
      const dests = await getAvailableDestinations();
      const list = dests.map((d) => ({
        name: d.name,
        proxyType: d.proxyType,
        authentication: d.authentication,
      }));
      return textResult(JSON.stringify({ destinations: list }, null, 2));
    },
  );

  // --- execute_step -------------------------------------------------------
  server.registerTool(
    'execute_step',
    {
      description: EXECUTE_STEP_DESCRIPTION,
      inputSchema: {
        destination: z
          .string()
          .optional()
          .describe(
            'OPTIONAL. The SAP system to run this step against (a destination name from list_destinations). Omit it when this MCP server is already bound to a system via a default `X-SAP-Destination` header; only pass it when one connection can reach several systems.',
          ),
        task: z
          .string()
          .describe(
            'What outcome you want (the WHAT, in plain domain terms — not the HOW).',
          ),
      },
    },
    async ({ destination, task }: { destination?: string; task: string }) => {
      let connection: IAbapConnection | undefined;
      try {
        // Destination from the arg, else the connection's default header.
        const headerDestination = (
          req.headers['x-sap-destination'] as string | undefined
        )?.trim();
        const targetDestination = destination?.trim() || headerDestination;
        if (!targetDestination) {
          return textResult(
            'ERROR: No destination. Pass a `destination` argument, or configure a default `X-SAP-Destination` header on this MCP server. See list_destinations.',
            true,
          );
        }
        connection = await buildConnectionForDestination(
          req,
          targetDestination,
        );
        // Per-request responsible person for ADT writes (create/update/delete).
        setRequestResponsible(req.headers);
        const handle = await getSmartAgent(undefined, targetDestination);

        // Ephemeral session per call → the executor loads/saves no history.
        const sessionId = `agent-step-${randomUUID()}`;
        const opts = {
          stream: false,
          externalTools: [],
          sessionId,
          ragFilter: {
            namespace: `${userId}:${targetDestination}`,
            exposition,
          },
          trace: { traceId: sessionId },
          // Surface skill selection on the planner path (chat has its own
          // sessionLogger; execute_step had none, so skill matching was invisible).
          sessionLogger: {
            logStep(name: string, data: unknown) {
              if (
                name === 'skills_selected' ||
                name === 'skill_select_rag_fallback'
              ) {
                log.info(name, { destination: targetDestination, data });
              }
            },
          },
        };

        const conn = connection;
        const r = await runWithSessionId(sessionId, () =>
          runWithRequestConnection(conn, () =>
            handle.agent.process([{ role: 'user', content: task }], opts),
          ),
        );

        if (!r.ok) {
          log.info('execute_step done', {
            ok: false,
            destination: targetDestination,
          });
          return textResult(
            `ERROR on destination "${targetDestination}": ${r.error.message}`,
            true,
          );
        }

        const usage = r.value.usage;
        // Detect problems the executor may have masked in a "successful" result
        // so the consumer always learns about them (not just a plausible answer):
        //  - the run was CUT SHORT at its iteration / tool-call limit (incomplete)
        //  - the executor returned NO content (the step likely failed / did nothing)
        const truncated =
          r.value.stopReason === 'iteration_limit' ||
          r.value.stopReason === 'tool_call_limit';
        const emptyContent = !r.value.content?.trim();
        const isProblem = truncated || emptyContent;

        log.info('execute_step done', {
          ok: true,
          destination: targetDestination,
          iterations: r.value.iterations,
          toolCallCount: r.value.toolCallCount,
          totalTokens: usage?.totalTokens,
          stopReason: r.value.stopReason,
          problem: isProblem || undefined,
        });

        // Surface what the executor spent so the planner can track/budget it,
        // as a compact footer appended to the answer text.
        //
        // NOTE: do NOT return `structuredContent` here. This tool has no
        // registered outputSchema, and returning structuredContent made SSE
        // clients / the auth proxy drop the text payload (empty result). Keep
        // usage in the text footer only.
        const answer = r.value.content?.trim() || '(no response)';

        // Prepend an unmissable PROBLEM banner (and flag isError) so the consumer
        // cannot mistake a truncated / empty run for success.
        let banner = '';
        if (truncated) {
          banner = `PROBLEM: the executor stopped at its ${
            r.value.stopReason === 'iteration_limit' ? 'iteration' : 'tool-call'
          } limit before finishing — this result is INCOMPLETE and may be unreliable. Do not treat it as success; narrow the step or split it further.\n\n`;
        } else if (emptyContent) {
          banner =
            'PROBLEM: the executor returned no content — the step likely failed or did nothing. Do not treat it as success.\n\n';
        }

        const footer = usage
          ? `\n\n---\n_executor usage — tokens: prompt ${usage.promptTokens}, completion ${usage.completionTokens}, total ${usage.totalTokens}; iterations ${r.value.iterations}, tool calls ${r.value.toolCallCount}_`
          : `\n\n---\n_executor usage — iterations ${r.value.iterations}, tool calls ${r.value.toolCallCount} (token usage not reported by provider)_`;
        return textResult(banner + answer + footer, isProblem);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('execute_step failed', { destination, error: message });
        return textResult(`ERROR: ${message}`, true);
      } finally {
        (connection as { reset?: () => void } | undefined)?.reset?.();
      }
    },
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless transport
    enableJsonResponse: true,
    enableDnsRebindingProtection: false,
  });
  await server.connect(transport);

  const cleanup = async () => {
    try {
      await transport.close();
    } catch (err) {
      log.warn('transport close failed', { error: String(err) });
    }
  };

  return { transport, cleanup };
}

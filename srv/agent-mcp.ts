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
import { computeDumpScope } from './lib/principal';
import { safeStop } from './lib/request-connection';
import { setRequestResponsible } from './lib/responsible';
import { Semaphore } from './lib/semaphore';
import { runWithSessionId } from './request-session';

/**
 * Global cap on concurrent `execute_step` executions. The tool contract lets a
 * planner dispatch independent steps in parallel; each step is a full SmartAgent
 * pipeline whose peak memory adds up, so an unbounded fan-out could OOM the
 * container (observed: 5 parallel domain-creates on a 1 GB container). This
 * throttles to at most `EXEC_STEP_MAX_CONCURRENCY` running at once — parallel
 * dispatch still works, the excess just waits its turn in FIFO order. Bounding
 * concurrency bounds peak memory regardless of how many calls arrive.
 *
 * Module-level singleton: the MCP server is rebuilt per request, so the cap must
 * live here (shared across all requests), not inside the per-request builder.
 */
const EXEC_STEP_MAX_CONCURRENCY = 2;
const execStepSemaphore = new Semaphore(EXEC_STEP_MAX_CONCURRENCY);

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
  'Two kinds of knowledge — keep them apart. GENERAL ABAP knowledge (the language, RAP, CDS, DDIC, the patterns) is yours to bring: if your client supports skills, load `sap-abap` from the `sap-skills` marketplace (invoke it as `sap-abap:sap-abap`) — that exact one, the marketplace ships ~33 similarly named SAP plugins (`sap-abap-cds`, `sap-sqlscript`, `sap-cap-capire` …) which are not it. CONCRETE knowledge about THIS system — what actually exists in it, how it really behaves, which tool reaches it — belongs to the executor, not to you. So use the skill to decide WHAT to build and to write any source you hand over; never use it to prescribe HOW the executor should reach the system.',
  '',
  'ONE object per step — keep every step MINIMAL. Each call is an isolated unit of work with its own connection and its own executor session, so one object = one step = one call. NEVER batch several objects into a single step: a long step can exceed the client timeout, and a step cut mid-flight leaves objects created-but-INACTIVE and LOCKED by the orphaned session — which then blocks every later attempt to activate them.',
  '',
  'Parallel is allowed — sequencing is only for real dependencies. Steps that do not depend on each other’s result MAY be dispatched in parallel; only a step that needs a previous step’s outcome waits for it. Do not serialise work that has no dependency between its parts.',
  '',
  'Step granularity — always CREATE without activating, ACTIVATE in a separate step. Creating and activating are separate concerns, and combining them in one step is unreliable: a create-and-activate in a single call leaves the ABAP edit-session open when it activates, so the object can be left INACTIVE and reporting "currently being edited" — do NOT ask for "create and activate" in one step. For EVERY object: (1) create it WITHOUT activating (independent objects — domains, data elements, tables — may be created in parallel steps); (2) then ACTIVATE it in a SEPARATE step. Independent objects can each be activated in their own step. Mutually dependent objects (e.g. CDS views linked by composition, a projection view with its behavior definition and implementation) must be created first (each in its own step, without activating) and then activated TOGETHER in ONE shared activation step once all of them exist. Group activation applies only to genuinely co-dependent objects; the create-then-activate split applies to everything.',
  '',
  'Example — building a RAP business object, one object per step in dependency order, always create-without-activate then activate separately: (1) create each domain (own step, parallel) then activate each; (2) create each data element (parallel) then activate, after the domains are active; (3) create then activate each table/structure; (4) create then activate each CDS interface view; (5) create the CDS projection view, its behavior definition and its behavior implementation — each in its OWN step, parallel, WITHOUT activating — then ONE step that activates all three together (mutually dependent, consistent only as a unit); (6) service definition (create, then activate); (7) service binding. Minimal steps throughout; only the mutually dependent set shares an activation step, but no object is created-and-activated in the same step.',
  '',
  "Verify after every step — do NOT trust a step's reply alone. Creating and activating ABAP objects can take time and may not finish (or may fail) even when the step returned text. So after each step run SEPARATE verification step(s) that check the state that step was SUPPOSED to reach: after a CREATE step (which does NOT activate), check the object EXISTS — inactive is the CORRECT expected state there, so never poll it for ACTIVE; after an ACTIVATE step, check the object (or the whole co-dependent set) is ACTIVE. Give it a little time first, then re-check a FEW times (poll) until you confirm the expected state, or you get an error. Only move on once the current step is verified in its expected state. On a confirmed error, analyse it and REACT — fix and retry, change the plan, or ask the user what to do — do not push on as if it succeeded.",
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

/**
 * `recMcp` is attached to the handle at runtime (agent-manager.ts) but is not
 * part of the library's `SmartAgentHandle` type — optional, since an
 * LLM-only handle (no destination) has no per-destination recMcp.
 */
interface HandleWithRecMcp {
  recMcp?: { dropRequest(traceId?: string): void };
}

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
interface BuiltConnection {
  connection: IAbapConnection;
  resolved: Awaited<ReturnType<typeof resolveDestinationSapConfig>>;
  sapConfig: SapConfig;
  sapLogin: string | undefined;
  sapClient: string | undefined;
  // True iff the basic-auth override was actually applied (login AND password
  // both present). The password itself is NOT returned — only this flag.
  usedBasicOverride: boolean;
}

async function buildConnectionForDestination(
  req: Request,
  destination: string,
): Promise<BuiltConnection> {
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

  const usedBasicOverride = !!(sapLogin && sapPassword);
  const sapConfig: SapConfig = { ...resolved.sapConfig };
  if (usedBasicOverride) {
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
  return {
    connection: conn as unknown as IAbapConnection,
    resolved,
    sapConfig,
    sapLogin,
    sapClient,
    usedBasicOverride,
  };
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
      // Throttle concurrent executor runs to bound peak memory (see
      // execStepSemaphore). Parallel dispatch is honoured; the excess waits.
      if (execStepSemaphore.active >= EXEC_STEP_MAX_CONCURRENCY) {
        log.info('execute_step queued — concurrency cap reached', {
          active: execStepSemaphore.active,
          pending: execStepSemaphore.pending,
        });
      }
      const releaseSlot = await execStepSemaphore.acquire();
      let connection: IAbapConnection | undefined;
      // Handle + traceId are assigned inside the try below but read from the
      // `finally` (dropRequest), so they must be declared in the outer scope.
      let handle: Awaited<ReturnType<typeof getSmartAgent>> | undefined;
      let traceId: string | undefined;
      // NOTE: no `req.on('close', ...)` safe-stop hook here. For Node/Express,
      // the request stream's `close` event fires once the BODY is consumed —
      // right after this JSON-RPC call starts — NOT reliably on client abort.
      // Wiring safeStop(connection) to it could tear down the ABAP session
      // (closeSession) while a tool call is still in flight, which is exactly
      // the orphaned-state failure we're trying to avoid. `res` (the real
      // socket/response) is not threaded into this per-tool-call scope — it
      // lives in server.ts's route handler — so there is no safe abort signal
      // available here. Teardown is left entirely to the `finally` below,
      // which always runs safeStop(connection) once the step completes.
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
        const built = await buildConnectionForDestination(
          req,
          targetDestination,
        );
        connection = built.connection;
        const { resolved, sapConfig, sapLogin, sapClient, usedBasicOverride } =
          built;

        // Stable, non-reversible principal + system scope for the principal-scoped
        // cloud-local tools (GetDumpSection's buffer key). Shared with the chat
        // paths via computeDumpScope so the tool has a principal wherever it can
        // be RAG-selected. Fails closed (undefined) for an anonymous caller. The
        // raw login never enters a key/log; jwtSub is null on this path.
        const dumpScope = computeDumpScope({
          cdsUserId: userId,
          usedBasicOverride,
          sapLogin,
          destinationAuthType: sapConfig.authType,
          resolvedUsername: resolved.username,
          destinationName: resolved.destinationName,
          rawClient: sapClient,
          resolvedClient: resolved.sapConfig.client,
          jwtSub: null,
        });

        // Per-request responsible person for ADT writes (create/update/delete).
        setRequestResponsible(req.headers);
        handle = await getSmartAgent(undefined, targetDestination);
        const agentHandle = handle;

        // Ephemeral session per call → the executor loads/saves no history.
        // Doubles as the per-trace telemetry id (Verified fact 10): unique per
        // call, threaded below as `trace.traceId`, dropped in the `finally`.
        const sessionId = `agent-step-${randomUUID()}`;
        traceId = sessionId;
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
          runWithRequestConnection(
            conn,
            () =>
              agentHandle.agent.process(
                [{ role: 'user', content: task }],
                opts,
              ),
            dumpScope,
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

        // Transparent pass-through: return the executor's output VERBATIM — no
        // PROBLEM banner, no usage footer, no reshaping. This MCP is a thin proxy
        // to the agent; whatever the agent produced is exactly what the caller
        // gets. Diagnostics stay server-side in the log below.
        //
        // The executor-honesty guard now lives in the DAG coordinator's
        // `NoticeFinalizer` (see `srv/lib/notice-finalizer.ts`), which runs for
        // EVERY channel (execute_step, /v1/chat, /v1/messages) and already
        // embeds an `UNVERIFIED_WRITE:`-style notice into `r.value.content`
        // when the executor's claim outruns the tools it actually ran. The old
        // execute_step-only wrapper (`assembleReviewedResponse`) is retired —
        // re-reviewing here would be redundant with (and could double-flag)
        // what the coordinator already decided.
        const rawContent = r.value.content ?? '';
        log.info('execute_step done', {
          ok: true,
          destination: targetDestination,
          iterations: r.value.iterations,
          toolCallCount: r.value.toolCallCount,
          totalTokens: r.value.usage?.totalTokens,
          stopReason: r.value.stopReason,
        });
        return textResult(rawContent, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('execute_step failed', { destination, error: message });
        return textResult(`ERROR: ${message}`, true);
      } finally {
        // End the server-side ADT stateful session first (releases any edit-lock
        // a mutating tool left open — the "currently editing" / inactive-object
        // symptom), THEN clear local state. This is the ONLY teardown path now
        // (see the NOTE above — no premature close-based hook).
        await safeStop(connection);
        // Free the per-trace telemetry bucket — nobody else calls dropRequest,
        // so omitting this leaks memory per call (Verified fact 10).
        (handle as unknown as HandleWithRecMcp)?.recMcp?.dropRequest(traceId);
        // Release the concurrency slot last, after the session is torn down, so
        // the next queued step starts only once this one's memory is freed.
        releaseSlot();
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

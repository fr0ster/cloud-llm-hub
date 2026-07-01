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
  'One step at a time. Run exactly ONE execute_step and wait for its result before the next. NEVER call execute_step in parallel — concurrent calls corrupt the executor’s session. Keep it strictly sequential.',
  '',
  'How to use:',
  '- Plan: split the goal into steps that each express ONE concrete outcome; one call per step. Keep each step about WHAT, not HOW.',
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
          return textResult(`Error: ${r.error.message}`, true);
        }

        const usage = r.value.usage;
        log.info('execute_step done', {
          ok: true,
          destination: targetDestination,
          iterations: r.value.iterations,
          toolCallCount: r.value.toolCallCount,
          totalTokens: usage?.totalTokens,
        });

        // Surface what the executor spent so the planner can track/budget it,
        // as a compact footer appended to the answer text.
        //
        // NOTE: do NOT return `structuredContent` here. This tool has no
        // registered outputSchema, and returning structuredContent made SSE
        // clients / the auth proxy drop the text payload (empty result). Keep
        // usage in the text footer only.
        const answer = r.value.content || '(no response)';
        const footer = usage
          ? `\n\n---\n_executor usage — tokens: prompt ${usage.promptTokens}, completion ${usage.completionTokens}, total ${usage.totalTokens}; iterations ${r.value.iterations}, tool calls ${r.value.toolCallCount}_`
          : `\n\n---\n_executor usage — iterations ${r.value.iterations}, tool calls ${r.value.toolCallCount} (token usage not reported by provider)_`;
        return textResult(answer + footer);
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

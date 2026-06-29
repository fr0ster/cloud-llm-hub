/**
 * Planner/controller MCP surface — a SEPARATE MCP endpoint that exposes exactly
 * ONE tool, `execute_step`, which delegates a single, fully-specified step to the
 * SmartAgent executor and returns its text.
 *
 * The division of labour lives in the tool's description: any MCP client that
 * connects here is told it is the planner/controller and the agent behind the
 * tool is a stateless executor. The full ABAP tool set stays on
 * `/mcp/stream/http`; this is an additive, parallel surface.
 *
 * Stateless by design: each call runs the agent over a single user message with
 * an ephemeral session id, so the executor carries nothing between calls — the
 * controller holds all plan state.
 */

import './env-setup';

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getSmartAgent, runWithRequestConnection } from './agent-manager';
import { resolveExposition } from './lib/exposition';
import {
  establishRequestConnection,
  resetRequestConnection,
} from './lib/request-connection';
import { runWithSessionId } from './request-session';

/**
 * The contract. Read by the connecting MCP client (the planner/controller) the
 * moment it lists tools — this is what makes the role split self-documenting.
 */
const EXECUTE_STEP_DESCRIPTION = [
  'Delegate ONE concrete, fully-specified ABAP/SAP step to the executor agent and return its result.',
  '',
  'Roles. The agent behind this tool is a capable ABAP EXECUTOR: it knows the SAP system well and selects the right MCP tools by analysing your request, but it does NOT plan, keeps NO state between calls, and cannot adjust its behaviour based on earlier results. YOU are the planner and controller.',
  '',
  'How to use:',
  '- Build a plan. Split the goal into steps where each step is clearly described and unambiguously solves ONE concrete task. Call this tool once per step.',
  '- WHICH MCP tools a step needs is NOT your concern — if the step is unambiguous the executor finds the right tools itself. Describe the step’s goal with the exact object names / context it needs, not the tooling.',
  '- After each call ANALYSE the response carefully before the next step. The executor can err or hallucinate. If a request is genuinely impossible to fulfil and no answer can legitimately be returned, then a confident-looking answer is NOT a real answer — it signals an error or a problem, not success. Surface that; do not accept the hallucination.',
  '- CORRECT the plan as you go from what the executor actually returns; do not assume a step succeeded just because text came back.',
  '',
  'Each call is independent — pass everything the step needs here; nothing carries over.',
].join('\n');

export interface AgentMcpResult {
  /** Per-request transport, when the server was created successfully. */
  transport?: StreamableHTTPServerTransport;
  /** Release transport + connection. Call after the request completes. */
  cleanup?: () => Promise<void>;
  /** True when a structured error was already written to `res`. */
  handled: boolean;
}

/**
 * Build the per-request single-tool MCP server for `/mcp/agent/stream/http`.
 * Resolves the SAP connection (same per-request policy as the other channels),
 * acquires the SmartAgent for the requested destination, and registers the one
 * `execute_step` tool. On a credential/destination failure a JSON error is
 * written to `res` and `{ handled: true }` is returned.
 */
export async function createAgentMcpServerForRequest(
  req: Request,
  res: Response,
): Promise<AgentMcpResult> {
  const log = cds.log('agent-mcp');
  const destination = (
    req.headers['x-sap-destination'] as string | undefined
  )?.trim();

  // Same fail-closed per-request connection policy as /v1 and /mcp.
  const established = await establishRequestConnection(req, res, destination);
  if (established.handled) return { handled: true };
  const connection = established.connection;

  let handle: Awaited<ReturnType<typeof getSmartAgent>>;
  try {
    handle = await getSmartAgent(undefined, destination);
  } catch (err) {
    const e = err as Error & { statusCode?: number; code?: string };
    resetRequestConnection(connection);
    res.writeHead(e.statusCode ?? 502, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { type: e.code || 'agent_unavailable', message: e.message },
      }),
    );
    return { handled: true };
  }

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

  server.registerTool(
    'execute_step',
    {
      description: EXECUTE_STEP_DESCRIPTION,
      inputSchema: {
        task: z
          .string()
          .describe(
            'One concrete, fully-specified step for the executor to carry out.',
          ),
      },
    },
    async ({ task }: { task: string }) => {
      // Ephemeral session per call → the executor loads/saves no history.
      const sessionId = `agent-step-${randomUUID()}`;
      const opts = {
        stream: false,
        externalTools: [],
        sessionId,
        ragFilter: {
          namespace: `${userId}:${destination ?? ''}`,
          exposition,
        },
        trace: { traceId: sessionId },
      };

      const r = await runWithSessionId(sessionId, () =>
        connection
          ? runWithRequestConnection(connection, () =>
              handle.agent.process([{ role: 'user', content: task }], opts),
            )
          : handle.agent.process([{ role: 'user', content: task }], opts),
      );

      const text = r.ok
        ? r.value.content || '(no response)'
        : `Error: ${r.error.message}`;

      log.info('execute_step done', { ok: r.ok, destination });
      return { content: [{ type: 'text' as const, text }] };
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
    resetRequestConnection(connection);
  };

  return { transport, cleanup, handled: false };
}

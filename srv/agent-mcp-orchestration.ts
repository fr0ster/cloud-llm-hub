import { getExecutionLimits } from './lib/execution-limits';
import {
  type OrchestrationTool,
  orchestrationDefinitions,
  orchestrationTools,
} from './lib/orchestration-tool-definitions';
import { bindCaller, callOptionsFor } from './lib/rag-caller';
import { getRoleModels } from './lib/role-model-settings';
import { withRoleModels } from './lib/role-models-scope';
import { runWithRequestLlms } from './lib/session-llms';

export {
  type OrchestrationTool,
  orchestrationDefinitions,
  orchestrationTools,
} from './lib/orchestration-tool-definitions';

import { randomUUID } from 'node:crypto';
import type { McpToolResult } from '@mcp-abap-adt/llm-agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import cds from '@sap/cds';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createAgentProfileSource,
  runWithCallerExposition,
} from './agent-manager';
import type { StepCaller } from './agent-mcp';
import { ragTextResult } from './agent-mcp-rag';
import { headlessDialogueFor } from './lib/dialogue-sessions';
import { revisionPlanSchema } from './lib/dialogue-store';
import { leaseSession } from './lib/gatekeeper';
import { longSessions } from './lib/long-session';
import type { LongSessionRequest } from './lib/session-connection';
import { resolveSession } from './lib/session-lifecycle';
import { isRefusal } from './lib/session-retention';
import { requestMeasurement } from './lib/usage/request-records';
import { usageRuntime } from './lib/usage/runtime';
import { runWithSessionId } from './request-session';
import { resolveSessionKey } from './session-id';

const argsSchema = z
  .object({
    session: z.string().optional(),
    destination: z.string().optional(),
  })
  .catchall(z.json());
type Args = z.infer<typeof argsSchema>;

export async function registerOrchestrationTools(
  server: McpServer,
  req: Request,
  caller: StepCaller,
  measure: (
    name: OrchestrationTool,
    run: (args: Args) => Promise<ReturnType<typeof ragTextResult>>,
  ) => (args: Args) => Promise<ReturnType<typeof ragTextResult>>,
) {
  for (const tool of await orchestrationDefinitions(
    createAgentProfileSource(caller.userId),
  )) {
    const name = orchestrationTools.find((name) => name === tool.name);
    if (!name) continue;
    const schema = z.fromJSONSchema(tool.inputSchema);
    if (!(schema instanceof z.ZodObject))
      throw new Error('Orchestration schema must be an object');
    const { properties } = z
      .object({ properties: z.record(z.string(), z.json()) })
      .parse(tool.inputSchema);
    const plan =
      name === 'plan_revise' ? { plan: revisionPlanSchema.optional() } : {};
    const inputSchema = schema
      .extend({
        ...plan,
        session: z.string().optional(),
        destination: z.string().optional(),
      })
      .meta({
        ...tool.inputSchema,
        properties: {
          ...properties,
          ...(name === 'plan_revise'
            ? { plan: z.toJSONSchema(revisionPlanSchema, { io: 'output' }) }
            : {}),
          session: { type: 'string' },
          destination: { type: 'string' },
        },
      });
    server.registerTool(
      name,
      {
        description:
          name === 'plan_revise'
            ? `${tool.description} The current session plan is used; the supplied plan argument is ignored. Context is plain context text.`
            : tool.description,
        inputSchema,
      },
      (args, extra) =>
        measure(name, (input) =>
          executeOrchestrationTool(req, caller, name, input, extra.signal),
        )(argsSchema.parse(args)),
    );
  }
}

export async function executeOrchestrationTool(
  req: Request,
  caller: StepCaller,
  name: OrchestrationTool,
  args: Args,
  signal?: AbortSignal,
) {
  const { session: supplied, destination: requested, ...input } = args;
  const key =
    supplied?.trim() ||
    (req as LongSessionRequest).longSession?.key ||
    resolveSessionKey(req).key;
  if (!key?.trim())
    return ragTextResult(
      'SESSION_REQUIRED: supply the x-clh-session header',
      true,
    );
  try {
    const s = await resolveSession(caller.userId, key);
    if (!s) return ragTextResult('SESSION_NOT_FOUND', true);
    const run = async () => {
      const header = req.headers['x-sap-destination'];
      const destination =
        s.destination ??
        requested ??
        (typeof header === 'string' ? header.trim() : undefined);
      if (!destination) return ragTextResult('ERROR: No destination', true);
      if (s.destination && requested && requested.trim() !== s.destination)
        return ragTextResult(
          'Destination differs from session destination',
          true,
        );
      const trace = {
        traceId: requestMeasurement(req)?.traceId ?? randomUUID(),
      };
      const sessionId = s.key;
      const boundCaller = await bindCaller(
        sessionId,
        caller.userId,
        cds.context?.user?.is('MCP_Admin') === true,
      );
      if (!boundCaller.ok)
        return ragTextResult(boundCaller.error.message, true);
      const usage = usageRuntime()
        ?.forSession({ sessionId, userId: caller.userId, destination })
        .with({ requestId: trace.traceId, traceId: trace.traceId });
      requestMeasurement(req)?.bind(usage, {
        sessionId,
        userId: caller.userId,
        destination,
      });
      return runWithSessionId(
        sessionId,
        () =>
          runWithCallerExposition(caller.exposition, async () => {
            const handle = await headlessDialogueFor(
              req,
              caller.userId,
              s.key,
              destination,
              boundCaller.value,
            );
            const options = {
              signal,
              usage,
              trace,
              ...callOptionsFor(boundCaller.value),
            };
            const result = await handle.session.callTool(
              name,
              name === 'plan_revise'
                ? Object.fromEntries(
                    Object.entries(input).filter(([key]) => key !== 'plan'),
                  )
                : input,
              options,
            );
            return result.ok
              ? ragTextResult(toolText(result.value), result.value.isError)
              : ragTextResult(result.error.message, true);
          }),
        undefined,
        caller.userId,
        {
          admin: cds.context?.user?.is('MCP_Admin') ?? false,
          channel: 'mcp-agent',
        },
      );
    };
    // Do not join the long-session FIFO: that would wait out a WebUI turn and
    // hide the library's busy refusal. The library serializes tools and close;
    // a lifetime hold and retention lease protect the session here.
    const registry = longSessions();
    if (registry.get(caller.userId, s.key) !== s)
      return ragTextResult('SESSION_CLOSED', true);
    const releaseHold = registry.hold(s);
    const lease = leaseSession(caller.userId, s.key, 'rag', {
      presented: true,
    });
    if (isRefusal(lease)) {
      releaseHold();
      return ragTextResult(
        lease.refused === 'closed' ? 'SESSION_CLOSED' : 'SESSION_RETENTION',
        true,
      );
    }
    try {
      return await withRoleModels(
        getRoleModels(caller.userId, s.key),
        () => runWithRequestLlms(s, run),
        getExecutionLimits(caller.userId, s.key),
      );
    } finally {
      lease.release();
      releaseHold();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'refused' in error &&
      (error.refused === 'SESSION_LIMIT' ||
        error.refused === 'SESSION_STORE_UNAVAILABLE')
    )
      return ragTextResult(error.refused, true);
    return ragTextResult(
      error instanceof Error ? error.message : String(error),
      true,
    );
  }
}

function toolText(result: McpToolResult): string {
  if (typeof result.content === 'string') return result.content;
  return Array.isArray(result.content)
    ? result.content
        .map((block) =>
          block.type === 'text' ? (block.text ?? '') : JSON.stringify(block),
        )
        .join('\n')
    : JSON.stringify(result.content);
}

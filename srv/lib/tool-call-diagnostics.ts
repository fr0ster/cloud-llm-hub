import type { InterpretContext } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { z } from 'zod';

type SessionLogger = NonNullable<InterpretContext['sessionLogger']>;
type LogStepData = Parameters<SessionLogger['logStep']>[1];

const log = () => cds.log('tool-calls');

// The library reports each model response's tool calls; content stays out.
const responseDiagnostics = z.object({
  receivedToolCalls: z.array(
    z.object({ id: z.string(), name: z.string(), argumentLength: z.number() }),
  ),
  rejectedToolCalls: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      argumentLength: z.number(),
      reason: z.string(),
    }),
  ),
  executableToolCalls: z.array(z.object({ id: z.string(), name: z.string() })),
  finishReason: z.string().optional(),
});

/** Log received, rejected and executable tool calls of one model response. */
export function logToolCallDiagnostics(
  step: string,
  data: LogStepData,
  context: Record<string, string | undefined>,
): void {
  if (!step.startsWith('llm_response')) return;
  const parsed = responseDiagnostics.safeParse(data);
  if (!parsed.success) return;
  const { receivedToolCalls, rejectedToolCalls, executableToolCalls } =
    parsed.data;
  if (receivedToolCalls.length === 0) return;
  const entry = {
    ...context,
    step,
    finishReason: parsed.data.finishReason,
    received: receivedToolCalls.length,
    rejected: rejectedToolCalls.length,
    executable: executableToolCalls.length,
    rejectedCalls: rejectedToolCalls.map(
      ({ name, reason, argumentLength }) => ({
        name,
        reason,
        argumentLength,
      }),
    ),
  };
  if (rejectedToolCalls.length > 0) log().warn('tool calls rejected', entry);
  else log().info('tool calls', entry);
}

/** Session logger that records only tool-call diagnostics. */
export function toolCallDiagnosticsLogger(
  context: Record<string, string | undefined>,
): SessionLogger {
  return {
    logStep(name, data) {
      logToolCallDiagnostics(name, data, context);
    },
  };
}

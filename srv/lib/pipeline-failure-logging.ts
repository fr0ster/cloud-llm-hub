import type { InterpretContext } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

type LogStep = NonNullable<InterpretContext['sessionLogger']>['logStep'];

export function logRunFailure<T>(
  log: Pick<ReturnType<typeof cds.log>, 'error'>,
  error: T,
  { code, status }: { code: string; status: number },
  traceId?: string,
) {
  let component: string | undefined;
  let stepId: string | undefined;
  let current: object | undefined =
    typeof error === 'object' && error !== null ? error : undefined;
  const seen = new Set<object>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if ('component' in current && typeof current.component === 'string')
      component ??= current.component;
    if ('stepId' in current && typeof current.stepId === 'string')
      stepId ??= current.stepId;
    const cause = 'cause' in current ? current.cause : undefined;
    current = typeof cause === 'object' && cause !== null ? cause : undefined;
  }
  log.error('Agent run failed', {
    code,
    status,
    ...(traceId !== undefined && { traceId }),
    ...(component !== undefined && { component }),
    ...(stepId !== undefined && { stepId }),
  });
}

export function logAdaptiveStepStop(
  code: string,
  stepId: string,
  traceId: string | undefined,
) {
  cds.log('smart-pipeline').error('adaptive_run_stopped', {
    traceId,
    code,
    stepId,
  });
}

export function pipelineFailureLogger(traceId: string | undefined) {
  const log = cds.log('smart-pipeline');
  return {
    logStep(name: Parameters<LogStep>[0], _data: Parameters<LogStep>[1]) {
      if (!name.startsWith('stage_error_')) return false;
      log.error(name, traceId === undefined ? {} : { traceId });
      return true;
    },
  };
}

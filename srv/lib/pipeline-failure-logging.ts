import type { InterpretContext } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  AgentInitializationError,
  failureCauses,
  failureOrigin,
  sanitizeFailure,
} from './llm-failure';

type LogStep = NonNullable<InterpretContext['sessionLogger']>['logStep'];

export function logRunFailure<T>(
  log: Pick<ReturnType<typeof cds.log>, 'error'>,
  error: T,
  failure: { code: string; status: number; message: string },
  traceId?: string,
) {
  if (error instanceof AgentInitializationError) {
    logAgentInitializationFailure(log, error);
    return;
  }
  let component: string | undefined;
  let stepId: string | undefined;
  for (const current of failureCauses(error)) {
    if ('component' in current && typeof current.component === 'string')
      component ??= current.component;
    if ('stepId' in current && typeof current.stepId === 'string')
      stepId ??= current.stepId;
  }
  const origin = failureOrigin(error);
  log.error('Agent run failed', {
    code: failure.code,
    status: failure.status,
    ...((origin === 'domain' || origin === 'hub') && {
      error: failure.message,
    }),
    ...(traceId !== undefined && { traceId }),
    ...(component !== undefined && { component }),
    ...(stepId !== undefined && { stepId }),
  });
}

export function logAgentInitializationFailure(
  log: Pick<ReturnType<typeof cds.log>, 'error'>,
  error: AgentInitializationError,
) {
  const failure = sanitizeFailure(error, error);
  log.error('Destination initialization failed', {
    code: failure.code,
    status: error.status ?? error.statusCode,
    destination: error.destination,
  });
}

export function pipelineFailureLogger(traceId: string) {
  const log = cds.log('smart-pipeline');
  return {
    logStep(name: Parameters<LogStep>[0], data: Parameters<LogStep>[1]) {
      if (name.startsWith('stage_error_')) {
        log.error(name, { traceId });
        return true;
      }
      if (name === 'adaptive_plan') {
        const steps =
          data &&
          typeof data === 'object' &&
          'steps' in data &&
          Array.isArray(data.steps)
            ? data.steps.length
            : undefined;
        log.info(name, { traceId, steps });
        return true;
      }
      if (name === 'adaptive_run') {
        const outcome =
          data &&
          typeof data === 'object' &&
          'outcome' in data &&
          typeof data.outcome === 'string'
            ? data.outcome
            : undefined;
        log.info(name, { traceId, outcome });
        return true;
      }
      if (name === 'adaptive_run_stopped') {
        if (data && typeof data === 'object')
          log.error(name, {
            traceId,
            code:
              'code' in data && typeof data.code === 'string'
                ? data.code
                : undefined,
            stepId:
              'stepId' in data && typeof data.stepId === 'string'
                ? data.stepId
                : undefined,
          });
        return true;
      }
      return false;
    },
  };
}

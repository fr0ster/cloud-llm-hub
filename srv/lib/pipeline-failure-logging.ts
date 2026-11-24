import type { InterpretContext } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

type LogStep = NonNullable<InterpretContext['sessionLogger']>['logStep'];

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

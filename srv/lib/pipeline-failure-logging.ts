import { AsyncLocalStorage } from 'node:async_hooks';
import { httpStatusOf, type InterpretContext } from '@mcp-abap-adt/llm-agent';
import {
  type PipelineContext,
  PipelineExecutor,
} from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';

type LogStep = NonNullable<InterpretContext['sessionLogger']>['logStep'];

function errorLocation<T>(error: T) {
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
  return { component, stepId };
}

export function logRunFailure<T>(
  log: Pick<ReturnType<typeof cds.log>, 'error'>,
  error: T,
  { code, status }: { code: string; status: number },
  traceId?: string,
) {
  const { component, stepId } = errorLocation(error);
  log.error('Agent run failed', {
    code,
    status,
    ...(traceId !== undefined && { traceId }),
    ...(component !== undefined && { component }),
    ...(stepId !== undefined && { stepId }),
  });
}

const activeStageFailure = new AsyncLocalStorage<{
  error?: PipelineContext['error'];
}>();
const activeStep = new AsyncLocalStorage<string | undefined>();

export function withPipelineStep<T>(stepId: string | undefined, run: () => T) {
  return activeStep.run(stepId, run);
}

// llm-agent-libs 38.0.2 yields the typed error immediately before logging its
// string form. Scope the bridge to each executor call, including parallel stages.
const executeStages = PipelineExecutor.prototype.executeStages;
PipelineExecutor.prototype.executeStages = function (stages, context, span) {
  if (!context.options?.sessionLogger)
    return executeStages.call(this, stages, context, span);

  const failure: { error?: PipelineContext['error'] } = {};
  const emit: PipelineContext['yield'] = (chunk) => {
    if (!chunk.ok) {
      failure.error = chunk.error;
      queueMicrotask(() => {
        failure.error = undefined;
      });
    }
    context.yield(chunk);
  };
  const scopedContext = new Proxy(context, {
    get(target, key, receiver) {
      return key === 'yield' ? emit : Reflect.get(target, key, receiver);
    },
  });
  return activeStageFailure.run(failure, () =>
    executeStages.call(this, stages, scopedContext, span),
  );
};

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
      const error = activeStageFailure.getStore()?.error;
      const stepId = errorLocation(error).stepId ?? activeStep.getStore();
      const status = httpStatusOf(error);
      log.error(name, {
        ...(traceId !== undefined && { traceId }),
        ...(error?.code !== undefined && { code: error.code }),
        ...(stepId !== undefined && { stepId }),
        ...(status !== undefined && { status }),
      });
      return true;
    },
  };
}

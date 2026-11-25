import { AsyncLocalStorage } from 'node:async_hooks';
import { httpStatusOf, type InterpretContext } from '@mcp-abap-adt/llm-agent';
import {
  type PipelineContext,
  PipelineExecutor,
} from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';

type LogStep = NonNullable<InterpretContext['sessionLogger']>['logStep'];

function errorObject<T>(error: T) {
  return typeof error === 'object' && error !== null ? error : undefined;
}

function errorLocation<T>(error: T) {
  let component: string | undefined;
  let stepId: string | undefined;
  let current: object | undefined = errorObject(error);
  const seen = new Set<object>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if ('component' in current && typeof current.component === 'string')
      component ??= current.component;
    if ('stepId' in current && typeof current.stepId === 'string')
      stepId ??= current.stepId;
    const cause = 'cause' in current ? current.cause : undefined;
    current = errorObject(cause);
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

type StageFailure = {
  error?: PipelineContext['error'];
  thrown?: object;
  logged: boolean;
};

const activeStageFailure = new AsyncLocalStorage<StageFailure>();
const activeStep = new AsyncLocalStorage<string | undefined>();

export function withPipelineStep<T>(stepId: string | undefined, run: () => T) {
  return activeStep.run(stepId, run);
}

function errorCode(error: object | undefined) {
  return error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function stageFailureDetails(
  data: Parameters<LogStep>[1],
  failure?: StageFailure,
) {
  const payload = errorObject(data);
  const payloadError =
    payload && 'error' in payload ? errorObject(payload.error) : undefined;
  const sources = [failure?.error, payloadError, payload, failure?.thrown];
  const code = sources.map(errorCode).find((value) => value !== undefined);
  const status = sources.map(httpStatusOf).find((value) => value !== undefined);
  const stepId =
    sources
      .map((source) => errorLocation(source).stepId)
      .find((id) => id !== undefined) ?? activeStep.getStore();
  return {
    ...(code !== undefined && { code }),
    ...(stepId !== undefined && { stepId }),
    ...(status !== undefined && { status }),
  };
}

// The executor's catch path stringifies exceptions it does not record on the
// context. Keep the original exception for logging and let the executor handle it.
function observeStageException(
  executor: PipelineExecutor,
  type: string,
  failure: StageFailure,
) {
  // biome-ignore lint/complexity/useLiteralKeys: The executor's handler registry is private.
  const handlers = executor['handlers'];
  const handler = handlers.get(type);
  if (!handler) return executor;

  const scopedHandlers = new Map(handlers).set(type, {
    async execute(...args: Parameters<typeof handler.execute>) {
      try {
        return await handler.execute(...args);
      } catch (error) {
        failure.thrown = errorObject(error);
        throw error;
      }
    },
  });
  return new Proxy(executor, {
    get(target, key, receiver) {
      return key === 'handlers'
        ? scopedHandlers
        : Reflect.get(target, key, receiver);
    },
  });
}

// llm-agent-libs 38.0.2 logs caught exceptions but emits no stage event when a
// handler sets ctx.error and returns false. Track writes in the executing stage
// so a shared context cannot attribute a parallel child's error to a sibling.
const executeStages = PipelineExecutor.prototype.executeStages;
PipelineExecutor.prototype.executeStages = async function (
  stages,
  context,
  span,
) {
  const options = context.options;
  const sessionLogger = options?.sessionLogger;
  if (!sessionLogger) return executeStages.call(this, stages, context, span);

  for (const stage of stages) {
    const failure: StageFailure = { logged: false };
    const event = `stage_error_${stage.id}`;
    const logStep: LogStep = (name, data, area) => {
      if (name === event && activeStageFailure.getStore() === failure) {
        failure.logged = true;
        sessionLogger.logStep(name, stageFailureDetails(data, failure), area);
      } else {
        sessionLogger.logStep(name, data, area);
      }
    };
    const scopedOptions = { ...options, sessionLogger: { logStep } };
    const scopedContext = new Proxy(context, {
      get(target, key, receiver) {
        return key === 'options'
          ? scopedOptions
          : Reflect.get(target, key, receiver);
      },
      set(
        target,
        key,
        value: PipelineContext[keyof PipelineContext],
        receiver: object,
      ) {
        const written = Reflect.set(target, key, value, receiver);
        if (
          written &&
          key === 'error' &&
          activeStageFailure.getStore() === failure
        )
          failure.error = target.error;
        return written;
      },
    });
    const executor = observeStageException(this, stage.type, failure);
    const ok = await activeStageFailure.run(failure, async () => {
      const completed = await executeStages.call(
        executor,
        [stage],
        scopedContext,
        span,
      );
      if (failure.error && !failure.logged) logStep(event, undefined);
      return completed;
    });
    if (!ok) return false;
  }
  return true;
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
    logStep(name: Parameters<LogStep>[0], data: Parameters<LogStep>[1]) {
      if (!name.startsWith('stage_error_')) return false;
      log.error(name, {
        ...(traceId !== undefined && { traceId }),
        ...stageFailureDetails(data),
      });
      return true;
    },
  };
}

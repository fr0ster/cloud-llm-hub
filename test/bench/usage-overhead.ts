import { performance } from 'node:perf_hooks';
import {
  beginEmbeddingRequest,
  type CallOptions,
  type IMcpClient,
  type ISubAgent,
  type IUsageRecorder,
  type LlmResponse,
  type Message,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import {
  DialogueSession,
  PlannerToolsClient,
  SmartAgentBuilder,
  SmartAgentSubAgent,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  createUsageRecorder,
  directTransport,
  memorySink,
} from '@mcp-abap-adt/llm-usage';
import { fakePipelineLlm } from '../unit/helpers/usage-pipeline';

const iterations = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(iterations) || iterations < 1)
  throw new Error('Iterations must be a positive integer');
const answer = (): LlmResponse => ({
  content: 'Completed',
  finishReason: 'stop',
});

// Real dialogue scheduler, planner tools and SmartAgent workers; only transports are fake.
async function scenario(usage?: IUsageRecorder): Promise<void> {
  let releaseTools: () => void = () => {};
  const toolsReady = new Promise<void>((resolve: () => void) => {
    releaseTools = resolve;
  });
  const mcp: IMcpClient = {
    async listTools() {
      return {
        ok: true,
        value: [
          {
            name: 'read',
            description: 'Read',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
    },
    async callTool(name: string, _args: object, options?: CallOptions) {
      await toolsReady;
      options?.usage?.record({
        kind: 'tool.call',
        context: {},
        tool: name,
        dispatched: true,
        embedded: false,
        outcome: 'ok',
        transportOutcome: 'ok',
        toolOutcome: 'ok',
        durationMs: 0,
      });
      return {
        ok: true,
        value: { content: [{ type: 'text', text: 'Tool result' }] },
      };
    },
  };
  const worker = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: {
      classificationEnabled: false,
      ragTranslateEnabled: false,
      maxIterations: 5,
    },
  })
    .withMainLlm(
      fakePipelineLlm((messages: Message[]) =>
        messages.some((message: Message) => message.role === 'tool')
          ? answer()
          : {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [{ id: 'read-call', name: 'read', arguments: {} }],
            },
      ),
    )
    .withMcpClients([mcp])
    .build();
  const workers = new Map<string, ISubAgent>([
    ['executor', new SmartAgentSubAgent('executor', worker.agent)],
    ['checker', new SmartAgentSubAgent('checker', worker.agent)],
  ]);
  let delegated = 0;
  const planner = await new SmartAgentBuilder({
    skipModelValidation: true,
    agent: { classificationEnabled: false, ragTranslateEnabled: false },
  })
    .withMainLlm(
      fakePipelineLlm((messages: Message[], options?: CallOptions) => {
        const last = messages.at(-1);
        if (
          last?.role === 'tool' ||
          last?.content?.includes('[task events]') ||
          delegated >= 3
        )
          return answer();
        const checker = options?.trace?.traceId === 'second';
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: Array.from(
            { length: checker ? 1 : 2 },
            (_value: undefined, index: number) => ({
              id: `delegate-${delegated++}-${index}`,
              name: 'delegate_task',
              arguments: {
                worker: checker ? 'checker' : 'executor',
                goal: 'Read and verify',
                history: 'all',
              },
            }),
          ),
        };
      }),
    )
    .withMcpClients([new PlannerToolsClient()])
    .withMode('hard')
    .build();
  const session = await DialogueSession.open({
    id: 'bench',
    usage,
    planner: planner.agent,
    maxCorrections: 0,
    board: { workers, maxConcurrent: 3 },
  });
  try {
    for (const traceId of ['first', 'second']) {
      const requestUsage = usage?.with({ requestId: traceId, traceId });
      const options: CallOptions = {
        usage: requestUsage?.with({
          role: 'embedding',
          component: 'collection-retrieval',
        }),
      };
      const embedding = beginEmbeddingRequest(
        options,
        startOperation(options),
        {
          provider: 'fake',
          model: 'fake',
          inputs: 1,
          inputChars: 16,
          granularity: 'request',
          retriesVisible: true,
        },
      );
      embedding.end({ outcome: 'ok' });
      requestUsage?.record({
        kind: 'x.hub.retrieval',
        context: {},
        outcome: 'ok',
        values: { collections: 1, chunks: 1, chars: 16, injected: true },
      });
      await session.send('Read and verify\nRetrieved context', {
        usage: requestUsage,
        trace: { traceId },
      });
    }
    // Requests have ended while tasks remain blocked, as in the propagation test.
    releaseTools();
    const deadline = performance.now() + 5000;
    for (;;) {
      const tasks = session.snapshot().tasks;
      if (
        tasks.length === 3 &&
        tasks.every((task: (typeof tasks)[number]) => task.state === 'done')
      )
        break;
      if (performance.now() > deadline)
        throw new Error('Dialogue benchmark tasks did not complete');
      await new Promise<void>((resolve: () => void) => setImmediate(resolve));
    }
  } finally {
    releaseTools();
    await session.close();
  }
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort(
    (left: number, right: number) => left - right,
  );
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function main(): Promise<void> {
  const sink = memorySink({ limit: Math.max(10000, iterations * 100) });
  const recorder = createUsageRecorder({
    transport: directTransport(sink),
    flushMs: 100000,
  });
  const usage = recorder.with({ sessionId: 'bench', userId: 'bench-hash' });
  const off: number[] = [];
  const on: number[] = [];
  const offHeap: number[] = [];
  const onHeap: number[] = [];
  try {
    for (let warmup = 0; warmup < 5; warmup++) {
      await scenario();
      await scenario(usage);
    }
    await recorder.flush(5000);
    const retainedBefore = recorder.stats().delivered;
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let iteration = 0; iteration < iterations; iteration++) {
      // Alternate order to reduce warmup and GC order bias. GC is outside timing.
      for (const enabled of iteration % 2 === 0
        ? [false, true]
        : [true, false]) {
        global.gc?.();
        const heap = process.memoryUsage().heapUsed;
        const started = performance.now();
        await scenario(enabled ? usage : undefined);
        if (enabled) await recorder.flush(5000);
        (enabled ? on : off).push(performance.now() - started);
        (enabled ? onHeap : offHeap).push(
          process.memoryUsage().heapUsed - heap,
        );
      }
    }
    global.gc?.();
    console.log(
      `Iterations per mode: ${iterations}; on includes flush to memory; heap deltas include transient allocations.`,
    );
    for (const enabled of [false, true]) {
      const samples = enabled ? on : off;
      const heaps = enabled ? onHeap : offHeap;
      console.log(
        `${enabled ? 'on ' : 'off'} median=${percentile(samples, 0.5).toFixed(3)} ms p95=${percentile(samples, 0.95).toFixed(3)} ms heap delta median=${Math.round(percentile(heaps, 0.5))} bytes p95=${Math.round(percentile(heaps, 0.95))} bytes`,
      );
    }
    console.log(
      `Retained memory sink: ${recorder.stats().delivered - retainedBefore} records; combined retained heap delta=${process.memoryUsage().heapUsed - heapBefore} bytes`,
    );
  } finally {
    await recorder.close(5000);
  }
}

main().catch((error: Error) => {
  console.error(error);
  process.exitCode = 1;
});

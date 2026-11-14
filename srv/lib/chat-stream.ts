import { randomUUID } from 'node:crypto';
import type { PlannerMessageUsage } from '@mcp-abap-adt/llm-agent';
import {
  AnthropicApiAdapter,
  type ApiRequestContext,
  type LlmStreamChunk,
  type OrchestratorError,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { Response } from 'express';
import { detachedSink } from './detached-sink';
import {
  type DialogueStreamChunk,
  type dialogueChat,
  failDialogueResponse,
} from './dialogue-chat';
import { type LongSession, longSessions } from './long-session';
import { summarizeToolResult } from './tool-result-summary';
import { responseMeasurement } from './usage/request-records';
import {
  dialogueUsageToWire,
  sumPlannerUsage,
  tokenUsageToWire,
} from './usage-wire';

/** One response owns its heartbeat, error and terminal, including queue waits. */
export function chatStream(
  res: Response,
  protocol: 'openai' | 'anthropic',
  session?: LongSession,
) {
  const toolResults =
    res.req?.headers['x-clh-tool-results']?.toString().toLowerCase() ===
    'summary';
  const createdAt = Date.now();
  const out = detachedSink(res);
  const controller = new AbortController();
  let opened = false;
  let ended = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
  };
  res.on('close', () => {
    stop();
    if (!res.writableEnded) {
      out.detach();
      controller.abort();
    }
  });
  res.on('finish', stop);
  return {
    createdAt,
    toolResults,
    measurement: responseMeasurement(res),
    signal: controller.signal,
    get opened() {
      return opened;
    },
    ensureStream(headers: Record<string, string> = {}) {
      if (opened || ended) return;
      opened = true;
      out.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        ...headers,
      });
      const beat = () => {
        out.write(': keep-alive\n\n');
        if (session) longSessions().touch(session.userId, session.key);
      };
      beat();
      timer = setInterval(beat, 10_000);
      timer.unref?.();
    },
    error(body: unknown) {
      if (ended) return;
      ended = true;
      stop();
      responseMeasurement(res)?.end('error');
      // A failed response must never count as an ended outbox delivery.
      failDialogueResponse(res);
      out.write(
        `${protocol === 'anthropic' ? 'event: error\n' : ''}data: ${JSON.stringify(body)}\n\n`,
      );
      out.end();
    },
    end() {
      if (!ended) {
        ended = true;
        stop();
        out.end();
      }
    },
    out,
  };
}

export type ChatStream = ReturnType<typeof chatStream>;

/** Feed turn and follow through one encoder; only the turn holds admission. */
export async function streamDialogue(opts: {
  stream: ChatStream;
  protocol: 'openai' | 'anthropic';
  model: string | (() => string);
  context?: ApiRequestContext;
  agent: ReturnType<typeof dialogueChat>;
  source: AsyncIterable<Result<DialogueStreamChunk, OrchestratorError>>;
  run: (fn: () => Promise<void>) => Promise<void>;
  maxMs: number;
  onError: (error: unknown) => unknown;
  onTurnEnd?: (text: string, following: boolean) => void;
  onEnd?: (text: string) => void;
}): Promise<() => Promise<void>> {
  const { stream, protocol } = opts;
  type Chunk = Result<LlmStreamChunk, OrchestratorError>;
  const queue: Array<{ chunk: Chunk; written(): void }> = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let failure: unknown;
  let text = '';
  let explicitMessages = false;
  let terminalSucceeded = false;
  const deliveredUsage: Array<PlannerMessageUsage | undefined> = [];
  const addDeliveredUsage = (usage: PlannerMessageUsage | undefined) => {
    if (!usage) return;
    const deliveredTasks = new Set(
      deliveredUsage.flatMap(
        (value) => value?.tasks?.map((task) => task.id) ?? [],
      ),
    );
    deliveredUsage.push({
      ...usage,
      tasks: usage.tasks?.filter((task) => !deliveredTasks.has(task.id)),
    });
  };
  let ready!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let model: string | undefined;
  const responseModel = () =>
    (model ??= typeof opts.model === 'function' ? opts.model() : opts.model);
  const push = (chunk: Chunk) =>
    new Promise<void>((written) => {
      queue.push({ chunk, written });
      ready();
      wake?.();
    });
  const source = (async function* () {
    while (true) {
      if (queue.length) {
        const item = queue.shift();
        if (!item) continue;
        yield item.chunk;
        item.written();
      } else if (closed) {
        if (failure) throw failure;
        return;
      } else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  })();
  const id = `chatcmpl-${randomUUID()}`;
  const base = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    get model() {
      return responseModel();
    },
  };
  const delta = (content: string, finish_reason: string | null = null) =>
    stream.out.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: finish_reason ? {} : { role: 'assistant', content }, finish_reason }] })}\n\n`,
    );
  let usage: LlmStreamChunk['usage'];
  const consuming = (async () => {
    try {
      await firstChunk;
      if (protocol === 'anthropic') {
        if (!opts.context) throw new Error('Missing Anthropic request context');
        opts.context.protocol.model = responseModel();
        for await (const event of new AnthropicApiAdapter().transformStream(
          source,
          opts.context,
        )) {
          const usage =
            event.event === 'message_delta'
              ? sumPlannerUsage(deliveredUsage, {
                  durationMs: Date.now() - stream.createdAt,
                })
              : undefined;
          if (usage) {
            stream.out.write(
              `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens, x_hub: usage.x_hub } })}\n\n`,
            );
          } else {
            if (event.event === 'message_stop')
              terminalSucceeded =
                !failure && !stream.signal.aborted && !stream.out.detached;
            stream.out.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
          }
        }
      } else {
        for await (const chunk of source) {
          if (!chunk.ok) throw chunk.error;
          if (chunk.value.content) delta(chunk.value.content);
          if (chunk.value.usage) usage = chunk.value.usage;
        }
        delta('', 'stop');
        const wireUsage =
          dialogueUsageToWire(
            sumPlannerUsage(deliveredUsage, {
              durationMs: Date.now() - stream.createdAt,
            }),
          ) ?? tokenUsageToWire(usage);
        if (wireUsage)
          stream.out.write(
            `data: ${JSON.stringify({ ...base, choices: [], usage: wireUsage })}\n\n`,
          );
        terminalSucceeded =
          !failure && !stream.signal.aborted && !stream.out.detached;
        stream.out.write('data: [DONE]\n\n');
      }
    } catch (error) {
      terminalSucceeded = false;
      // Spend survives a failed turn. Emit it before the error closes the socket.
      const total = sumPlannerUsage(deliveredUsage, {
        durationMs: Date.now() - stream.createdAt,
      });
      const wire = dialogueUsageToWire(total) ?? tokenUsageToWire(usage);
      if (wire) {
        if (protocol === 'anthropic')
          stream.out.write(
            `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: { input_tokens: wire.prompt_tokens, output_tokens: wire.completion_tokens, ...(total ? { x_hub: total.x_hub } : {}) } })}\n\n`,
          );
        else
          stream.out.write(
            `data: ${JSON.stringify({ ...base, choices: [], usage: wire })}\n\n`,
          );
      }
      stream.error(opts.onError(error));
    }
  })();
  const content = async (value: string) => {
    text += value;
    await push({ ok: true, value: { content: value } });
  };
  const comment = (name: string, value?: string) =>
    stream.out.write(`: ${name}${value ? ` ${value}` : ''}\n\n`);
  try {
    await opts.run(async () => {
      for await (const chunk of opts.source) {
        if (!chunk.ok) throw chunk.error;
        const v = chunk.value;
        if (v.clhUsage) addDeliveredUsage(v.clhUsage);
        if (v.clhActivity)
          comment(v.clhActivity.kind, JSON.stringify(v.clhActivity));
        else if (v.clhToolResult) {
          if (stream.toolResults)
            comment(
              'tool-result',
              JSON.stringify(summarizeToolResult(v.clhToolResult)),
            );
          if (!stream.out.detached && !stream.signal.aborted)
            v.clhToolResultWritten?.();
        } else if (v.clhMessageId) comment('message-id', v.clhMessageId);
        else if (v.clhMessageEnd) {
          if (stream.measurement) explicitMessages = true;
          comment('message-end', v.clhMessageEnd);
          if (!stream.out.detached) stream.measurement?.messageDelivered();
        } else if (v.clhTurnEnd) comment('turn-end');
        else if (v.status) comment('status', JSON.stringify(v.status));
        else {
          text += v.content || '';
          const { finishReason: _finishReason, ...value } = v;
          await push({ ok: true, value });
        }
      }
      if (
        stream.measurement &&
        !explicitMessages &&
        /\S/.test(text) &&
        !stream.out.detached
      )
        stream.measurement?.messageDelivered();
      stream.measurement?.turnEnded();
      if (!stream.signal.aborted)
        opts.onTurnEnd?.(text, opts.agent.hasFollow());
    });
  } catch (error) {
    failure = error;
  }
  return async () => {
    try {
      if (failure) throw failure;
      const follow = opts.agent.follow(stream.signal, opts.maxMs);
      if (follow)
        for await (const item of follow) {
          if (item.kind === 'message') {
            addDeliveredUsage(item.message.usage);
            if (text) await content('\n\n');
            comment('message-id', item.message.id);
            await content(item.message.text);
            comment('message-end', item.message.id);
            if (!stream.out.detached && !stream.signal.aborted) {
              item.written();
              stream.measurement?.messageDelivered();
            }
          } else if (item.kind === 'activity' || item.kind === 'turn') {
            comment(item.kind, JSON.stringify(item));
          } else if (item.kind === 'tool-result') {
            if (stream.toolResults)
              comment(
                'tool-result',
                JSON.stringify(summarizeToolResult(item.record)),
              );
            if (!stream.out.detached && !stream.signal.aborted)
              item.written?.();
          } else if (item.kind === 'end') {
            stream.measurement?.end(item.reason);
            if (item.reason === 'error') {
              addDeliveredUsage(item.usage);
              throw new Error(
                item.cause
                  ? `Background planner turn failed: ${item.cause}`
                  : 'Background planner turn failed',
              );
            } else if (item.note)
              await content(`${text ? '\n\n' : ''}${item.note}`);
          }
        }
    } catch (error) {
      failure = error;
    }
    closed = true;
    ready();
    wake?.();
    await consuming;
    if (terminalSucceeded) opts.onEnd?.(text);
    stream.end();
  };
}

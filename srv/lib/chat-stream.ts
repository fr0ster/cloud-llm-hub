import { randomUUID } from 'node:crypto';
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

/** One response owns its heartbeat, error and terminal, including queue waits. */
export function chatStream(
  res: Response,
  protocol: 'openai' | 'anthropic',
  session?: LongSession,
) {
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
  model: string;
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
  const push = (chunk: Chunk) =>
    new Promise<void>((written) => {
      queue.push({ chunk, written });
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
    model: opts.model,
  };
  const delta = (content: string, finish_reason: string | null = null) =>
    stream.out.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: finish_reason ? {} : { role: 'assistant', content }, finish_reason }] })}\n\n`,
    );
  const consuming = (async () => {
    try {
      if (protocol === 'anthropic') {
        if (!opts.context) throw new Error('Missing Anthropic request context');
        for await (const event of new AnthropicApiAdapter().transformStream(
          source,
          opts.context,
        ))
          stream.out.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
      } else {
        let usage: LlmStreamChunk['usage'];
        for await (const chunk of source) {
          if (!chunk.ok) throw chunk.error;
          if (chunk.value.content) delta(chunk.value.content);
          if (chunk.value.usage) usage = chunk.value.usage;
        }
        delta('', 'stop');
        if (usage)
          stream.out.write(
            `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens } })}\n\n`,
          );
        stream.out.write('data: [DONE]\n\n');
      }
    } catch (error) {
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
        if (v.clhMessageId) comment('message-id', v.clhMessageId);
        else if (v.clhMessageEnd) comment('message-end', v.clhMessageEnd);
        else if (v.clhTurnEnd) comment('turn-end');
        else if (v.status) comment('status', JSON.stringify(v.status));
        else {
          text += v.content || '';
          const { finishReason: _finishReason, ...value } = v;
          await push({ ok: true, value });
        }
      }
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
            if (text) await content('\n\n');
            comment('message-id', item.message.id);
            await content(item.message.text);
            comment('message-end', item.message.id);
            if (!stream.out.detached && !stream.signal.aborted) item.written();
          } else if (item.reason === 'error') {
            throw new Error('Background planner turn failed');
          } else if (item.note)
            await content(`${text ? '\n\n' : ''}${item.note}`);
        }
    } catch (error) {
      failure = error;
    }
    closed = true;
    wake?.();
    await consuming;
    opts.onEnd?.(text);
    stream.end();
  };
}

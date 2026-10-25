import { randomUUID } from 'node:crypto';
import type {
  AgentCallOptions,
  LlmStreamChunk,
  Message,
  OrchestratorError,
  Result,
  SmartAgentResponse,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { setSessionDestination } from '../agent-manager';
import { dialogueFor } from './dialogue-sessions';
import type { LongSession } from './long-session';
import { NoMessageFilter, stripNoMessage } from './no-message';
import { ragContextOf, userTextOf } from './rag-context-marker';
import { extractText } from './session-turns';

/** Adapt planner turns to the existing chat response/error and history paths. */
export function dialogueChat(
  req: Request,
  userId: string,
  session: LongSession,
  destination: string,
  response: Response,
): {
  process(
    messages: Message[],
    opts?: AgentCallOptions,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>>;
  streamProcess(
    messages: Message[],
    opts?: AgentCallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>;
} {
  let disconnected = response.destroyed && !response.writableFinished;
  response.on('close', () => {
    disconnected = true;
  });
  const open = async () => {
    const handle = await dialogueFor(userId, session.key, destination);
    await handle.factory.refresh(
      { headers: req.headers, user: cds.context?.user },
      destination,
    );
    setSessionDestination(userId, session.key, destination);
    await handle.drainPending();
    const messages = handle.hasSubscribers() ? [] : handle.outbox.pending();
    const pending = messages.map((m) => `**Planner:** ${m.text}`).join('\n\n');
    let successful = false;
    response.on('finish', () => {
      if (successful && !disconnected && messages.length)
        void handle.outbox
          .confirmUpTo(messages[messages.length - 1].id)
          .catch(() => {});
    });
    return {
      handle,
      prefix: pending ? `${pending}\n\n` : '',
      complete: () => {
        successful = true;
      },
    };
  };

  return {
    async process(messages, opts) {
      try {
        const { handle, prefix, complete } = await open();
        const message = messages.filter((m) => m.role === 'user').at(-1);
        const trace = {
          ...opts?.trace,
          traceId: opts?.trace?.traceId ?? randomUUID(),
        };
        const context = message && ragContextOf(message);
        if (context) handle.retrievedContexts.set(trace, context);
        const answer = await handle.session
          .send(userText(message), {
            signal: opts?.signal,
            trace,
          })
          .finally(() => handle.retrievedContexts.delete(trace))
          .finally(() => handle.drainPending());
        complete();
        return {
          ok: true,
          value: {
            content: prefix + stripNoMessage(answer.text),
            stopReason: 'stop',
            iterations: 0,
            toolCallCount: 0,
          },
        };
      } catch (error) {
        return { ok: false, error: plannerError(error) };
      }
    },
    async *streamProcess(messages, opts) {
      const { handle, prefix, complete } = await open();
      if (prefix) yield { ok: true, value: { content: prefix } };
      // Callback deltas must reach the socket while send is still running.
      const queue: Array<Result<{ content: string }, OrchestratorError>> = [];
      let wake: (() => void) | undefined;
      let finished = false;
      let receivedPartial = false;
      const filter = new NoMessageFilter();
      let failure: OrchestratorError | undefined;
      const push = (chunk: Result<{ content: string }, OrchestratorError>) => {
        queue.push(chunk);
        wake?.();
      };
      const message = messages.filter((m) => m.role === 'user').at(-1);
      const trace = {
        ...opts?.trace,
        traceId: opts?.trace?.traceId ?? randomUUID(),
      };
      const context = message && ragContextOf(message);
      if (context) handle.retrievedContexts.set(trace, context);
      const sending = handle.session
        .send(userText(message), {
          signal: opts?.signal,
          trace,
          onPartial(chunk) {
            if (chunk.kind === 'content') {
              if (!chunk.delta) return;
              receivedPartial = true;
              const content = filter.push(chunk.delta);
              if (content) push({ ok: true, value: { content } });
            }
          },
        })
        .finally(() => handle.retrievedContexts.delete(trace))
        .then(
          (answer) => {
            const content = receivedPartial
              ? filter.finish()
              : stripNoMessage(answer.text);
            if (content) push({ ok: true, value: { content } });
          },
          (error) => {
            failure = plannerError(error);
          },
        )
        .finally(() => {
          finished = true;
          wake?.();
        });
      while (!finished || queue.length) {
        if (queue.length) {
          const chunk = queue.shift();
          if (chunk) yield chunk;
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      await sending;
      await handle.drainPending();
      if (failure) throw failure;
      complete();
      yield { ok: true, value: { content: '', finishReason: 'stop' } };
    },
  };
}

function plannerError(error: unknown): OrchestratorError {
  const cause = error instanceof Error ? error : new Error(String(error));
  return Object.assign(cause, {
    code: (cause as { code?: string }).code ?? 'PLANNER_ERROR',
  });
}

function userText(message: Message | undefined): string {
  if (!message) return '';
  return typeof message.content === 'string' || message.content === null
    ? userTextOf(message as { content: string | null })
    : extractText(message.content);
}

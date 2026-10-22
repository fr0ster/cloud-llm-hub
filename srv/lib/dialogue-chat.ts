import type {
  AgentCallOptions,
  LlmStreamChunk,
  Message,
  OrchestratorError,
  Result,
  SmartAgentResponse,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { Request } from 'express';
import { setSessionDestination } from '../agent-manager';
import { dialogueFor } from './dialogue-sessions';
import type { LongSession } from './long-session';

/** Adapt planner turns to the existing chat response/error and history paths. */
export function dialogueChat(
  req: Request,
  userId: string,
  session: LongSession,
  destination: string,
  lastUserText: string,
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
  const open = async () => {
    const handle = await dialogueFor(userId, session.key, destination);
    handle.factory.refresh(
      { headers: req.headers, user: cds.context?.user },
      destination,
    );
    session.destination = destination;
    setSessionDestination(userId, session.key, destination);
    const pending = handle.session
      .takePending()
      .map((m) => `**Planner:** ${m.text}`)
      .join('\n\n');
    return { handle, prefix: pending ? `${pending}\n\n` : '' };
  };

  return {
    async process(_messages, opts) {
      try {
        const { handle, prefix } = await open();
        const answer = await handle.session.send(lastUserText, {
          signal: opts?.signal,
          trace: opts?.trace,
        });
        return {
          ok: true,
          value: {
            content: prefix + answer.text,
            stopReason: 'stop',
            iterations: 0,
            toolCallCount: 0,
          },
        };
      } catch (error) {
        return { ok: false, error: plannerError(error) };
      }
    },
    async *streamProcess(_messages, opts) {
      const { handle, prefix } = await open();
      if (prefix) yield { ok: true, value: { content: prefix } };
      // Callback deltas must reach the socket while send is still running.
      const queue: Array<Result<{ content: string }, OrchestratorError>> = [];
      let wake: (() => void) | undefined;
      let finished = false;
      let streamed = '';
      let failure: OrchestratorError | undefined;
      const push = (chunk: Result<{ content: string }, OrchestratorError>) => {
        queue.push(chunk);
        wake?.();
      };
      const sending = handle.session
        .send(lastUserText, {
          signal: opts?.signal,
          trace: opts?.trace,
          onPartial(chunk) {
            if (chunk.kind === 'content') {
              streamed += chunk.delta;
              push({ ok: true, value: { content: chunk.delta } });
            }
          },
        })
        .then(
          (answer) => {
            if (!streamed) push({ ok: true, value: { content: answer.text } });
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
      if (failure) throw failure;
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

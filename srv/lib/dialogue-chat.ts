import { randomUUID } from 'node:crypto';
import type {
  AgentCallOptions,
  LlmStreamChunk,
  Message,
  OrchestratorError,
  PlannerMessageUsage,
  Result,
  SmartAgentResponse,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { setSessionDestination } from '../agent-manager';
import { dialogueAttachments } from './dialogue-attachments';
import {
  type FollowItem,
  followDialogue,
  supersedeFollow,
} from './dialogue-follow';
import type { Delivery } from './dialogue-outbox';
import {
  type DialogueHandle,
  dialogueFor,
  type PlannerCounts,
} from './dialogue-sessions';
import type { LongSession } from './long-session';
import { NoMessageFilter, stripNoMessage } from './no-message';
import { userTextOf } from './rag-context-marker';
import { extractText } from './session-turns';
import { responseMeasurement } from './usage/request-records';
import { type DialogueUsage, sumPlannerUsage } from './usage-wire';

function plannerObservers(handle: DialogueHandle) {
  let counts: PlannerCounts = {};
  handle.plannerCounts(counts);
  return {
    onToolCallCount(count: number, max?: number) {
      counts = { ...counts, toolCalls: count, maxToolCalls: max };
      handle.plannerCounts(counts);
    },
    onToolsSelected(selected: number, available: number) {
      counts = {
        ...counts,
        toolsSelected: selected,
        toolsAvailable: available,
      };
      handle.plannerCounts(counts);
    },
  };
}

export type DialogueStreamChunk = LlmStreamChunk & {
  clhUsage?: PlannerMessageUsage;
  clhMessageId?: string;
  clhMessageEnd?: string;
  clhTurnEnd?: true;
};

const failedResponses = new WeakSet<Response>();

/** SSE failures keep HTTP 200 but do not confirm an outbox delivery. */
export function failDialogueResponse(response: Response): void {
  failedResponses.add(response);
}

/** Adapt planner turns to the existing chat response/error and history paths. */
export function dialogueChat(
  req: Request,
  userId: string,
  session: LongSession,
  destination: string,
  response: Response,
  attachmentRequest: Pick<Request, 'headers' | 'body'> = req,
): {
  process(
    messages: Message[],
    opts?: AgentCallOptions,
  ): Promise<
    Result<SmartAgentResponse & { usage?: DialogueUsage }, OrchestratorError>
  >;
  streamProcess(
    messages: Message[],
    opts?: AgentCallOptions,
  ): AsyncIterable<Result<DialogueStreamChunk, OrchestratorError>>;
  follow(
    signal: AbortSignal,
    maxMs: number,
  ): AsyncIterable<FollowItem> | undefined;
  hasFollow(): boolean;
} {
  const requestStartedAt = Date.now();
  let followHandle: Awaited<ReturnType<typeof dialogueFor>> | undefined;
  let delivery: Delivery;
  let since: number;
  let resolveResponseEnded!: () => void;
  const responseEnded = new Promise<void>((resolve) => {
    resolveResponseEnded = resolve;
  });
  let disconnected = response.destroyed && !response.writableFinished;
  response.on('close', () => {
    if (!response.writableFinished) disconnected = true;
    resolveResponseEnded();
  });
  const open = async () => {
    const handle = await dialogueFor(userId, session.key, destination);
    await supersedeFollow(handle);
    const ack = req.headers['x-clh-ack'];
    if (typeof ack === 'string') {
      await handle.outbox.enterAckMode();
      if (ack !== 'none') await handle.outbox.confirmUpTo(ack);
    } else await handle.outbox.confirmByArrival();
    since = handle.state().settledSeq;
    delivery = handle.outbox.beginDelivery();
    const pending = handle.outbox.pending();
    await handle.factory.refresh(
      { headers: req.headers, user: cds.context?.user },
      destination,
    );
    setSessionDestination(userId, session.key, destination);
    await handle.drainPending();
    let successful = false;
    response.on('finish', () => {
      if (
        successful &&
        !disconnected &&
        !failedResponses.has(response) &&
        response.statusCode < 400
      )
        delivery.ended();
      resolveResponseEnded();
    });
    return {
      handle,
      pending,
      complete: () => {
        successful = true;
      },
    };
  };

  return {
    hasFollow: () => followHandle !== undefined,
    follow(signal, maxMs) {
      return followHandle
        ? followDialogue(followHandle, {
            delivery,
            responseEnded,
            since,
            signal,
            maxMs,
          })
        : undefined;
    },
    async process(messages: Message[], opts: AgentCallOptions | undefined) {
      try {
        const { handle, pending, complete } = await open();
        const message = messages.filter((m) => m.role === 'user').at(-1);
        const trace = {
          ...opts?.trace,
          traceId: opts?.trace?.traceId ?? randomUUID(),
        };
        const context = await dialogueAttachments(
          attachmentRequest,
          userId,
          session.key,
        );
        if (context) handle.attachments.set(trace, context);
        const replyId = randomUUID();
        const createdAt = Date.now();
        handle.replies.set(trace, { id: replyId, createdAt });
        const answer = await handle.session
          .send(userText(message), {
            ...plannerObservers(handle),
            ...(handle.usage
              ? {
                  usage: handle.usage.with({
                    requestId: trace.traceId,
                    traceId: trace.traceId,
                  }),
                }
              : {}),
            signal: opts?.signal,
            trace,
          })
          .finally(() => {
            handle.attachments.delete(trace);
            handle.replies.delete(trace);
          })
          .finally(() => handle.drainPending());
        const text = stripNoMessage(answer.text);
        const carried = [...pending];
        if (text.trim()) {
          const reply = {
            id: replyId,
            text,
            createdAt,
            trigger: 'user' as const,
            usage: answer.usage,
          };
          await handle.outbox.upsert([reply]);
          carried.push(reply);
        }
        responseMeasurement(response)?.expectMessages(carried.length);
        for (const message of carried) delivery.carried(message.id);
        const lastId = carried.at(-1)?.id;
        if (lastId) response.setHeader('x-clh-last-message', lastId);
        complete();
        return {
          ok: true,
          value: {
            content: carried.map((m) => m.text).join('\n\n'),
            usage: sumPlannerUsage(
              carried.map((m) => m.usage),
              { durationMs: Date.now() - requestStartedAt },
            ),
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
      const { handle, pending, complete } = await open();
      let hasContent = false;
      let replyUsage: PlannerMessageUsage | undefined;
      for (const message of pending) {
        if (!message.text.trim()) continue;
        if (hasContent) yield { ok: true, value: { content: '\n\n' } };
        hasContent = true;
        yield { ok: true, value: { content: '', clhMessageId: message.id } };
        yield { ok: true, value: { content: message.text } };
        delivery.carried(message.id);
        yield {
          ok: true,
          value: {
            content: '',
            clhMessageEnd: message.id,
            clhUsage: message.usage,
          },
        };
      }
      const replyId = randomUUID();
      const createdAt = Date.now();
      let text = '';
      let replyStarted = false;
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
      const context = await dialogueAttachments(
        attachmentRequest,
        userId,
        session.key,
      );
      if (context) handle.attachments.set(trace, context);
      handle.replies.set(trace, { id: replyId, createdAt });
      const sending = handle.session
        .send(userText(message), {
          ...plannerObservers(handle),
          ...(handle.usage
            ? {
                usage: handle.usage.with({
                  requestId: trace.traceId,
                  traceId: trace.traceId,
                }),
              }
            : {}),
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
        .finally(() => {
          handle.attachments.delete(trace);
          handle.replies.delete(trace);
        })
        .then(
          (answer) => {
            replyUsage = answer.usage;
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
          if (chunk) {
            if (chunk.ok && chunk.value.content) {
              text += chunk.value.content;
              if (!replyStarted) {
                if (!text.trim()) continue;
                replyStarted = true;
                if (hasContent) yield { ok: true, value: { content: '\n\n' } };
                yield {
                  ok: true,
                  value: { content: '', clhMessageId: replyId },
                };
                chunk.value.content = text;
              }
            }
            yield chunk;
          }
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      await sending;
      await handle.drainPending();
      if (failure) throw failure;
      if (text.trim()) {
        await handle.outbox.upsert([
          { id: replyId, text, createdAt, trigger: 'user', usage: replyUsage },
        ]);
        delivery.carried(replyId);
      }
      if (replyStarted)
        yield {
          ok: true,
          value: { content: '', clhMessageEnd: replyId, clhUsage: replyUsage },
        };
      yield { ok: true, value: { content: '', clhTurnEnd: true } };
      if (handle.state().status) followHandle = handle;
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

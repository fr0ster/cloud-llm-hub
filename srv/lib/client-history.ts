import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { IRag, LlmStreamChunk, Message } from '@mcp-abap-adt/llm-agent';
import type { IStageHandler } from '@mcp-abap-adt/llm-agent-libs';
import { BuildValidationError } from './build-validation-error';

export type ClientHistory = 'off' | 'on';

/** The hub's legacy zero value means an unbounded client history window. */
export function clientHistoryWindow(
  policy: ClientHistory | undefined,
  window: number | undefined,
): number | undefined {
  return policy === 'on' && window ? window : undefined;
}

function lastUserIndex(messages: Message[]): number {
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== 'user') index--;
  return index;
}

export function clientToolResultIds(messages: Message[]): string[] {
  const lastUser = lastUserIndex(messages);
  if (lastUser < 0) return [];
  return messages
    .slice(lastUser + 1)
    .flatMap((message) =>
      message.role === 'tool' && message.tool_call_id
        ? [message.tool_call_id]
        : [],
    );
}

/** Standalone requests get distinct IDs. Without a binding, the first echoed
 * round anchors the ID for the rest of a client-managed tool loop. */
export function clientHistoryTurnId(
  messages: Message[],
  issuedCalls?: ReadonlyMap<string, string>,
): string | undefined {
  const lastUser = lastUserIndex(messages);
  if (lastUser < 0) return undefined;
  const results = clientToolResultIds(messages);
  for (const callId of results) {
    const turnId = issuedCalls?.get(callId);
    if (turnId) return turnId;
  }
  if (!results.length) return `client:${randomUUID()}`;
  const resultIds = new Set(results);
  for (const message of messages.slice(lastUser + 1)) {
    const calls = message.role === 'assistant' ? message.tool_calls : undefined;
    if (calls?.some((call) => resultIds.has(call.id)))
      return clientIdFromCall(calls[0].id);
  }
  return clientIdFromCall(results[0]);
}

function clientIdFromCall(callId: string): string {
  return `client:${createHash('sha256').update(callId).digest('hex')}`;
}

export function hasPendingClientTools(response: {
  toolCalls?:
    | Readonly<NonNullable<LlmStreamChunk['toolCalls']>>
    | Message['tool_calls'];
  finishReason?: string;
  stopReason?: string;
}): boolean {
  return (
    !!response.toolCalls?.length ||
    [response.finishReason, response.stopReason].some(
      (reason) => reason === 'tool_calls' || reason === 'tool_use',
    )
  );
}

/** Explicit read barrier also prevents the builder from auto-creating a history store. */
export const consumerHistoryRag: IRag = {
  query: async () => ({ ok: true, value: [] }),
  getById: async () => ({ ok: true, value: null }),
  healthCheck: async () => ({ ok: true, value: undefined }),
};

const coordinatorContext = new AsyncLocalStorage<Message[]>();

/** Adaptive planning bypasses assembledMessages and clips serialized history. */
export function withCoordinatorContext<T extends IStageHandler>(handler: T): T {
  const execute: IStageHandler['execute'] = (context, config, span) =>
    coordinatorContext.run(
      context.assembledMessages.filter((message) => message.role !== 'system'),
      () => handler.execute(context, config, span),
    );
  return new Proxy(handler, {
    get(target, property) {
      if (property === 'execute') return execute;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Deliver the assembled turn and complete retrieved records as actual messages. */
export function coordinatorContextMessages(messages: Message[]): Message[] {
  const context = coordinatorContext.getStore();
  if (!context?.length) return messages;
  return [
    ...messages.filter((message) => message.role === 'system'),
    ...context,
    ...messages.filter((message) => message.role !== 'system'),
  ];
}

export function configuredClientHistory(
  env: NodeJS.ProcessEnv = process.env,
): ClientHistory {
  const raw = env.LLM_AGENT_CLIENT_HISTORY;
  if (raw === undefined || raw.trim() === '') return 'off';
  const value = raw.trim();
  if (value === 'off' || value === 'on') return value;
  throw new BuildValidationError(
    `Invalid LLM_AGENT_CLIENT_HISTORY: expected off or on, got ${JSON.stringify(raw)}`,
  );
}

/** Filter once at client ingress, before the hub adds any internal user messages.
 * Keep system messages for client adapter detection; the assembler excludes them. */
export function clientHistoryMessages(
  messages: Message[],
  policy: ClientHistory = 'off',
): Message[] {
  if (policy === 'on') return messages;
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== 'user') start--;
  return messages.filter(
    (message, index) =>
      message.role === 'system' || (start >= 0 && index >= start),
  );
}

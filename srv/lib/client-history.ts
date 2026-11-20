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

/** A fresh request gets its own ID. A continuation names calls from the same
 * turn, even if the client dropped earlier messages or prior tool rounds. */
export function clientHistoryTurnId(
  messages: Message[],
  issuedCalls?: ReadonlyMap<string, string>,
): string | undefined {
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
  if (lastUser < 0) return undefined;
  const calls = new Set<string>();
  let firstResult: string | undefined;
  for (const message of messages.slice(lastUser + 1)) {
    for (const call of message.tool_calls ?? []) calls.add(call.id);
    if (message.role !== 'tool' || !message.tool_call_id) continue;
    const callId = message.tool_call_id;
    const turnId = issuedCalls?.get(callId);
    if (turnId) return turnId;
    if (calls.has(callId)) firstResult ??= callId;
  }
  // An echoed call can still identify a continuation after an in-process
  // session window expires or when the tool loop began outside this process.
  return `client:${firstResult === undefined ? randomUUID() : createHash('sha256').update(firstResult).digest('hex')}`;
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

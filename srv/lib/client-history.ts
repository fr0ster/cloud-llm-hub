import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { IRag, Message } from '@mcp-abap-adt/llm-agent';
import type { IStageHandler } from '@mcp-abap-adt/llm-agent-libs';
import { BuildValidationError } from './build-validation-error';

export type ClientHistory = 'off' | 'on';

/** Tool-result continuations retain the same user boundary. Include the prefix
 * so a later user message with identical text is still a different turn.
 * Compute before applying the client history policy. */
export function clientHistoryTurnId(messages: Message[]): string | undefined {
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
  if (lastUser < 0) return undefined;
  return `client:${createHash('sha256')
    .update(JSON.stringify(messages.slice(0, lastUser + 1)))
    .digest('hex')}`;
}

export function hasPendingClientTools(response: {
  toolCalls?: readonly unknown[];
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

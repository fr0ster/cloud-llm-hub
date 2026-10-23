import { AsyncLocalStorage } from 'node:async_hooks';
import type { ILlm, LlmUsage, Message } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { parseContextCapture } from '../agent-config';
import { getRequestSessionId } from '../request-session';

type Component = 'planner' | 'executor' | 'checker' | 'chat' | 'other';
const scope = new AsyncLocalStorage<{
  component: Component;
  taskId?: string;
  sessionKey?: string;
}>();

export function runWithContextCapture<T>(
  context: NonNullable<ReturnType<typeof scope.getStore>>,
  fn: () => T,
): T {
  return scope.run(context, fn);
}

/** Observe calls without changing messages, tool definitions, or responses. */
export function captureLlm(
  llm: ILlm,
  component: Component = 'other',
  mode: 'off' | 'stats' = parseContextCapture(),
): ILlm {
  function start(messages: Message[], tools: Parameters<ILlm['chat']>[1]) {
    if (mode !== 'stats') return () => {};
    return (usage?: LlmUsage) => {
      try {
        const roles = {
          system: { messages: 0, characters: 0 },
          user: { messages: 0, characters: 0 },
          assistant: { messages: 0, characters: 0 },
          tool: { messages: 0, characters: 0 },
        };
        const allowedNames = new Set(tools?.map((tool) => tool.name));
        const names = new Map<string, string>();
        for (const message of messages)
          for (const call of message.tool_calls ?? [])
            names.set(
              call.id,
              allowedNames.has(call.function.name)
                ? call.function.name
                : 'unlisted',
            );
        const results: Array<{ tool: string; characters: number }> = [];
        for (const message of messages) {
          roles[message.role].messages++;
          roles[message.role].characters +=
            (message.content?.length ?? 0) +
            (message.tool_calls?.reduce(
              (n, call) => n + JSON.stringify(call).length,
              0,
            ) ?? 0);
          if (message.role === 'tool')
            results.push({
              tool: names.get(message.tool_call_id ?? '') ?? 'unlisted',
              characters: message.content?.length ?? 0,
            });
        }
        const context = scope.getStore();
        const stats = {
          component:
            component === 'other' ? 'other' : (context?.component ?? component),
          taskId: context?.taskId,
          sessionKey: context?.sessionKey ?? getRequestSessionId(),
          model: llm.model,
          messageCount: messages.length,
          roles,
          toolResultCount: results.length,
          largestToolResults: results
            .sort((a, b) => b.characters - a.characters)
            .slice(0, 3),
          toolDefinitionCount: tools?.length ?? 0,
          toolDefinitionCharacters:
            tools?.reduce((n, tool) => n + JSON.stringify(tool).length, 0) ?? 0,
        };
        // Explicit allowlist: never serialize the response, errors, or raw usage.
        cds.log('context-capture').info(
          JSON.stringify({
            ...stats,
            ...(typeof usage?.promptTokens === 'number'
              ? { inputTokens: usage.promptTokens }
              : {}),
            ...(typeof usage?.completionTokens === 'number'
              ? { outputTokens: usage.completionTokens }
              : {}),
          }),
        );
      } catch {
        // Telemetry must never affect the call or stream.
      }
    };
  }
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'chat')
        return async (...args: Parameters<ILlm['chat']>) => {
          const finish = start(args[0], args[1]);
          let usage: LlmUsage | undefined;
          try {
            const result = await target.chat(...args);
            if (result.ok) usage = result.value.usage;
            return result;
          } finally {
            finish(usage);
          }
        };
      if (property === 'streamChat')
        return async function* (...args: Parameters<ILlm['streamChat']>) {
          const finish = start(args[0], args[1]);
          let usage: LlmUsage | undefined;
          try {
            for await (const result of target.streamChat(...args)) {
              if (result.ok && result.value.usage) usage = result.value.usage;
              yield result;
            }
          } finally {
            finish(usage);
          }
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { ILlm, LlmUsage, Message } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { parseContextCapture } from '../agent-config';
import { getRequestSessionId, getRequestUserId } from '../request-session';
import { appendContext, contextJson, warnContext } from './context-store';

const salt = randomBytes(32);
const fingerprint = (content: string): string =>
  createHash('sha256').update(salt).update(content).digest('hex').slice(0, 12);
const normalize = (content: string): string =>
  content.replace(/\r\n?/g, '\n').normalize('NFC');
let canarySource: string | undefined;
let canaryPattern: RegExp | undefined;
function canaryRegex(): RegExp | undefined {
  const source = process.env.LLM_AGENT_CONTEXT_CANARY ?? '';
  if (source !== canarySource) {
    canarySource = source;
    canaryPattern = undefined;
    if (source) {
      try {
        canaryPattern = new RegExp(source, 'gu');
      } catch {
        cds
          .log('context-capture')
          .warn('Invalid LLM_AGENT_CONTEXT_CANARY regex; canary scan disabled');
      }
    }
  }
  return canaryPattern;
}

type Component =
  | 'summarizer'
  | 'analyst'
  | 'classifier'
  | 'presentation'
  | 'planner'
  | 'executor'
  | 'checker'
  | 'chat'
  | 'other'
  | 'planner-author';
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

export function currentContextTaskId(): string | undefined {
  return scope.getStore()?.taskId;
}

/** Observe calls without changing messages, tool definitions, or responses. */
export function captureLlm(
  llm: ILlm,
  component: Component = 'other',
  mode: 'off' | 'stats' | 'full' = parseContextCapture(),
  defaults: { temperature?: number; maxTokens?: number } = {},
): ILlm {
  function start(messages: Message[], tools: Parameters<ILlm['chat']>[1]) {
    if (mode !== 'stats') return () => {};
    const context = scope.getStore();
    const sessionKey = context?.sessionKey ?? getRequestSessionId();
    const session =
      sessionKey === undefined
        ? undefined
        : fingerprint(JSON.stringify([getRequestUserId() ?? '', sessionKey]));
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
        const fingerprints = messages.map((message) => {
          const content =
            normalize(message.content ?? '') +
            (message.tool_calls?.length
              ? normalize(
                  JSON.stringify(
                    message.tool_calls.map((call) => ({
                      ...call,
                      function: {
                        ...call.function,
                        arguments: normalize(call.function.arguments),
                      },
                    })),
                  ),
                )
              : '');
          return {
            role: message.role,
            chars: content.length,
            h: fingerprint(content),
          };
        });
        const toolContent = normalize(JSON.stringify(tools ?? []));
        const systemContent = normalize(
          messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content ?? '')
            .join('\n'),
        );
        const pattern = canaryRegex();
        const matchesByRole = new Map<Message['role'] | 'tools', Set<string>>();
        if (pattern) {
          const scan = (
            role: Message['role'] | 'tools',
            content: string,
          ): void => {
            const matches = content.match(pattern) ?? [];
            if (!matches.length) return;
            const distinct = matchesByRole.get(role) ?? new Set<string>();
            for (const match of matches) distinct.add(match);
            matchesByRole.set(role, distinct);
          };
          for (const message of messages)
            scan(
              message.role,
              (message.content ?? '') +
                (message.tool_calls?.length
                  ? JSON.stringify(message.tool_calls)
                  : ''),
            );
          scan('tools', JSON.stringify(tools ?? []));
        }
        const canaries = [...matchesByRole].map(([role, matches]) => ({
          role,
          matches: [...matches],
        }));
        const stats = {
          component:
            component !== 'chat'
              ? component
              : (context?.component ?? component),
          taskId: context?.taskId,
          ...(session ? { session } : {}),
          fingerprints,
          systemFingerprint: {
            chars: systemContent.length,
            h: fingerprint(systemContent),
          },
          toolDefinitionsFingerprint: {
            chars: toolContent.length,
            h: fingerprint(toolContent),
          },
          ...(pattern ? { canaries } : {}),
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
  function full(args: Parameters<ILlm['chat']>) {
    const started = performance.now();
    const ts = new Date().toISOString();
    const context = scope.getStore();
    const sessionKey = context?.sessionKey ?? getRequestSessionId();
    let messages = '';
    let tools = '';
    let options = '';
    if (mode === 'full') {
      try {
        messages = contextJson(args[0]);
        tools = contextJson(args[1] ?? []);
        options = contextJson({
          temperature: args[2]?.temperature ?? defaults.temperature,
          maxTokens: args[2]?.maxTokens ?? defaults.maxTokens,
          topP: args[2]?.topP,
          stop: args[2]?.stop,
        });
      } catch {
        warnContext('SERIALIZATION_FAILED');
      }
    }
    return (
      response: { content: string; toolCalls?: object[] },
      usage: LlmUsage | undefined,
      error: string | null,
    ) => {
      if (mode !== 'full' || !messages) return;
      try {
        appendContext({
          ts,
          session:
            sessionKey === undefined
              ? null
              : fingerprint(
                  JSON.stringify([getRequestUserId() ?? '', sessionKey]),
                ),
          component:
            component !== 'chat'
              ? component
              : (context?.component ?? component),
          model: args[2]?.model ?? llm.model ?? null,
          trace: args[2]?.trace?.traceId ?? cds.context?.id ?? null,
          messages,
          tools,
          options,
          response: contextJson(response),
          inputTokens: usage?.promptTokens ?? null,
          outputTokens: usage?.completionTokens ?? null,
          cachedTokens:
            usage &&
            'cachedTokens' in usage &&
            typeof usage.cachedTokens === 'number'
              ? usage.cachedTokens
              : null,
          durationMs: performance.now() - started,
          ok: error === null,
          error,
        });
      } catch {
        warnContext('SERIALIZATION_FAILED');
      }
    };
  }
  return new Proxy(llm, {
    get(target, property) {
      if (property === 'chat')
        return async (...args: Parameters<ILlm['chat']>) => {
          const finish = start(args[0], args[1]);
          const save = full(args);
          let response: { content: string; toolCalls?: object[] } = {
            content: '',
          };
          let error: string | null = null;
          let usage: LlmUsage | undefined;
          try {
            const result = await target.chat(...args);
            if (result.ok) {
              usage = result.value.usage;
              response = {
                content: result.value.content,
                toolCalls: result.value.toolCalls,
              };
            } else error = result.error.name;
            return result;
          } catch (caught) {
            error = caught instanceof Error ? caught.name : 'Error';
            throw caught;
          } finally {
            finish(usage);
            save(response, usage, error);
          }
        };
      if (property === 'streamChat')
        return async function* (...args: Parameters<ILlm['streamChat']>) {
          const finish = start(args[0], args[1]);
          const save = full(args);
          const response: { content: string; toolCalls?: object[] } = {
            content: '',
          };
          let error: string | null = null;
          let usage: LlmUsage | undefined;
          const deltas = new Map<
            number,
            { id: string; name: string; arguments: string }
          >();
          try {
            for await (const result of target.streamChat(...args)) {
              if (result.ok) {
                if (result.value.usage) usage = result.value.usage;
                if (mode === 'full') {
                  response.content += result.value.content;
                  for (const call of result.value.toolCalls ?? []) {
                    if ('index' in call) {
                      const delta = deltas.get(call.index) ?? {
                        id: '',
                        name: '',
                        arguments: '',
                      };
                      if (call.id) delta.id = call.id;
                      if (call.name) delta.name += call.name;
                      delta.arguments += call.arguments ?? '';
                      deltas.set(call.index, delta);
                    } else {
                      response.toolCalls ??= [];
                      response.toolCalls.push(call);
                    }
                  }
                }
              } else error = result.error.name;
              yield result;
            }
          } catch (caught) {
            error = caught instanceof Error ? caught.name : 'Error';
            throw caught;
          } finally {
            if (deltas.size) {
              response.toolCalls ??= [];
              response.toolCalls.push(...deltas.values());
            }
            finish(usage);
            save(response, usage, error);
          }
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import {
  SmartAgentBuilder,
  unwrapBuilderResult,
} from '@mcp-abap-adt/llm-agent-libs';
import { BuildValidationError } from '../../srv/lib/build-validation-error';
import {
  clientHistoryMessages,
  clientHistoryTurnId,
  configuredClientHistory,
  hasPendingClientTools,
} from '../../srv/lib/client-history';
import { testAccess } from './helpers/test-rag-access';

test('client turn identity survives tool results and distinguishes repeated user text', () => {
  const user: Message = { role: 'user', content: 'read safely' };
  const start: Message[] = [user];
  const continued: Message[] = [
    ...start,
    {
      role: 'assistant',
      content: 'Reading file',
      tool_calls: [
        {
          id: 'read',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'read', content: 'result' },
  ];
  expect(clientHistoryTurnId(continued)).toBe(clientHistoryTurnId(start));
  expect(clientHistoryTurnId([...continued, user])).not.toBe(
    clientHistoryTurnId(start),
  );
  expect(clientHistoryTurnId([])).toBeUndefined();
});

test.each([
  [{ toolCalls: [{}] }, true],
  [{ finishReason: 'tool_calls' }, true],
  [{ stopReason: 'tool_use' }, true],
  [{ toolCalls: [], stopReason: 'stop' }, false],
] as const)('pending client tools: %j', (response, pending) => {
  expect(hasPendingClientTools(response)).toBe(pending);
});

test.each([undefined, '', '  ', 'off', ' off '])(
  'client history defaults to off: %s',
  (value) => {
    expect(configuredClientHistory({ LLM_AGENT_CLIENT_HISTORY: value })).toBe(
      'off',
    );
  },
);

test('client history accepts explicit on', () => {
  expect(configuredClientHistory({ LLM_AGENT_CLIENT_HISTORY: ' on ' })).toBe(
    'on',
  );
});

test.each(['true', 'false', '0', '1', 'OFF', 'enabled', 'off,on'])(
  'client history rejects invalid values: %s',
  (value) => {
    expect(() =>
      configuredClientHistory({ LLM_AGENT_CLIENT_HISTORY: value }),
    ).toThrow(BuildValidationError);
  },
);

test('off keeps system messages for adapter detection and drops orphan history', () => {
  expect(
    clientHistoryMessages([
      { role: 'system', content: 'client protocol' },
      { role: 'assistant', content: 'orphan answer' },
      { role: 'tool', content: 'orphan tool', tool_call_id: 'old' },
    ]),
  ).toEqual([{ role: 'system', content: 'client protocol' }]);
});

test.each([
  [undefined, 3],
  [1, 1],
  [0, 3],
] as const)(
  'on retains library recency semantics: window=%s',
  async (window, count) => {
    const caller = { userId: 'user', sessionId: 'recency', isAdmin: false };
    const history: Message[] = [
      { role: 'user', content: 'earlier request' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'current request' },
    ];
    let received: Message[] = [];
    const llm: ILlm = {
      chat: async (messages) => {
        received = messages;
        return {
          ok: true,
          value: { content: 'Final answer', finishReason: 'stop' },
        };
      },
      async *streamChat(messages, tools, options) {
        yield await llm.chat(messages, tools, options);
      },
    };
    const handle = unwrapBuilderResult(
      await new SmartAgentBuilder({
        skipModelValidation: true,
        agent: {
          classificationEnabled: false,
          ragTranslateEnabled: false,
          historyRecencyWindow: window,
        },
      })
        .withMainLlm(llm)
        .withRagAccess(testAccess([caller]))
        .build(),
    );
    const result = await handle.agent.process(
      clientHistoryMessages(history, 'on'),
      {
        caller,
        sessionId: caller.sessionId,
      },
    );
    if (!result.ok) throw result.error;
    expect(received.filter((message) => message.role !== 'system')).toEqual(
      count === 1 ? history.slice(2) : history,
    );
  },
);

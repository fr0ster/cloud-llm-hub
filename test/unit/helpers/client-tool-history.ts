import * as sessionTurns from '../../../srv/lib/session-turns';
import { harness } from './channel-harness';

/** Exercise real request normalization and response handling across HTTP calls. */
export function clientToolHistoryTests(
  protocol: 'openai' | 'anthropic',
  body: (stream: boolean) => { messages: object[] },
  call: (body: object, sessionId: string) => { done: Promise<void> },
) {
  const agentConfig = jest.requireMock<
    typeof import('../../../srv/agent-config')
  >('../../../srv/agent-config');
  const config = agentConfig.getAgentConfig();
  test.each(['off', 'on'] as const)(
    'records identical current-only requests as separate turns (clientHistory=%s)',
    async (clientHistory) => {
      const configured = jest
        .spyOn(agentConfig, 'getAgentConfig')
        .mockReturnValue({
          ...config,
          agent: { ...config.agent, clientHistory },
        });
      const sessionId = randomUUID();
      const recorded = jest
        .spyOn(sessionTurns, 'recordTurn')
        .mockImplementation(() => {});
      try {
        for (const content of ['First status', 'Second status']) {
          harness.process = async () => ({
            ok: true,
            value: { content, stopReason: 'stop' },
          });
          await call(
            {
              ...body(false),
              messages: [{ role: 'user', content: 'status?' }],
            },
            sessionId,
          ).done;
        }
        expect(
          recorded.mock.calls.map(([, user, answer]) => [user.content, answer]),
        ).toEqual([
          ['status?', 'First status'],
          ['status?', 'Second status'],
        ]);
        expect(recorded.mock.calls[0][3]).not.toBe(recorded.mock.calls[1][3]);
      } finally {
        configured.mockRestore();
        recorded.mockRestore();
      }
    },
  );

  test.each(
    (['off', 'on'] as const).flatMap((clientHistory) => [
      { clientHistory, stream: false, combined: false },
      { clientHistory, stream: true, combined: false },
      { clientHistory, stream: true, combined: true },
    ]),
  )(
    'client tool continuations record one complete user turn (clientHistory=$clientHistory, stream=$stream, combined=$combined)',
    async ({ clientHistory, stream, combined }) => {
      const configured = jest
        .spyOn(agentConfig, 'getAgentConfig')
        .mockReturnValue({
          ...config,
          agent: { ...config.agent, clientHistory },
        });
      const sessionId = randomUUID();
      const recorded = jest
        .spyOn(sessionTurns, 'recordTurn')
        .mockImplementation(() => {});
      const finalAnswer = `Final answer ${'complete result '.repeat(1000)}`;
      const messages = [...body(stream).messages];
      const tools = [
        {
          type: 'function',
          function: {
            name: 'Read',
            description: 'Read a file',
            parameters: { type: 'object', properties: {} },
          },
        },
      ];
      const request = () => ({
        ...body(stream),
        tools:
          protocol === 'openai'
            ? tools
            : [
                {
                  name: 'Read',
                  description: 'Read a file',
                  input_schema: { type: 'object', properties: {} },
                },
              ],
        messages: [...messages],
      });
      try {
        for (const round of [1, 2]) {
          const toolCalls = [
            {
              id: `read-${round}`,
              type: 'function',
              function: { name: 'Read', arguments: '{}' },
            },
          ];
          harness.process = async () => ({
            ok: true,
            value: {
              content: 'Reading file',
              toolCalls,
              stopReason: 'tool_calls',
            },
          });
          harness.stream = async function* () {
            if (combined) {
              yield {
                ok: true,
                value: {
                  content: 'Reading file',
                  toolCalls,
                  finishReason: 'tool_calls',
                },
              };
              return;
            }
            yield { ok: true, value: { content: 'Reading file' } };
            yield { ok: true, value: { toolCalls } };
            yield { ok: true, value: { finishReason: 'tool_calls' } };
          };
          await call(request(), sessionId).done;
          expect(recorded).not.toHaveBeenCalled();
          if (protocol === 'openai')
            messages.push(
              {
                role: 'assistant',
                content: 'Reading file',
                tool_calls: [
                  {
                    id: `read-${round}`,
                    type: 'function',
                    function: { name: 'Read', arguments: '{}' },
                  },
                ],
              },
              {
                role: 'tool',
                tool_call_id: `read-${round}`,
                content: `FILE_${round}`,
              },
            );
          else
            messages.push(
              {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'Reading file' },
                  {
                    type: 'tool_use',
                    id: `read-${round}`,
                    name: 'Read',
                    input: {},
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: `read-${round}`,
                    content: `FILE_${round}`,
                  },
                ],
              },
            );
        }
        harness.process = async () => ({
          ok: true,
          value: { content: finalAnswer, stopReason: 'stop' },
        });
        harness.stream = async function* () {
          if (combined) {
            yield {
              ok: true,
              value: { content: finalAnswer, finishReason: 'stop' },
            };
            return;
          }
          yield { ok: true, value: { content: finalAnswer.slice(0, 100) } };
          yield {
            ok: true,
            value: { content: finalAnswer.slice(100), finishReason: 'stop' },
          };
        };
        await call(request(), sessionId).done;
        expect(recorded).toHaveBeenCalledTimes(1);
        const id = recorded.mock.calls[0][3];
        expect(id).toEqual(expect.stringMatching(/^client:/));
        expect(recorded).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'alice' }),
          { role: 'user', content: 'hi' },
          finalAnswer,
          id,
        );
        // A replay that keeps only the latest tool round still identifies the same turn.
        await call(
          {
            ...request(),
            messages: [messages[0], ...messages.slice(-2)],
          },
          sessionId,
        ).done;
        expect(recorded).toHaveBeenCalledTimes(2);
        expect(recorded.mock.calls[1][3]).toBe(id);
      } finally {
        configured.mockRestore();
        recorded.mockRestore();
      }
    },
  );
}

import { randomUUID } from 'node:crypto';

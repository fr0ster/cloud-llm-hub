import { clientHistoryTurnId } from '../../../srv/lib/client-history';
import * as sessionTurns from '../../../srv/lib/session-turns';
import { harness } from './channel-harness';

/** Exercise real request normalization and response handling across HTTP calls. */
export function clientToolHistoryTests(
  protocol: 'openai' | 'anthropic',
  body: (stream: boolean) => { messages: object[] },
  call: (body: object) => { done: Promise<unknown> },
) {
  test.each([
    { stream: false, combined: false },
    { stream: true, combined: false },
    { stream: true, combined: true },
  ])(
    'client tool continuations record one complete user turn (stream=$stream, combined=$combined)',
    async ({ stream, combined }) => {
      const recorded = jest
        .spyOn(sessionTurns, 'recordTurn')
        .mockImplementation(() => {});
      const finalAnswer = `Final answer ${'complete result '.repeat(1000)}`;
      const messages = [...body(stream).messages];
      const id = clientHistoryTurnId([{ role: 'user', content: 'hi' }]);
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
          await call(request()).done;
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
        await call(request()).done;
        expect(recorded).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'alice' }),
          { role: 'user', content: 'hi' },
          finalAnswer,
          id,
        );
      } finally {
        recorded.mockRestore();
      }
    },
  );
}

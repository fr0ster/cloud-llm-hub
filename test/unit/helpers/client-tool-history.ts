import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryRagProvider } from '@mcp-abap-adt/llm-agent';
import {
  initLongSessions,
  type LongSession,
  setLongSessionsForTest,
} from '../../../srv/lib/long-session';
import { SessionHistoryRouter } from '../../../srv/lib/session-history-collection';
import {
  lifecycleHooks,
  resolveSession,
} from '../../../srv/lib/session-lifecycle';
import { SqliteSessionRecordStore } from '../../../srv/lib/session-record-store';
import { sweepSessionHistory } from '../../../srv/session-store';
import { deferred, harness } from './channel-harness';

/** Exercise real request normalization and response handling across HTTP calls. */
export function clientToolHistoryTests(
  protocol: 'openai' | 'anthropic',
  body: (stream: boolean) => { messages: object[] },
  call: (
    body: object,
    sessionId: string,
    session?: LongSession,
  ) => { done: Promise<void>; res: { body: string } },
) {
  const agentConfig = jest.requireMock<
    typeof import('../../../srv/agent-config')
  >('../../../srv/agent-config');
  const config = agentConfig.getAgentConfig();
  const manager = jest.requireMock<typeof import('../../../srv/agent-manager')>(
    '../../../srv/agent-manager',
  );
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
      const router = new SessionHistoryRouter(
        new InMemoryRagProvider({ name: 'standalone-history' }),
      );
      const history = jest
        .spyOn(manager, 'getSharedHistoryRag')
        .mockReturnValue(router);
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
        await router.waitForTurns(sessionId);
        const turns = await router.listTurns({
          userId: 'alice',
          sessionId,
          isAdmin: false,
        });
        expect(
          turns
            .map(({ userText, assistantText }) => [userText, assistantText])
            .sort(),
        ).toEqual([
          ['status?', 'First status'],
          ['status?', 'Second status'],
        ]);
        expect(turns[0].id).not.toBe(turns[1].id);
      } finally {
        await router.drainWrites();
        configured.mockRestore();
        history.mockRestore();
      }
    },
  );

  test.each(
    (['off', 'on'] as const).flatMap((clientHistory) =>
      [false, true].flatMap((longSession) => [
        { clientHistory, longSession, stream: false, combined: false },
        { clientHistory, longSession, stream: true, combined: false },
        { clientHistory, longSession, stream: true, combined: true },
      ]),
    ),
  )(
    'client tool continuations record one complete user turn (clientHistory=$clientHistory, longSession=$longSession, stream=$stream, combined=$combined)',
    async ({ clientHistory, longSession, stream, combined }) => {
      const configured = jest
        .spyOn(agentConfig, 'getAgentConfig')
        .mockReturnValue({
          ...config,
          agent: { ...config.agent, clientHistory },
          rag: {
            ...config.rag,
            backends: {
              tools: 'in-memory',
              session: 'in-memory',
              persistent: 'in-memory',
            },
          },
        });
      const provider = new InMemoryRagProvider({ name: 'client-tool-history' });
      let router = new SessionHistoryRouter(provider);
      const history = jest
        .spyOn(manager, 'getSharedHistoryRag')
        .mockReturnValue(router);
      const dir = longSession
        ? mkdtempSync(path.join(tmpdir(), 'clh-tool-turn-'))
        : undefined;
      const store = dir
        ? new SqliteSessionRecordStore(path.join(dir, 'sessions.db'))
        : undefined;
      let session: LongSession | undefined;
      if (store) {
        const opened = initLongSessions(lifecycleHooks(store)).open(
          'alice',
          {},
        );
        if ('refused' in opened) throw new Error(opened.refused);
        session = opened;
      }
      const sessionId = session?.key ?? randomUUID();
      const caller = { userId: 'alice', sessionId, isAdmin: false };
      const restart = async () => {
        if (!store) return;
        await router.drainWrites();
        sweepSessionHistory(Infinity);
        await store.close();
        initLongSessions(lifecycleHooks(store));
        router = new SessionHistoryRouter(provider);
        history.mockReturnValue(router);
        session = await resolveSession('alice', sessionId);
        expect(session?.revived).toBe(true);
      };
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
      let pendingId: string | undefined;
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
          if (store && round === 1) {
            const saving = deferred();
            const saved = deferred();
            const put = store.put.bind(store);
            const write = jest
              .spyOn(store, 'put')
              .mockImplementationOnce(async (record) => {
                saving.resolve();
                await saved.promise;
                await put(record);
              });
            const response = call(request(), sessionId, session);
            try {
              await Promise.race([saving.promise, response.done]);
              expect(write).toHaveBeenCalledTimes(1);
              expect(response.res.body).not.toContain('read-1');
            } finally {
              saved.resolve();
              await response.done;
              write.mockRestore();
            }
            expect(response.res.body).toContain('read-1');
          } else {
            const response = call(
              request(),
              session ? sessionId : randomUUID(),
              session,
            );
            await response.done;
            expect(response.res.body).toContain(`read-${round}`);
          }
          if (store) {
            const pending = (await store.get('alice', sessionId))
              ?.clientToolTurns;
            pendingId ??= pending?.[0]?.[1];
            expect(pendingId).toEqual(expect.stringMatching(/^client:/));
            expect(pending).toEqual(
              Array.from({ length: round }, (_, i) => [
                `read-${i + 1}`,
                pendingId,
              ]),
            );
          }
          expect(await router.listTurns(caller)).toEqual([]);
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
        const lastRound = {
          ...request(),
          messages: [messages[0], ...messages.slice(-2)],
        };
        await restart();
        await call(
          store && combined ? lastRound : request(),
          sessionId,
          session,
        ).done;
        await router.waitForTurns(sessionId);
        const complete = await router.listTurns(caller);
        expect(complete).toEqual([
          expect.objectContaining({
            id: pendingId ?? expect.stringMatching(/^client:/),
            userText: 'hi',
            assistantText: finalAnswer,
          }),
        ]);
        expect(
          (await store?.get('alice', sessionId))?.clientToolTurns,
        ).toBeUndefined();
        harness.process = async () => ({
          ok: true,
          value: { content: 'Replay answer', stopReason: 'stop' },
        });
        harness.stream = async function* () {
          yield {
            ok: true,
            value: { content: 'Replay answer', finishReason: 'stop' },
          };
        };
        for (const replay of store ? [request(), lastRound] : [request()]) {
          await restart();
          await call(replay, sessionId, session).done;
          await router.waitForTurns(sessionId);
          expect(
            (await router.listTurns(caller)).map(({ id, assistantText }) => ({
              id,
              assistantText,
            })),
          ).toEqual([{ id: complete[0].id, assistantText: finalAnswer }]);
        }
      } finally {
        await router.drainWrites();
        if (store) {
          setLongSessionsForTest(undefined);
          lifecycleHooks();
          await store.close();
        }
        if (dir) rmSync(dir, { recursive: true, force: true });
        history.mockRestore();
        configured.mockRestore();
      }
    },
  );
}

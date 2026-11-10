import express from 'express';
import { z } from 'zod';
import { type LongSession, longSessions } from '../../../srv/lib/long-session';
import {
  clearRoleModels,
  setRoleModels,
} from '../../../srv/lib/role-model-settings';
import { liveSession } from './canonical-rag';
import { type fakeRes, harness } from './channel-harness';

export function typedResponse(res: ReturnType<typeof fakeRes>) {
  return new Proxy(express().response, {
    get(target, key) {
      return Reflect.get(key in res ? res : target, key);
    },
    set(_target, key, value) {
      return Reflect.set(res, key, value);
    },
  });
}

export function responseModelTests(
  body: (stream: boolean) => object,
  call: (
    body: object,
    session?: LongSession,
  ) => {
    res: { body: string; statusCode: number };
    done: Promise<void>;
  },
) {
  describe('response model', () => {
    const saved = { ...process.env };
    beforeEach(() => {
      process.env.LLM_AGENT_MODELS = 'm,request-model,session-model';
      process.env.LLM_AGENT_MODEL = 'm';
      harness.stream = async function* () {
        yield { ok: true, value: { content: 'done' } };
        yield {
          ok: true,
          value: {
            finishReason: 'stop',
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          },
        };
      };
    });
    afterEach(() => {
      process.env = { ...saved };
      harness.user.is = () => true;
      clearRoleModels('alice', 'response-model-session');
    });
    for (const stream of [false, true]) {
      it.each([
        { admin: true, coordinator: false, expected: 'request-model' },
        { admin: false, coordinator: false, expected: 'm' },
        { admin: true, coordinator: true, expected: 'session-model' },
        { admin: false, coordinator: true, expected: 'session-model' },
      ])(
        `reports the serving model (stream=${stream}, %j)`,
        async ({ admin, coordinator, expected }) => {
          harness.user.is = () => admin;
          const session = liveSession('alice', 'response-model-session');
          if (coordinator)
            setRoleModels('alice', session, {
              coordinator: { model: 'session-model' },
            });
          const { res, done } = call(
            {
              ...body(stream),
              session,
              model: 'request-model',
              stream_options: { include_usage: true },
            },
            longSessions().get('alice', session),
          );
          await done;
          expect(res.statusCode).toBe(200);
          const values = stream
            ? res.body
                .split('\n')
                .filter(
                  (line) =>
                    line.startsWith('data: ') && line !== 'data: [DONE]',
                )
                .map((line) => JSON.parse(line.slice(6)))
            : [JSON.parse(res.body)];
          if ('max_tokens' in body(stream) && stream) {
            const events = values.map((value) =>
              z.object({ type: z.string() }).passthrough().parse(value),
            );
            const starts = events.filter(
              (event) => event.type === 'message_start',
            );
            expect(starts).toHaveLength(1);
            for (const event of starts)
              expect(
                z
                  .object({ message: z.object({ model: z.literal(expected) }) })
                  .safeParse(event).success,
              ).toBe(true);
            for (const event of events) {
              if ('model' in event) expect(event.model).toBe(expected);
              if ('message' in event)
                expect(
                  z
                    .object({
                      message: z.object({ model: z.literal(expected) }),
                    })
                    .safeParse(event).success,
                ).toBe(true);
            }
          } else {
            expect(values.length).toBeGreaterThan(0);
            for (const value of values)
              expect(
                z.object({ model: z.literal(expected) }).safeParse(value)
                  .success,
              ).toBe(true);
          }
        },
      );
    }
  });
}

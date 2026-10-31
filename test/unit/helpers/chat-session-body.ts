import type { Server } from 'node:http';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { userCollectionId } from '../../../srv/collection-ids';
import { LocalRagMcpClient } from '../../../srv/lib/dialogue-rag-tools';
import { longSessions } from '../../../srv/lib/long-session';
import * as sessionConfiguration from '../../../srv/lib/session-config';
import {
  requireLongSession,
  sessionMiddleware,
} from '../../../srv/lib/session-middleware';
import { CollectionRegistry } from '../../../srv/rag-collections';
import { getRequestSessionId } from '../../../srv/request-session';
import { liveSession } from './canonical-rag';
import { harness } from './channel-harness';

export function chatSessionBodyTests(
  path: '/chat/completions' | '/messages',
  handler: (req: Request, res: Response) => Promise<void>,
) {
  describe('HTTP chat session binding', () => {
    let server: Server;
    let url: string;
    let key: string;
    let other: string;
    let registry: CollectionRegistry;
    const dialect = path === '/messages' ? 'anthropic' : 'openai';
    beforeEach(async () => {
      delete process.env.LLM_AGENT_PLAIN_API;
      jest
        .spyOn(sessionConfiguration, 'sessionConfig')
        .mockReturnValue(sessionConfiguration.loadSessionConfig({}));
      key = liveSession('alice', `ls-body-${dialect}`);
      other = liveSession('alice', `ls-header-${dialect}`);
      registry = new CollectionRegistry();
      await registry.createCollection({
        id: userCollectionId('notes', 'alice'),
        logicalId: 'notes',
        scope: 'user',
        owner: 'alice',
        displayName: 'notes',
        description: '',
      });
      const app = express();
      app.post(`/v1${path}`, express.json());
      app.use(
        '/v1',
        sessionMiddleware({
          userIdOf: () => 'alice',
          resolveSession: async (user, session) =>
            longSessions().get(user, session),
        }),
      );
      app.post(`/v1${path}`, requireLongSession(dialect), (req, res) => {
        expect(req.body).not.toHaveProperty('session');
        return handler(req, res);
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing port');
      url = `http://127.0.0.1:${address.port}/v1${path}`;
    });
    afterEach(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      jest.restoreAllMocks();
    });
    function post(
      extra: object,
      headers: Record<string, string> = {},
      target = url,
    ) {
      return fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          model: 'm',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'save' }],
          ...extra,
        }),
      });
    }
    test.each(['body', 'header', 'both'])(
      '%s binding executes record_add and exposes the generated id to the model',
      async (binding) => {
        const client = new LocalRagMcpClient(
          {
            listTools: async () => ({ ok: true, value: [] }),
            callTool: async () => {
              throw new Error('Unexpected upstream call');
            },
          },
          () => registry,
        );
        harness.process = async () => {
          expect(getRequestSessionId()).toBe(key);
          const result = await client.callTool('record_add', {
            collection: 'notes',
            text: 'saved fact',
          });
          if (!result.ok || typeof result.value.content !== 'string')
            throw new Error('Missing model result');
          const data = z
            .object({ record: z.string() })
            .parse(JSON.parse(result.value.content));
          expect(data.record).toMatch(/^[0-9a-f-]{36}$/);
          expect(
            await registry.getDocument(
              userCollectionId('notes', 'alice'),
              data.record,
            ),
          ).toMatchObject({ text: 'saved fact' });
          return {
            ok: true,
            value: { content: data.record, stopReason: 'stop' },
          };
        };
        const response = await post(
          binding === 'header' ? {} : { session: key },
          binding === 'body'
            ? {}
            : { 'x-clh-session': binding === 'both' ? other : key },
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toMatch(/[0-9a-f-]{36}/);
      },
    );
    test.each(['foreign', 'closed', 'unknown'])(
      '%s body key has the same refusal as the header',
      async (kind) => {
        const invalid =
          kind === 'foreign'
            ? liveSession('bob', `ls-foreign-${dialect}`)
            : kind === 'closed'
              ? other
              : 'ls-never-opened';
        if (kind === 'closed')
          await longSessions().close('alice', other, 'explicit');
        const bodyResponse = await post(
          { session: invalid },
          { 'x-clh-session': key },
        );
        const headerResponse = await post({}, { 'x-clh-session': invalid });
        expect(bodyResponse.status).toBe(404);
        expect(await bodyResponse.json()).toEqual(await headerResponse.json());
      },
    );
    test.each(['trailing slash', 'upper case'])(
      'body key wins on the %s route variant Express accepts',
      async (variant) => {
        harness.process = async () => {
          expect(getRequestSessionId()).toBe(key);
          return { ok: true, value: { content: 'ok', stopReason: 'stop' } };
        };
        const target =
          variant === 'trailing slash'
            ? `${url}/`
            : url.replace(path, path.toUpperCase());
        const response = await post(
          { session: key },
          { 'x-clh-session': other },
          target,
        );
        expect(response.status).toBe(200);
      },
    );
    test.each(['trailing slash', 'upper case'])(
      'refusals on the %s route variant keep the endpoint envelope',
      async (variant) => {
        const target =
          variant === 'trailing slash'
            ? `${url}/`
            : url.replace(path, path.toUpperCase());
        const canonical = await post({ session: 123 });
        const invalid = await post({ session: 123 }, {}, target);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual(await canonical.json());
        const canonicalUnknown = await post({ session: 'ls-never-opened' });
        const unknown = await post({ session: 'ls-never-opened' }, {}, target);
        expect(unknown.status).toBe(404);
        expect(await unknown.json()).toEqual(await canonicalUnknown.json());
      },
    );
    test('no key requires a session', async () => {
      const response = await post({});
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('SESSION_REQUIRED');
    });
    test.each([123, false, null, [], {}])(
      'rejects non-string session %j',
      async (session) => {
        const response = await post({ session }, { 'x-clh-session': key });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('invalid_request_error');
      },
    );
  });
}

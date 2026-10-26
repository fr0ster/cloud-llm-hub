import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
import {
  type IUsageReader,
  memorySink,
  noopRecorder,
} from '@mcp-abap-adt/llm-usage';
import express, { type Request, type Response } from 'express';
import { requireMcpRole } from '../../srv/lib/require-mcp-role';
import type { UsageRuntime } from '../../srv/lib/usage/runtime';
import { setUsageRuntimeForTest } from '../../srv/lib/usage/runtime-state';
import { createUsageRouter, handleUsageRecords } from '../../srv/usage-handler';

let mockRoles: string[] = [];
jest.mock('@sap/cds', (): object => ({
  context: {
    user: {
      id: 'admin',
      is: (role: string): boolean => mockRoles.includes(role),
    },
  },
}));

function runtime(reader: IUsageReader): UsageRuntime {
  return {
    recorder: noopRecorder,
    forSession: (): typeof noopRecorder => noopRecorder,
    reader: (): IUsageReader => reader,
    status: () => ({
      enabled: true,
      sinks: ['memory'],
      readingSink: 'memory',
      fallback: [],
      buffered: 2,
      delivered: 4,
      unconfirmed: 1,
      lost: {},
      lastErrorCode: 'TEST',
    }),
    enabled: (): boolean => true,
    schedule: (): void => {},
    onClose: (): void => {},
    close: async () => ({ delivered: 0, lost: 0, unconfirmed: 0 }),
  };
}
function record(
  id: string,
  kind: 'x.hub.session' | 'x.hub.request' | 'x.usage.lost' = 'x.hub.session',
  sessionId: string = 's',
  at: number = 150,
): Extract<UsageRecord, { values: object }> {
  return {
    schema: 1,
    id,
    at,
    kind,
    context: { sessionId },
    outcome: 'ok',
    values:
      kind === 'x.usage.lost'
        ? { affectedFrom: 90, affectedTo: 160, 'llm.call': 2 }
        : { event: 'open', turns: 3 },
  };
}
let server: Server;
let base: string;
let sessionResolution: jest.Mock;
let pendingResponse: Response | undefined;
let handlerFinished: jest.Mock;
beforeEach(async (): Promise<void> => {
  mockRoles = ['MCP_Admin'];
  const sink = memorySink({ limit: 100 });
  await sink.write([
    record('session'),
    record('request', 'x.hub.request'),
    record('other', 'x.hub.session', 'other'),
    record('outside', 'x.hub.session', 's', 50),
    record('late', 'x.usage.lost', 's', 300),
    record('global', 'x.usage.lost', '', 400),
  ]);
  setUsageRuntimeForTest(runtime(sink));
  const app = express();
  sessionResolution = jest.fn();
  handlerFinished = jest.fn();
  pendingResponse = undefined;
  app.get('/pending', async (req: Request, res: Response): Promise<void> => {
    pendingResponse = res;
    await handleUsageRecords(req, res);
    handlerFinished();
  });
  app.use('/v1/usage', createUsageRouter());
  app.use('/v1', requireMcpRole);

  app.use(
    '/v1',
    (_req: Request, _res: Response, next: express.NextFunction): void => {
      sessionResolution();
      next();
    },
  );
  app.get('/v1/tools', (_req: Request, res: Response): void => {
    res.end();
  });
  server = app.listen(0);
  await new Promise<void>((resolve: () => void): void => {
    server.once('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async (): Promise<void> => {
  setUsageRuntimeForTest(undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve: () => void): void => {
    server.close((): void => resolve());
  });
});
it.each([['MCP_Admin'], ['MCP_Admin', 'MCP_Developer']])(
  'admin routes accept %s with stale sessions',
  async (...roles: string[]): Promise<void> => {
    mockRoles = roles;
    expect((await fetch(`${base}/v1/tools`)).status).toBe(
      roles.includes('MCP_Developer') ? 200 : 403,
    );
    for (const path of ['status', 'records?from=100&to=200']) {
      const response = await fetch(`${base}/v1/usage/${path}`, {
        headers: { 'x-clh-session': 'stale' },
      });
      expect(response.status).toBe(200);
    }
  },
);
it.each(['MCP_Reader', 'MCP_Developer'])(
  'denies %s without admin',
  async (role: string): Promise<void> => {
    mockRoles = [role];
    expect((await fetch(`${base}/v1/usage/status`)).status).toBe(403);
    expect(
      (await fetch(`${base}/v1/usage/records?from=100&to=200`)).status,
    ).toBe(403);
  },
);
it('admin alone has no tool access', async (): Promise<void> => {
  expect((await fetch(`${base}/v1/tools`)).status).toBe(403);
});
it('mounts admin routes before tool authorization and session resolution', (): void => {
  const source = readFileSync('srv/server.ts', 'utf8');
  const admin = source.indexOf("'/v1/usage'");
  expect(admin).toBeGreaterThan(0);
  expect(admin).toBeLessThan(
    source.indexOf("app.use('/v1', context, wrappedAuth, requireMcpRole"),
  );
  expect(admin).toBeLessThan(source.indexOf('sessionMiddleware({'));
});
it('filters window, kinds and session while retaining late and global loss evidence', async (): Promise<void> => {
  const response = await fetch(
    `${base}/v1/usage/records?from=100&to=200&kinds=x.hub.request&sessionId=s`,
  );
  const text = await response.text();
  expect(text).toContain('"id":"request"');
  expect(text).toContain('"id":"late"');
  expect(text).toContain('"id":"global"');
  for (const id of ['session', 'other', 'outside'])
    expect(text).not.toContain(`"id":"${id}"`);
});
it.each([
  '',
  'from=200&to=100',
  'from=-1&to=200',
  'from=abc&to=200',
  'from=100&to=200&format=xml',
  'from=100&to=200&kinds=llm',
  'from=100&to=200&sessionId=',
  'from=100&to=200&from=101',
  'from=100&to=200&extra=x',
])('invalid query returns 400: %s', async (query: string): Promise<void> => {
  const response = await fetch(`${base}/v1/usage/records?${query}`);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain('stack');
});
it('off returns clear 404 for both routes', async (): Promise<void> => {
  setUsageRuntimeForTest(undefined);
  for (const path of ['status', 'records?from=100&to=200']) {
    const response = await fetch(`${base}/v1/usage/${path}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('recording is off');
  }
});
it('reports runtime status', async (): Promise<void> => {
  const response = await fetch(`${base}/v1/usage/status`);
  expect(await response.text()).toContain('"unconfirmed":1');
});
it('CSV has typed hub and library columns, escaping and extra values', async (): Promise<void> => {
  const sink = memorySink({ limit: 10 });
  await sink.write([
    {
      ...record('csv'),
      context: { component: 'helper,"quoted"\nline' },
      values: {
        turns: 3,
        admissionWaitMs: 2,
        chunks: 4,
        stateBytes: 8,
        userCollectionDocuments: 2,
        rssBytes: 16,
        future: 'a,b',
      },
    },
  ]);
  setUsageRuntimeForTest(runtime(sink));
  const text = await (
    await fetch(`${base}/v1/usage/records?from=100&to=200&format=csv`)
  ).text();
  for (const column of [
    'values.turns',
    'values.admissionWaitMs',
    'values.chunks',
    'values.stateBytes',
    'values.userCollectionDocuments',
    'values.rssBytes',
    'inputMessages',
    'toolDefsChars',
    'context.component',
    'loss_evidence',
    'extra_json',
  ])
    expect(text.split('\n')[0]).toContain(column);
  expect(text).toContain('"helper,""quoted""\nline"');
  expect(text).toContain('"{""future"":""a,b""}"');
});
it('client disconnect closes the reader without consuming the export', async (): Promise<void> => {
  let reads = 0;
  let finished = false;
  setUsageRuntimeForTest(
    runtime({
      async *read(): AsyncIterable<UsageRecord> {
        try {
          for (let index = 0; index < 100000; index++) {
            reads++;
            yield {
              ...record(String(index)),
              values: { label: 'x'.repeat(10000) },
            };
          }
        } finally {
          finished = true;
        }
      },
    }),
  );
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/usage/records?from=100&to=200`, {
    signal: controller.signal,
  });
  await response.body?.getReader().read();
  controller.abort();
  for (let attempt = 0; attempt < 100 && !finished; attempt++)
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 10);
    });
  expect(finished).toBe(true);
  expect(reads).toBeLessThan(100000);
});

it('CSV marks late and global losses despite a kinds filter', async (): Promise<void> => {
  const text = await (
    await fetch(
      `${base}/v1/usage/records?from=100&to=200&kinds=x.hub.request&sessionId=s&format=csv`,
    )
  ).text();
  const lines = text.trim().split('\n');
  const columns = lines[0].split(',');
  const idColumn = columns.indexOf('id');
  const lossColumn = columns.indexOf('loss_evidence');
  for (const id of ['late', 'global']) {
    const row = lines
      .slice(1)
      .find((line: string): boolean => line.split(',')[idColumn] === `"${id}"`);
    expect(row?.split(',')[lossColumn]).toBe('"true"');
  }
});
it('CSV preserves library request shape and hub values in their columns', async (): Promise<void> => {
  const sink = memorySink({ limit: 10 });
  await sink.write([
    {
      ...record('hub'),
      values: {
        turns: 3,
        admissionWaitMs: 2,
        chunks: 4,
        stateBytes: 8,
        userCollectionDocuments: 2,
        rssBytes: 16,
      },
    },
    {
      schema: 1,
      id: 'llm',
      at: 150,
      kind: 'llm.call',
      outcome: 'ok',
      context: { component: 'reviewer' },
      operationId: 'op',
      physicalSeq: 1,
      outerAttempt: 0,
      providerAttempt: 0,
      granularity: 'request',
      retriesVisible: true,
      provider: 'fake',
      model: 'fake',
      stream: false,
      tokensSource: 'provider',
      durationMs: 10,
      inputMessages: 2,
      inputChars: 30,
      systemMessages: 1,
      userMessages: 1,
      assistantMessages: 0,
      toolMessages: 0,
      systemChars: 10,
      userChars: 20,
      assistantChars: 0,
      toolChars: 0,
      toolDefs: 1,
      toolDefsChars: 40,
    },
  ]);
  setUsageRuntimeForTest(runtime(sink));
  const lines = (
    await (
      await fetch(`${base}/v1/usage/records?from=100&to=200&format=csv`)
    ).text()
  )
    .trim()
    .split('\n');
  const columns = lines[0].split(',');
  const hub = lines[1].split(',');
  const llm = lines[2].split(',');
  for (const [column, value] of Object.entries({
    'values.turns': 3,
    'values.admissionWaitMs': 2,
    'values.chunks': 4,
    'values.stateBytes': 8,
    'values.userCollectionDocuments': 2,
    'values.rssBytes': 16,
  }))
    expect(hub[columns.indexOf(column)]).toBe(`"${value}"`);
  for (const [column, value] of Object.entries({
    inputMessages: 2,
    inputChars: 30,
    systemMessages: 1,
    userMessages: 1,
    assistantMessages: 0,
    toolMessages: 0,
    systemChars: 10,
    userChars: 20,
    assistantChars: 0,
    toolChars: 0,
    toolDefs: 1,
    toolDefsChars: 40,
  }))
    expect(llm[columns.indexOf(column)]).toBe(`"${value}"`);
  expect(llm[columns.indexOf('context.component')]).toBe('"reviewer"');
});
it('reader failures return a clean error without a stack', async (): Promise<void> => {
  setUsageRuntimeForTest(
    runtime({
      read: (): AsyncIterable<UsageRecord> => {
        throw new Error('private backend error');
      },
    }),
  );
  const response = await fetch(`${base}/v1/usage/records?from=100&to=200`);
  expect(response.status).toBe(500);
  expect(await response.text()).toBe('{"message":"Usage export failed"}');
});

it.each(['', '/'])(
  'usage router terminates paths with suffix %s',
  async (suffix: string): Promise<void> => {
    for (const role of ['MCP_Admin', 'MCP_Developer']) {
      mockRoles = [role];
      for (const method of [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
      ]) {
        for (const path of ['records', 'status', 'missing', '']) {
          const response = await fetch(`${base}/v1/usage/${path}${suffix}`, {
            method,
          });
          const known = path === 'records' || path === 'status';
          expect(response.status).toBe(
            role !== 'MCP_Admin'
              ? 403
              : !known
                ? 404
                : method !== 'GET'
                  ? 405
                  : path === 'records'
                    ? 400
                    : 200,
          );
          if (role === 'MCP_Admin' && known && method !== 'GET')
            expect(response.headers.get('allow')).toBe('GET');
        }
      }
    }
    expect(sessionResolution).not.toHaveBeenCalled();
  },
);
it.each(['=', '+', '-', '@', '\t', '\r'])(
  'CSV neutralizes string prefix %s and preserves numbers',
  async (prefix: string): Promise<void> => {
    const sink = memorySink({ limit: 10 });
    await sink.write([
      {
        ...record('formula'),
        context: { component: `${prefix}payload` },
        values: { turns: -5 },
      },
    ]);
    setUsageRuntimeForTest(runtime(sink));
    const text = await (
      await fetch(`${base}/v1/usage/records?from=100&to=200&format=csv`)
    ).text();
    expect(text).toContain(`"'${prefix}payload"`);
    expect(text).toContain('"-5"');
    expect(text).not.toContain(`"'-5"`);
  },
);
it.each(['jsonl', 'csv'])(
  'disconnect interrupts a hanging %s reader and releases the handler',
  async (format: string): Promise<void> => {
    const returned = jest.fn(
      (): Promise<IteratorResult<UsageRecord>> =>
        Promise.reject(new Error('cleanup failed')),
    );
    let rejectRead: (reason: Error) => void = (): void => {};
    let started: () => void = (): void => {};
    const reading = new Promise<void>((resolve: () => void): void => {
      started = resolve;
    });
    setUsageRuntimeForTest(
      runtime({
        read: (): AsyncIterable<UsageRecord> => ({
          [Symbol.asyncIterator]: (): AsyncIterator<UsageRecord> => ({
            next: (): Promise<IteratorResult<UsageRecord>> => {
              started();
              return new Promise<IteratorResult<UsageRecord>>(
                (
                  _resolve: (value: IteratorResult<UsageRecord>) => void,
                  reject: (reason: Error) => void,
                ): void => {
                  rejectRead = reject;
                },
              );
            },
            return: returned,
          }),
        }),
      }),
    );
    const controller = new AbortController();
    const fetching = fetch(`${base}/pending?from=100&to=200&format=${format}`, {
      signal: controller.signal,
    }).catch((): void => {});
    await reading;
    controller.abort();
    await fetching;
    for (
      let attempt = 0;
      attempt < 100 && handlerFinished.mock.calls.length === 0;
      attempt++
    ) {
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 10);
      });
    }
    expect(handlerFinished).toHaveBeenCalledTimes(1);
    expect(returned).toHaveBeenCalledTimes(1);
    rejectRead(new Error('read failed after disconnect'));
    await new Promise<void>((resolve: () => void): void => {
      setImmediate(resolve);
    });
    expect(pendingResponse?.listenerCount('close')).toBe(0);
    expect(pendingResponse?.listenerCount('drain')).toBe(0);
  },
);
it('keeps at most one close waiter across 10 000 rows', async (): Promise<void> => {
  let registrations = 0;
  let removals = 0;
  let maximumWaiters = 0;
  setUsageRuntimeForTest(
    runtime({
      async *read(): AsyncIterable<UsageRecord> {
        const response = pendingResponse;
        if (!response) throw new Error('Missing response');
        // The handler has one lifecycle listener and one current read waiter.
        registrations = response.listenerCount('close') - 1;
        response.on('newListener', (event: string | symbol): void => {
          if (event === 'close') registrations++;
        });
        response.on('removeListener', (event: string | symbol): void => {
          if (event === 'close') removals++;
        });
        for (let index = 0; index < 10000; index++) {
          maximumWaiters = Math.max(
            maximumWaiters,
            response.listenerCount('close') - 1,
          );
          yield record(String(index));
        }
      },
    }),
  );
  const response = await fetch(`${base}/pending?from=100&to=200`);
  const lines = (await response.text()).trim().split('\n');
  expect(lines).toHaveLength(10000);
  expect(registrations).toBe(10001);
  // All per-read waiters and the lifecycle listener were removed.
  expect(removals).toBe(10002);
  expect(maximumWaiters).toBe(1);
  expect(pendingResponse?.listenerCount('close')).toBe(0);
});

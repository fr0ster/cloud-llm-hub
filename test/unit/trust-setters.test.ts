const mockIdentity = { admin: true };
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    context: { user: { id: 'alice', is: () => mockIdentity.admin } },
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  },
}));

import { createServer, type Server } from 'node:http';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import express from 'express';
import { userCollectionId } from '../../srv/collection-ids';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import { CompositeSkillManager } from '../../srv/lib/composite-skill-manager';
import {
  buildRagToolSchemas,
  eligibleRagTools,
  ragToolEffect,
} from '../../srv/lib/rag-tool-catalogue';
import * as skillsPool from '../../srv/lib/skills-pool';
import { buildSkillsPool } from '../../srv/lib/skills-pool';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';
import { skillId } from '../../srv/lib/trusted-skill';
import { CollectionRegistry } from '../../srv/rag-collections';
import { registerRagRoutes } from '../../srv/rag-handler';
import {
  runWithProfileTools,
  runWithReadOnlyTools,
} from '../../srv/request-session';
import { callRag, liveSession } from './helpers/canonical-rag';

let registry: CollectionRegistry;
let store: TrustStore;
let server: Server;
let base: string;
let skill: string;
const userId = userCollectionId('skills', 'alice');
beforeEach(async () => {
  mockIdentity.admin = true;
  liveSession();
  registry = new CollectionRegistry();
  store = new TrustStore(new InMemoryRag(), 3);
  registry.trustResolver = new TrustResolver(
    registry,
    store,
    parseTrustDefaults(undefined),
  );
  for (const scope of ['global', 'user', 'session'] as const) {
    const id = scope === 'user' ? userId : scope;
    await registry.createCollection({
      id,
      logicalId: scope === 'user' ? 'skills' : id,
      displayName: id,
      description: '',
      scope,
      owner: 'alice',
    });
    await registry.addDocument(id, { id: 'r', text: 'hello', metadata: {} });
  }
  const skills = await buildSkillsPool().listSkills();
  if (!skills.ok) throw skills.error;
  const informational = skills.value.find((s) => s.meta.kind !== 'base');
  skill = informational ? skillId(informational) : '';
  expect(skill).not.toBe('');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-nan']) req.body = { trust: Number.NaN };
    next();
  });
  registerRagRoutes(app, registry);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  jest.restoreAllMocks();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});
const rest = (
  collection: string,
  trust: number | string | null,
  record?: string,
) =>
  fetch(
    `${base}/rag/collections/${collection}${record ? `/documents/${encodeURIComponent(record)}/trust` : ''}`,
    {
      method: record ? 'PATCH' : 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-clh-session': 'test-rag-session',
        Cookie: 'clh_session=test-rag-session',
        ...(typeof trust === 'number' && Number.isNaN(trust)
          ? { 'x-test-nan': '1' }
          : {}),
      },
      body: JSON.stringify({ trust }),
    },
  );
const mcp = (
  collection: string,
  trust: number | string | null,
  record?: string,
) =>
  callRag(registry, record ? 'record_set_trust' : 'collection_set_trust', {
    collection,
    trust,
    ...(record ? { record } : {}),
  });

test.each(['5', 4.55, -1, 5.1, Number.NaN])(
  'REST and MCP reject invalid trust %s on both setters',
  async (value) => {
    for (const record of [undefined, 'r']) {
      const response = await rest('global', value, record);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'INVALID_TRUST' },
      });
      expect(
        (await mcp('global', value, record)).structuredContent,
      ).toMatchObject({ error: { code: 'INVALID_TRUST' } });
    }
  },
);
test('collection null is invalid; record null clears and history records every change', async () => {
  expect((await rest('global', null)).status).toBe(400);
  expect((await mcp('global', null)).structuredContent).toMatchObject({
    error: { code: 'INVALID_TRUST' },
  });
  expect((await rest('global', 3)).status).toBe(200);
  expect((await mcp('global', 2, 'r')).isError).toBeUndefined();
  expect((await registry.getDocument('global', 'r'))?.metadata._trust).toBe(2);
  expect((await rest('global', null, 'r')).status).toBe(200);
  const doc = await registry.getDocument('global', 'r');
  expect(doc?.metadata._trust).toBeUndefined();
  expect(doc?.metadata._trustHistory).toEqual([
    expect.objectContaining({ from: null, to: 2, actor: 'alice' }),
    expect.objectContaining({ from: 2, to: null }),
  ]);
  expect((await registry.getCollection('global'))?.trustHistory).toHaveLength(
    1,
  );
});
test('virtual source and record setters are live, siblings inherit, real skills collection is unaffected', async () => {
  expect((await rest('@skills', 3)).status).toBe(200);
  expect((await mcp('@skills', 2, skill)).isError).toBeUndefined();
  expect(await registry.trustResolver?.skill(skill)).toBe(2);
  expect(await registry.trustResolver?.skill('sibling')).toBe(3);
  expect((await rest('@skills', null, skill)).status).toBe(200);
  expect(await registry.trustResolver?.skill(skill)).toBe(3);
  expect(await store.getRecordHistory('skills', skill)).toHaveLength(2);
  expect(
    (await fetch(`${base}/rag/collections/${userId}/documents`)).status,
  ).toBe(200);
  expect(
    (await callRag(registry, 'collection_records', { collection: 'skills' }))
      .isError,
  ).toBeUndefined();
  expect((await registry.getCollection(userId))?.trust).toBeUndefined();
  expect(await (await fetch(`${base}/rag/collections`)).json()).toMatchObject({
    collections: expect.arrayContaining([
      expect.objectContaining({
        id: '@skills',
        trustClass: 'global',
        trust: 3,
      }),
    ]),
  });
});
test('non-admin sees tools but receives FORBIDDEN', async () => {
  mockIdentity.admin = false;
  expect(eligibleRagTools()).toEqual(
    expect.arrayContaining(['collection_set_trust', 'record_set_trust']),
  );
  for (const record of [undefined, 'r']) {
    expect((await rest('global', 3, record)).status).toBe(403);
    expect((await mcp('global', 3, record)).structuredContent).toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
  }
});
test('user sources are fixed for admins', async () => {
  expect((await rest(userId, 3)).status).toBe(409);
  expect((await mcp('skills', 3)).structuredContent).toMatchObject({
    error: { code: 'TRUST_FIXED' },
  });
});
test('trust tools share write catalogue eligibility and read-only hiding', () => {
  expect(buildRagToolSchemas().map((t) => t.function.name)).toEqual(
    eligibleRagTools(),
  );
  for (const name of ['collection_set_trust', 'record_set_trust'] as const) {
    expect(ragToolEffect(name)).toBe('write');
    runWithReadOnlyTools(() => expect(eligibleRagTools()).not.toContain(name));
  }
});

test.each([
  { scope: 'user', preset: true },
  { scope: 'session', sessionId: 'test-rag-session' },
  { scope: 'global', collectionKind: 'agents' },
] as const)(
  'fixed source %j returns TRUST_FIXED through both dispatchers',
  async (meta) => {
    await registry.createCollection({
      id: 'fixed',
      logicalId: 'fixed',
      displayName: 'fixed',
      description: '',
      owner: 'alice',
      ...meta,
    });
    for (const record of [undefined, 'r']) {
      const response = await rest('fixed', 3, record);
      expect(response.status).toBe(409);
      expect((await mcp('fixed', 3, record)).structuredContent).toMatchObject({
        error: { code: 'TRUST_FIXED' },
      });
    }
  },
);
test.each([true, false])(
  'hidden agent copies remain NOT_FOUND, admin=%s',
  async (admin) => {
    mockIdentity.admin = admin;
    for (const [id, owner, agentsCopyPending] of [
      ['pending', 'alice', true],
      ['foreign', 'bob', false],
    ] as const) {
      const physical = userCollectionId(id, owner);
      await registry.createCollection({
        id: physical,
        logicalId: id,
        displayName: id,
        description: '',
        scope: 'user',
        owner,
        collectionKind: 'agents',
        agentsCopyPending,
      });
      for (const record of [undefined, 'r']) {
        const response = await rest(physical, 3, record);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          error: { code: 'NOT_FOUND' },
        });
        expect(
          (await mcp(physical, 3, record)).structuredContent,
        ).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
    }
  },
);
test('admin sees another owner ordinary collection but trust stays fixed', async () => {
  const id = userCollectionId('other', 'bob');
  await registry.createCollection({
    id,
    logicalId: 'other',
    displayName: 'Other',
    description: '',
    scope: 'user',
    owner: 'bob',
  });
  expect((await rest(id, 3)).status).toBe(409);
  expect((await mcp(id, 3)).structuredContent).toMatchObject({
    error: { code: 'TRUST_FIXED' },
  });
});
test('base skills are fixed and missing skill/collection/record is NOT_FOUND', async () => {
  const pool = buildSkillsPool();
  const list = await pool.listSkills();
  if (!list.ok) throw list.error;
  const first = list.value[0];
  if (!first) throw new Error('missing skill');
  jest.spyOn(skillsPool, 'buildSkillsPool').mockReturnValue(pool);
  jest.spyOn(pool, 'listSkills').mockImplementation(async () => ({
    ok: true,
    value: [{ ...first, meta: { ...first.meta, kind: 'base' } }],
  }));
  expect((await rest('@skills', 3, skillId(first))).status).toBe(409);
  expect(
    (await mcp('@skills', 3, skillId(first))).structuredContent,
  ).toMatchObject({ error: { code: 'TRUST_FIXED' } });
  for (const [collection, record] of [
    ['@skills', 'absent'],
    ['global', 'absent'],
    ['absent', undefined],
  ] as const) {
    expect((await rest(collection, 3, record)).status).toBe(404);
    expect((await mcp(collection, 3, record)).structuredContent).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  }
});
test('profile ceilings hide trust tools like other writes', () => {
  runWithProfileTools(new AgentToolPermissions(['rag_read']), () => {
    expect(eligibleRagTools()).toEqual(['rag_read']);
    expect(buildRagToolSchemas().map((t) => t.function.name)).toEqual([
      'rag_read',
    ]);
  });
});

test('record trust writes touch only their own record and virtual store key', async () => {
  await registry.addDocument('global', {
    id: 'sibling',
    text: 'untouched',
    metadata: {},
  });
  const write = jest.spyOn(InMemoryRag.prototype, 'upsert');
  expect((await mcp('global', 2, 'r')).isError).toBeUndefined();
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[1]?.id).toBe('doc:global:r');
  expect(
    (await registry.getDocument('global', 'sibling'))?.metadata._trust,
  ).toBeUndefined();
  const sourceWrite = jest.spyOn(store, 'setSource');
  const recordWrite = jest.spyOn(store, 'setRecord');
  expect((await mcp('@skills', 3)).isError).toBeUndefined();
  expect(sourceWrite).toHaveBeenCalledTimes(1);
  expect(sourceWrite).toHaveBeenCalledWith('skills', 3, 'alice');
  expect(recordWrite).not.toHaveBeenCalled();
  sourceWrite.mockClear();
  expect((await rest('@skills', 2, skill)).status).toBe(200);
  expect(recordWrite).toHaveBeenCalledTimes(1);
  expect(recordWrite).toHaveBeenCalledWith('skills', skill, 2, 'alice');
  expect(sourceWrite).not.toHaveBeenCalled();
  expect((await mcp('@skills', null, skill)).isError).toBeUndefined();
  expect(await registry.trustResolver?.skill(skill)).toBe(3);
});

test('REST and MCP address same-name skills by id and model reads use the override', async () => {
  const make = (id: string, kind: string) => ({
    name: 'Shared display name',
    description: '',
    meta: { id, kind, name: 'Shared display name', description: '' },
    getContent: async () => ({ ok: true as const, value: 'body' }),
    listResources: async () => ({ ok: true as const, value: [] }),
    readResource: async () => ({ ok: true as const, value: '' }),
  });
  const pool = new CompositeSkillManager(
    [
      {
        source: 'plugin',
        manager: {
          listSkills: async () => ({
            ok: true,
            value: [make('base-id', 'base'), make('info-id', 'informational')],
          }),
          getSkill: async () => ({ ok: true, value: undefined }),
          matchSkills: async () => ({ ok: true, value: [] }),
        },
      },
    ],
    () => {
      if (!registry.trustResolver) throw new Error('missing resolver');
      return registry.trustResolver;
    },
  );
  jest.spyOn(skillsPool, 'buildSkillsPool').mockReturnValue(pool);
  for (const transport of ['rest', 'mcp'] as const) {
    if (transport === 'rest') {
      expect((await rest('@skills', 2, 'info-id')).status).toBe(200);
      expect((await rest('@skills', 2, 'Shared display name')).status).toBe(
        404,
      );
      expect((await rest('@skills', 2, 'base-id')).status).toBe(409);
    } else {
      expect((await mcp('@skills', 1, 'info-id')).isError).toBeUndefined();
      for (const [id, code] of [
        ['Shared display name', 'NOT_FOUND'],
        ['base-id', 'TRUST_FIXED'],
      ])
        expect((await mcp('@skills', 2, id)).structuredContent).toMatchObject({
          error: { code },
        });
    }
    const read = await pool.informationalSkills().getSkill('info-id');
    if (!read.ok) throw read.error;
    expect(await read.value?.getContent()).toMatchObject({
      value: `[source: global:skills/info-id; trust ${transport === 'rest' ? 2 : 1}]\nbody`,
    });
  }
  expect(await store.getRecordHistory('skills', 'base-id')).toEqual([]);
});

test.each(['fallback', 'cross-source'] as const)(
  'ambiguous %s skills are NOT_FOUND for REST and MCP trust setters',
  async (collision) => {
    const make = (body: string) => ({
      name: 'duplicate',
      description: '',
      meta: { name: 'duplicate', description: '' },
      getContent: async () => ({ ok: true as const, value: body }),
      listResources: async () => ({ ok: true as const, value: [] }),
      readResource: async () => ({ ok: true as const, value: '' }),
    });
    const pool = new CompositeSkillManager([
      {
        source: 'plugin',
        manager: {
          listSkills: async () => ({
            ok: true,
            value:
              collision === 'fallback'
                ? [make('one'), make('two')]
                : [make('one')],
          }),
          getSkill: async () => ({ ok: true, value: undefined }),
          matchSkills: async () => ({ ok: true, value: [] }),
        },
      },
      ...(collision === 'cross-source'
        ? [
            {
              source: 'preset',
              manager: {
                listSkills: async () => ({
                  ok: true as const,
                  value: [
                    {
                      ...make('two'),
                      meta: { ...make('two').meta, id: 'plugin/duplicate' },
                    },
                  ],
                }),
                getSkill: async () => ({ ok: true as const, value: undefined }),
                matchSkills: async () => ({ ok: true as const, value: [] }),
              },
            },
          ]
        : []),
    ]);
    jest.spyOn(skillsPool, 'buildSkillsPool').mockReturnValue(pool);
    expect((await rest('@skills', 2, 'plugin/duplicate')).status).toBe(404);
    expect(
      (await mcp('@skills', 2, 'plugin/duplicate')).structuredContent,
    ).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(await store.getRecord('skills', 'plugin/duplicate')).toBeUndefined();
  },
);

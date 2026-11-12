const mockIdentity = { id: 'a1', admin: true, is: () => mockIdentity.admin };
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    context: { user: mockIdentity },
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  },
}));
jest.mock('../../srv/agent-manager', () => ({
  getCollectionRegistry: jest.fn(),
  getQueryEmbedder: () => undefined,
  isProvidersReady: () => false,
  forgetSessionDestination: () => {},
}));

import {
  type SmartAgentRagStores,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { getCollectionRegistry } from '../../srv/agent-manager';
import { executeRagTool, type RagMcpTool } from '../../srv/agent-mcp-rag';
import { userCollectionId } from '../../srv/collection-ids';
import { collectionRetrieval } from '../../srv/lib/collection-retrieval';
import { createHubRagAccess, initHubRagAccess } from '../../srv/lib/rag-access';
import { CollectionRegistry } from '../../srv/rag-collections';
import { registerRagRoutes } from '../../srv/rag-handler';
import { liveSession } from './helpers/canonical-rag';
import { makeMockRouter, makeReq, runIdRoute } from './helpers/rag-routes';

let registry: CollectionRegistry;
const id = userCollectionId('notes', 'u1');
beforeEach(async () => {
  mockIdentity.id = 'a1';
  mockIdentity.admin = true;
  initHubRagAccess(createHubRagAccess(null, 'in-memory'));
  registry = new CollectionRegistry();
  jest.mocked(getCollectionRegistry).mockReturnValue(registry);
  await registry.createCollection({
    id,
    logicalId: 'notes',
    displayName: 'Notes',
    description: '',
    scope: 'user',
    owner: 'u1',
  });
  await registry.addDocument(id, {
    id: 'record',
    text: 'needle private knowledge',
    metadata: {},
  });
});

function tool(userId: string, admin: boolean, name: RagMcpTool, input: object) {
  return executeRagTool(
    {
      registry,
      userId,
      admin,
      sessionKey: liveSession(userId, `isolation-${userId}`),
      internal: true,
      trustedAdmission: false,
      permissions: { allows: () => true },
      readOnly: false,
      channel: 'mcp-agent',
    },
    name,
    input,
  );
}

test("MCP_Admin cannot read another user's collection", async () => {
  const result = await tool('a1', true, 'rag_search', {
    query: 'needle',
    collections: [id],
  });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('Collection not found');
  const { router, routes } = makeMockRouter();
  registerRagRoutes(router, registry);
  {
    const response = await runIdRoute(
      routes,
      'POST',
      '/rag/collections/:id/query',
      makeReq({
        params: { id },
        method: 'POST',
        path: '/query',
        headers: { 'x-clh-session': liveSession('a1', 'isolation-a1') },
        body: { query: 'needle' },
      }),
    );
    expect(response._status).toBe(404);
  }
});

test('MCP_Admin can write a global collection; a user cannot', async () => {
  await registry.createCollection({
    id: 'shared__global',
    logicalId: 'shared__global',
    displayName: 'Shared',
    description: '',
    scope: 'global',
  });
  const denied = await tool('u1', false, 'collection_set_trust', {
    collection: 'shared__global',
    trust: 4,
  });
  expect(denied.isError).toBe(true);
  const allowed = await tool('a1', true, 'collection_set_trust', {
    collection: 'shared__global',
    trust: 4,
  });
  expect(allowed).not.toHaveProperty('isError', true);
  expect((await registry.getCollection('shared__global'))?.trust).toBe(4);
  for (const [userId, admin] of [
    ['u1', false],
    ['a1', true],
  ] as const) {
    const result = await tool(userId, admin, 'record_add', {
      collection: 'shared__global',
      record: `mcp-${userId}`,
      text: 'Shared MCP knowledge',
    });
    expect(result.isError === true).toBe(!admin);
    expect(
      Boolean(await registry.getDocument('shared__global', `mcp-${userId}`)),
    ).toBe(admin);
  }
  const { router, routes } = makeMockRouter();
  registerRagRoutes(router, registry);
  for (const [userId, admin] of [
    ['u1', false],
    ['a1', true],
  ] as const) {
    mockIdentity.id = userId;
    mockIdentity.admin = admin;
    const response = await runIdRoute(
      routes,
      'POST',
      '/rag/collections/:id/documents',
      makeReq({
        sessionId: liveSession(userId, `isolation-${userId}`),
        params: { id: 'shared__global' },
        method: 'POST',
        path: '/documents',
        body: { id: `written-${userId}`, text: 'Shared knowledge' },
      }),
    );
    expect(response._status).toBe(admin ? 201 : 403);
    expect(
      Boolean(
        await registry.getDocument('shared__global', `written-${userId}`),
      ),
    ).toBe(admin);
  }
});

test('a user collection without record userId is visible to its owner only', async () => {
  expect(
    (await registry.getDocument(id, 'record'))?.metadata.userId,
  ).toBeUndefined();
  for (const [userId, admin] of [
    ['u1', false],
    ['u2', false],
    ['a1', true],
  ] as const) {
    const result = await tool(userId, admin, 'rag_search', {
      query: 'needle',
      collections: [id],
    });
    if (userId === 'u1') {
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toContain('needle private knowledge');
    } else {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('needle private knowledge');
    }
    const agent = { deps: { ragStores: {} as SmartAgentRagStores } };
    const retrieval = collectionRetrieval(agent);
    const response = await retrieval.retrieve(
      { headers: { 'x-rag-collections': id }, body: {} },
      [{ role: 'user', content: 'needle' }],
      userId,
      liveSession(userId, `isolation-${userId}`),
      cds.log('isolation'),
    );
    expect(JSON.stringify(response).includes('needle private knowledge')).toBe(
      userId === 'u1',
    );
    retrieval.restore();
  }
});

test('retrieval passes owner-bound entries', async () => {
  const agent = { deps: { ragStores: {} as SmartAgentRagStores } };
  const retrieval = collectionRetrieval(agent);
  await retrieval.retrieve(
    { headers: { 'x-rag-collections': id }, body: {} },
    [],
    'u1',
    liveSession('u1', 'isolation-u1'),
    cds.log('isolation'),
  );
  const pipeline = jest.fn((stores: SmartAgentRagStores) => stores);
  expect(pipeline(agent.deps.ragStores)[id]).toEqual({
    name: id,
    rag: expect.objectContaining({}),
    owner: { scope: 'user', userId: 'u1' },
  });
  const rows = await agent.deps.ragStores[id].rag.query(
    new TextOnlyEmbedding('needle'),
    3,
  );
  if (!rows.ok) throw rows.error;
  expect(rows.value[0].metadata).toMatchObject({
    ownerScope: 'user',
    userId: 'u1',
  });
  expect(
    (await registry.getDocument(id, 'record'))?.metadata.userId,
  ).toBeUndefined();
  retrieval.restore();
  expect(agent.deps.ragStores).toEqual({});
});

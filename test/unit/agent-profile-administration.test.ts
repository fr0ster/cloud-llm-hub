import { createServer, type Server } from 'node:http';
import express from 'express';
import { z } from 'zod';
import { userCollectionId } from '../../srv/collection-ids';
import { AgentProfileSource } from '../../srv/lib/agent-profile-source';
import { collectionAccessError } from '../../srv/lib/collection-access';
import {
  collectionEnabled,
  setCollectionOverride,
} from '../../srv/lib/collection-toggle';
import { withCollectionToolScope } from '../../srv/lib/collection-write-scope';
import {
  CollectionRegistry,
  type RagDocument,
} from '../../srv/rag-collections';
import { registerRagRoutes } from '../../srv/rag-handler';
import { dispatchRagTool } from '../../srv/rag-tool-dispatcher';
import { runWithSessionId } from '../../srv/request-session';

const mockIdentity = { id: 'alice', admin: false };
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return { user: { id: mockIdentity.id, is: () => mockIdentity.admin } };
      },
    },
  }),
  { virtual: true },
);

let registry: CollectionRegistry;
let server: Server;
let base: string;
const own = userCollectionId('personal-agents', 'alice');
const profile = (name = 'analyst', enabled = true): RagDocument => ({
  id: name,
  text: 'private prompt body',
  createdAt: '',
  metadata: {
    canonicalKey: name,
    name,
    kind: 'profile',
    description: 'private description',
    tools: 'read-only',
    result: 'report',
    enabled,
  },
});
async function copy() {
  return registry.copyAgentCollection('agents', {
    id: own,
    logicalId: 'personal-agents',
    displayName: 'My agents',
    description: '',
    scope: 'user',
    owner: 'alice',
    collectionKind: 'agents',
  });
}
function source(id: string, userId = 'alice') {
  return new AgentProfileSource(registry, {
    userId,
    globalCollectionId: 'agents',
    selectedCollectionId: () => id,
    plannerRecord: 'planner',
    timeoutMs: 1000,
  });
}
async function request(path: string, method = 'GET', body?: object) {
  return fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(async () => {
  mockIdentity.id = 'alice';
  mockIdentity.admin = false;
  registry = new CollectionRegistry();
  await registry.createCollection({
    id: 'agents',
    logicalId: 'agents',
    displayName: 'Agents',
    description: '',
    scope: 'global',
    collectionKind: 'agents',
  });
  await registry.addDocument('agents', profile());
  await registry.addDocument('agents', profile('disabled', false));
  const app = express();
  app.use(express.json());
  registerRagRoutes(app, registry);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('REST copies current bodies and flags, with independent identities', async () => {
  const response = await request('/rag/collections', 'POST', {
    id: 'personal-agents',
    displayName: 'Mine',
    copyFrom: 'agents',
  });
  expect(response.status).toBe(201);
  const copied = await registry.readAgentCollection(own);
  expect(
    copied?.documents.map((document) => ({
      id: document.id,
      text: document.text,
      enabled: document.metadata.enabled,
    })),
  ).toEqual([
    { id: 'analyst', text: 'private prompt body', enabled: true },
    { id: 'disabled', text: 'private prompt body', enabled: false },
  ]);
  await registry.updateDocument('agents', 'analyst', { text: 'global edit' });
  expect((await registry.getDocument(own, 'analyst'))?.text).toBe(
    'private prompt body',
  );
  expect(await source(own).list()).toMatchObject({
    ok: true,
    value: [{ name: 'analyst' }],
  });
});

test('failed copy never lists or selects partial configuration, even when cleanup fails', async () => {
  const add = jest.spyOn(registry, 'addDocument');
  add.mockRejectedValueOnce(new Error('backend failed'));
  jest
    .spyOn(registry, 'deleteCollection')
    .mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(copy()).rejects.toThrow('backend failed');
  expect(await registry.listCollections('alice')).not.toContainEqual(
    expect.objectContaining({ id: own }),
  );
  expect(await source(own).list()).toMatchObject({ ok: false });
});

test('whole-copy validation precedes destination publication', async () => {
  const read = jest.spyOn(registry, 'readAgentCollection');
  const global = await registry.getCollection('agents');
  if (!global) throw new Error('Missing source');
  read.mockResolvedValueOnce({
    meta: global,
    documents: [profile(), { ...profile('broken'), metadata: {} }],
  });
  await expect(copy()).rejects.toThrow('Invalid agent record');
  expect(await registry.getCollection(own)).toBeNull();
});

test('global REST writes require admin; owner writes and canonical create/update are strict', async () => {
  const record = profile('custom');
  const input = { id: record.id, text: '', metadata: record.metadata };
  expect(
    (await request('/rag/collections/agents/documents', 'POST', input)).status,
  ).toBe(403);
  mockIdentity.admin = true;
  expect(
    (await request('/rag/collections/agents/documents', 'POST', input)).status,
  ).toBe(201);
  expect(
    (await request('/rag/collections/agents/documents', 'POST', input)).status,
  ).toBe(409);
  expect(
    (
      await request('/rag/collections/agents/documents/custom', 'PUT', {
        ...input,
        id: 'other',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request('/rag/collections/agents/documents/custom', 'PUT', {
        ...input,
        metadata: { ...input.metadata, privilege: 'admin' },
      })
    ).status,
  ).toBe(400);
  await copy();
  mockIdentity.admin = false;
  expect(
    (
      await request(`/rag/collections/${own}/documents/custom`, 'PUT', {
        ...input,
        text: 'own edit',
      })
    ).status,
  ).toBe(200);
  expect((await registry.getDocument(own, 'custom'))?.text).toBe('own edit');
  mockIdentity.id = 'bob';
  mockIdentity.admin = true;
  expect(
    (await request(`/rag/collections/${own}/documents/custom`, 'PUT', input))
      .status,
  ).toBe(404);
  expect(
    collectionAccessError(
      { scope: 'user', owner: 'alice', collectionKind: 'agents' },
      'bob',
      true,
      'write',
    )?.status,
  ).toBe(404);
});

test('agents imports and toggles are rejected; collection toggles cannot disable profile reads', async () => {
  await copy();
  for (const path of [
    'upload',
    'documents/bulk',
    'documents/enabled',
    'enabled',
  ]) {
    const method = path.includes('enabled') ? 'PATCH' : 'POST';
    expect(
      (
        await request(`/rag/collections/${own}/${path}`, method, {
          enabled: false,
          content: 'body',
          documents: [profile()],
        })
      ).status,
    ).toBe(400);
  }
  setCollectionOverride('alice', 'session', own, false);
  await registry.setEnabled('alice', own, false);
  const meta = await registry.getCollection(own);
  if (!meta) throw new Error('Missing copy');
  expect(collectionEnabled(registry, 'alice', 'session', meta)).toBe(true);
  expect(await source(own).get('analyst')).toMatchObject({ ok: true });
});

test('REST disabled reads expose neither body nor description, including to owner/admin', async () => {
  await copy();
  mockIdentity.admin = true;
  const response = await request(`/rag/collections/${own}/documents/disabled`);
  expect(
    z
      .object({ id: z.string(), enabled: z.boolean(), reason: z.string() })
      .strict()
      .parse(await response.json()),
  ).toEqual({ id: 'disabled', enabled: false, reason: 'record-disabled' });
  const listing = await request(`/rag/collections/${own}/documents`);
  const text = await listing.text();
  expect(text.match(/private prompt body/g)).toHaveLength(1);
});

test('LLM writes to user copies and globals fail before mutation, including indirect registry paths', async () => {
  await copy();
  mockIdentity.admin = true;
  for (const collection of ['agents', 'personal-agents', own]) {
    for (const [name, args] of [
      ['rag_add', { collection, id: 'forged', text: 'forged' }],
      [
        'rag_correct',
        { collection, id: 'analyst', newText: 'forged', reason: 'test' },
      ],
      ['rag_deprecate', { collection, id: 'analyst', reason: 'test' }],
    ] as const) {
      const result = await runWithSessionId(
        'session',
        () => dispatchRagTool(registry, name, args),
        undefined,
        'alice',
      );
      expect(result).toMatchObject({ ok: false });
    }
  }
  const mutations: (() => Promise<void>)[] = [
    async () => {
      await registry.deleteCollection(own);
    },
    async () => {
      await registry.updateCollection(own, { displayName: 'forged' });
    },
    async () => {
      await registry.setEnabled('alice', own, false);
    },
    async () => {
      await registry.setDocumentEnabled(own, 'analyst', false);
    },
    async () => {
      await registry.addDocumentsBulk(own, [profile('forged')]);
    },
    async () => {
      await registry.copyAgentCollection('agents', {
        id: 'forged',
        logicalId: 'forged',
        displayName: '',
        description: '',
        scope: 'user',
        owner: 'alice',
        collectionKind: 'agents',
      });
    },
  ];
  for (const mutation of mutations)
    await expect(withCollectionToolScope(mutation)).rejects.toThrow(
      'TOOL_FORBIDDEN',
    );
  expect((await registry.getDocument(own, 'analyst'))?.metadata.enabled).toBe(
    true,
  );
  expect(await registry.getDocument(own, 'forged')).toBeNull();
});

test('concurrent canonical creates produce one success without replacement', async () => {
  await copy();
  const document = profile('concurrent');
  const results = await Promise.allSettled([
    registry.createAgentRecord(own, document),
    registry.createAgentRecord(own, { ...document, text: 'second body' }),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
  ]);
  expect((await registry.getDocument(own, 'concurrent'))?.text).toBe(
    'private prompt body',
  );
});

test.each(['analyst', 'disabled'])(
  'REST uses authoritative bodies for %s despite stale cached flags',
  async (id) => {
    const current = await registry.readAgentCollection('agents');
    if (!current) throw new Error('Missing agents');
    const documents = current.documents.map((document) => ({
      ...document,
      metadata: { ...document.metadata, enabled: document.id === 'disabled' },
    }));
    const read = jest
      .spyOn(registry, 'readAgentCollection')
      .mockResolvedValue({ meta: current.meta, documents });
    try {
      const response = await request(`/rag/collections/agents/documents/${id}`);
      expect(response.status).toBe(200);
      const body: object = await response.json();
      if (id === 'analyst')
        expect(body).toEqual({ id, enabled: false, reason: 'record-disabled' });
      else
        expect(body).toMatchObject({
          id,
          text: 'private prompt body',
          enabled: true,
        });
      const list = await request('/rag/collections/agents/documents');
      const parsed = z
        .object({
          documents: z.array(
            z.object({
              id: z.string(),
              text: z.string().optional(),
              enabled: z.boolean(),
            }),
          ),
        })
        .parse(await list.json());
      expect(
        parsed.documents.find((document) => document.id === 'analyst'),
      ).toEqual({ id: 'analyst', enabled: false });
      expect(
        parsed.documents.find((document) => document.id === 'disabled'),
      ).toMatchObject({ text: 'private prompt body', enabled: true });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
    }
  },
);

test('worker readback uses current agent records for bodies and titles', async () => {
  await copy();
  const meta = await registry.getCollection(own);
  if (!meta) throw new Error('Missing agents');
  jest.spyOn(registry, 'readAgentCollection').mockResolvedValue({
    meta,
    documents: [profile('analyst', false)],
  });
  for (const args of [
    { collection: 'personal-agents', id: 'analyst' },
    { collection: 'personal-agents' },
  ]) {
    const result = await runWithSessionId(
      'session',
      () => dispatchRagTool(registry, 'rag_list', args),
      undefined,
      'alice',
    );
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain('record-disabled');
    expect(JSON.stringify(result)).not.toContain('private');
  }
});

test('disabling an agent returns only an acknowledgement', async () => {
  await copy();
  const response = await request(
    `/rag/collections/${own}/documents/analyst/enabled`,
    'PATCH',
    { enabled: false },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: 'analyst',
    enabled: false,
    reason: 'record-disabled',
  });
});

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      context: { user: { id: 'alice', is: () => true } },
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    },
  }),
  { virtual: true },
);

import { createServer, type Server } from 'node:http';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import express from 'express';
import { z } from 'zod';
import { userCollectionId } from '../../srv/collection-ids';
import { loadSkillFromDir } from '../../srv/lib/filesystem-skill';
import { buildSkillsPool, SKILLS_DIR } from '../../srv/lib/skills-pool';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';
import { CollectionRegistry } from '../../srv/rag-collections';
import { registerRagRoutes } from '../../srv/rag-handler';
import { callRag } from './helpers/canonical-rag';

let registry: CollectionRegistry;
let store: TrustStore;
let server: Server;
let base: string;
const id = userCollectionId('trust-rest', 'alice');
beforeEach(async () => {
  registry = new CollectionRegistry();
  store = new TrustStore(new InMemoryRag(), 3);
  registry.trustResolver = new TrustResolver(
    registry,
    store,
    parseTrustDefaults(undefined),
  );
  await registry.createCollection({
    id,
    logicalId: 'trust-rest',
    displayName: 'Trust Notes',
    description: '',
    scope: 'user',
    owner: 'alice',
    trust: 4,
  });
  await registry.addDocument(id, {
    id: 'r',
    text: 'hello',
    metadata: { source: 'file.txt' },
  });
  const app = express();
  app.use(express.json());
  registerRagRoutes(app, registry);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
const listing = () =>
  fetch(`${base}/rag/collections/${id}/documents`).then((response) =>
    response.json(),
  );
test('REST catalog list/read projections inherit, override and inherit after clearing', async () => {
  expect(await listing()).toMatchObject({
    documents: [{ trust: 4, source: 'user:Trust Notes/r' }],
  });
  const doc = await registry.getDocument(id, 'r');
  if (!doc) throw new Error('missing document');
  doc.metadata._trust = 1.5;
  expect(await listing()).toMatchObject({
    documents: [{ trust: 1.5, trustOverride: 1.5 }],
  });
  delete doc.metadata._trust;
  const inherited = await listing();
  expect(inherited).toMatchObject({ documents: [{ trust: 4 }] });
  expect(JSON.stringify(inherited)).not.toContain('trustOverride');
  const current = registry.currentMeta(id);
  if (!current) throw new Error('missing meta');
  current.trust = 5;
  expect(await listing()).toMatchObject({ documents: [{ trust: 5 }] });
  expect(
    await (await fetch(`${base}/rag/collections/${id}/documents/r`)).json(),
  ).toMatchObject({ trust: 5, metadata: { source: 'file.txt' } });
});
test('REST and MCP virtual skill reads resolve live source and record trust', async () => {
  const skills = await buildSkillsPool().listSkills();
  if (!skills.ok) throw skills.error;
  const name = skills.value.find((skill) => skill.meta.kind !== 'base')?.name;
  if (!name) throw new Error('missing informational skill');
  const original = await loadSkillFromDir(
    `${SKILLS_DIR}/${name}`,
  )?.getContent();
  if (!original?.ok) throw new Error('missing original skill body');
  const read = () =>
    fetch(
      `${base}/rag/collections/@skills/documents/${encodeURIComponent(name)}`,
    ).then((response) => response.json());
  await store.setSource('skills', 4, 'admin');
  expect(await read()).toMatchObject({
    trust: 4,
    source: `global:skills/${name}`,
  });
  await store.setRecord('skills', name, 1.5, 'admin');
  expect(await read()).toMatchObject({ trust: 1.5, trustOverride: 1.5 });
  const mcp = await callRag(registry, 'rag_read', {
    collection: '@skills',
    id: name,
  });
  expect(z.json().parse(JSON.parse(mcp.content[0].text))).toMatchObject({
    text: original.value.slice(0, 8000),
    attributes: {
      trust: 1.5,
      trustOverride: 1.5,
      source: `global:skills/${name}`,
    },
  });
  expect(JSON.parse(mcp.content[0].text).text).not.toMatch(/^\[source:/);
  const records = await callRag(registry, 'collection_records', {
    collection: '@skills',
  });
  expect(JSON.parse(records.content[0].text)).toMatchObject({
    records: expect.arrayContaining([
      expect.objectContaining({
        id: name,
        title: original.value.split(/\r?\n/, 1)[0].slice(0, 120),
      }),
    ]),
  });
  await store.setSource('skills', 5, 'admin');
  await store.setRecord('skills', name, null, 'admin');
  expect(await read()).toMatchObject({ trust: 5 });
  expect(JSON.stringify(await read())).not.toContain('trustOverride');
});
test('upload strips spoofed trust while keeping filename, grouping and source toggles', async () => {
  const response = await fetch(`${base}/rag/collections/${id}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'notes.txt',
      content: 'first paragraph\n\nsecond paragraph',
      chunkSize: 18,
      metadata: { trust: 5, trustHistory: [], _trust: 5, _trustHistory: [] },
    }),
  });
  expect(response.status).toBe(200);
  const documents = await registry.listDocuments(id);
  const chunks =
    documents?.documents.filter((doc) => doc.metadata.source === 'notes.txt') ??
    [];
  expect(chunks.length).toBeGreaterThan(1);
  const uploadId = chunks[0]?.metadata.uploadId;
  if (typeof uploadId !== 'string') throw new Error('missing upload id');
  for (const chunk of chunks) {
    expect(chunk.metadata).toMatchObject({ source: 'notes.txt', uploadId });
    for (const key of ['trust', 'trustHistory', '_trust', '_trustHistory'])
      expect(chunk.metadata).not.toHaveProperty(key);
  }
  await registry.setSourceEnabled(id, 'notes.txt', uploadId, false);
  expect(
    (await registry.listDocuments(id))?.documents
      .filter((doc) => doc.metadata.source === 'notes.txt')
      .every((doc) => !doc.enabled),
  ).toBe(true);
});

test('agent preset collections and hidden records carry only trusted false', async () => {
  await registry.createCollection({
    id: 'agents',
    logicalId: 'agents',
    displayName: 'Agents',
    description: '',
    scope: 'global',
    collectionKind: 'agents',
  });
  await registry.addDocument('agents', {
    id: 'coordinator',
    text: 'PRIVATE',
    metadata: {
      canonicalKey: 'coordinator',
      kind: 'coordinator',
      name: 'coordinator',
      enabled: false,
      trust: { user: 5 },
    },
  });
  const collections = await (await fetch(`${base}/rag/collections`)).json();
  expect(collections).toMatchObject({
    collections: expect.arrayContaining([
      expect.objectContaining({ id: 'agents', trusted: false }),
    ]),
  });
  const hidden = await (
    await fetch(`${base}/rag/collections/agents/documents/coordinator`)
  ).json();
  expect(hidden).toEqual({
    id: 'coordinator',
    enabled: false,
    trusted: false,
    reason: 'record-disabled',
  });
  const read = await callRag(registry, 'rag_read', {
    collection: 'agents',
    id: 'coordinator',
  });
  expect(z.json().parse(JSON.parse(read.content[0].text))).toMatchObject({
    attributes: { enabled: false, trusted: false },
  });
  expect(read.content[0].text).not.toContain('PRIVATE');
  expect(read.content[0].text).not.toContain('"trust":');
  const records = await callRag(registry, 'collection_records', {
    collection: 'agents',
  });
  expect(z.json().parse(JSON.parse(records.content[0].text))).toMatchObject({
    records: [
      { id: 'coordinator', attributes: { enabled: false, trusted: false } },
    ],
  });
});

import { validateRagAttributes } from '@mcp-abap-adt/llm-agent';
import type { AgentProfileRecord } from '../../srv/lib/agent-profile-records';
import {
  type AgentProfileSeedStore,
  loadAgentProfileSeeds,
  parseAgentProfileSeeds,
  seedAgentProfiles,
} from '../../srv/lib/agent-profile-seeds';
import {
  decodeRecord,
  encodeAttributes,
  storeNameFor,
} from '../../srv/lib/collection-persistence';
import type { RagDocument } from '../../srv/rag-collections';
import { CollectionRegistry } from '../../srv/rag-collections';

function store() {
  const documents = new Map<string, RagDocument>();
  const upsert = jest.fn<
    ReturnType<AgentProfileSeedStore['upsert']>,
    Parameters<AgentProfileSeedStore['upsert']>
  >(async (record) => {
    const document = { ...record, createdAt: '' };
    documents.set(record.id, document);
    return document;
  });
  const adapter: AgentProfileSeedStore = {
    ensureGlobal: async () => {},
    read: async () => [...documents.values()],
    upsert,
  };
  return { documents, upsert, adapter };
}
test('shipped seeds validate and executor alone owns storage/retry rules', async () => {
  const seeds = await loadAgentProfileSeeds();
  const checker = seeds.find((record) => record.id === 'checker');
  expect(checker?.text).toContain(
    'The tool trace is evidence of what was actually done',
  );
  expect(checker?.text).toContain(
    'without a matching successful call fails unless verified independently',
  );
  expect(checker?.text).toContain(
    'Unavailable or omitted evidence is not proof that no tools ran',
  );
  expect(seeds.map((record) => record.id).sort()).toEqual([
    '_worker-base',
    'analyst',
    'checker',
    'executor',
    'planner',
  ]);
  for (const record of seeds) {
    expect(record.text.includes('fails twice')).toBe(record.id === 'executor');
    expect(record.text.includes('Storing, collecting or remembering')).toBe(
      record.id === 'executor',
    );
  }
});
test.each([
  ['name: analyst\nname: analyst', 'duplicate YAML key'],
  ['name: analyst\nceiling: all', 'unsupported key'],
  ['name: other', 'filename mismatch'],
  ['name: analyst\nenabled: yes', 'invalid boolean'],
])(
  'invalid frontmatter rejected: %s (%s)',
  (fields: string, _reason: string) => {
    expect(() =>
      parseAgentProfileSeeds([
        {
          filename: 'analyst.md',
          content: `---\nkind: profile\n${fields}\ndescription: desc\ntools: all\nresult: report\n---\nSECRET`,
        },
      ]),
    ).toThrow(/Invalid seed analyst.md:/);
  },
);
test('empty body is preserved and duplicate filenames rejected', () => {
  const file = {
    filename: 'planner.md',
    content: '---\nkind: planner\nname: planner\n---\n',
  };
  expect(parseAgentProfileSeeds([file])[0]?.text).toBe('');
  expect(() => parseAgentProfileSeeds([file, file])).toThrow('duplicate name');
});
test('missing-only insertion preserves edits and disabled records across concurrent startups', async () => {
  const seeds = await loadAgentProfileSeeds();
  const f = store();
  const executor = seeds.find((record) => record.id === 'executor');
  if (!executor) throw new Error('Missing fixture');
  f.documents.set('executor', {
    ...executor,
    text: 'edited',
    metadata: { ...executor.metadata, enabled: false },
    createdAt: '',
  });
  await Promise.all([
    seedAgentProfiles(f.adapter, seeds, 'planner'),
    seedAgentProfiles(f.adapter, seeds, 'planner'),
  ]);
  expect(f.documents.size).toBe(5);
  expect(f.documents.get('executor')).toMatchObject({
    text: 'edited',
    metadata: { enabled: false },
  });
  f.upsert.mockClear();
  await seedAgentProfiles(f.adapter, seeds, 'planner');
  expect(f.upsert).not.toHaveBeenCalled();
});
test('invalid seeds and existing records fail without seed writes; backend failure propagates', async () => {
  const seeds = await loadAgentProfileSeeds();
  const f = store();
  await expect(seedAgentProfiles(f.adapter, [], 'planner')).rejects.toThrow(
    'Missing required',
  );
  expect(f.upsert).not.toHaveBeenCalled();
  f.documents.set('bad', {
    id: 'bad',
    text: 'private',
    metadata: {},
    createdAt: '',
  });
  await expect(seedAgentProfiles(f.adapter, seeds, 'planner')).rejects.toThrow(
    'Invalid agent record',
  );
  expect(f.upsert).not.toHaveBeenCalled();
  f.documents.clear();
  f.upsert.mockRejectedValue(new Error('backend unavailable'));
  await expect(seedAgentProfiles(f.adapter, seeds, 'planner')).rejects.toThrow(
    'backend unavailable',
  );
});
test('memory registry seeds global agents once and excludes configuration from search', async () => {
  const registry = new CollectionRegistry();
  await Promise.all([
    registry.seedAgentConfiguration('agents', 'planner'),
    registry.seedAgentConfiguration('agents', 'planner'),
  ]);
  expect(await registry.getCollection('agents')).toMatchObject({
    scope: 'global',
    collectionKind: 'agents',
    documentCount: 5,
  });
  expect(await registry.getRagStore('agents')).toBeNull();
  expect(await registry.getRagStores(['agents'])).toEqual({});
  const record: AgentProfileRecord | undefined = (
    await loadAgentProfileSeeds()
  ).find((seed) => seed.id === 'executor');
  if (!record) throw new Error('Missing fixture');
  await registry.updateDocument('agents', 'executor', { text: 'edited' });
  await registry.seedAgentConfiguration('agents', 'planner');
  expect(await registry.getDocument('agents', 'executor')).toMatchObject({
    text: 'edited',
  });
});

test('global agents collection metadata survives catalog encoding', async () => {
  const registry = new CollectionRegistry();
  await registry.seedAgentConfiguration('agents', 'planner');
  const meta = await registry.getCollection('agents');
  if (!meta) throw new Error('Missing fixture');
  const attributes = encodeAttributes(meta, true, 'fp');
  expect(attributes.collectionKind).toBe('agents');
  const parsed = validateRagAttributes(attributes);
  if (!parsed.ok) throw parsed.error;
  const decoded = decodeRecord({
    storeName: storeNameFor('agents'),
    name: 'agents',
    scope: 'global',
    attributes: parsed.value,
  });
  expect(decoded).toMatchObject({
    meta: { id: 'agents', scope: 'global', collectionKind: 'agents' },
  });
});

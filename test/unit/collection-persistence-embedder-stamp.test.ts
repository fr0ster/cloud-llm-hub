import {
  InMemoryRagProvider,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { userCollectionId } from '../../srv/collection-ids';
import {
  createCollectionPersistence,
  restoredDocument,
  unwrap,
} from '../../srv/lib/collection-persistence';
import {
  COMMITTED_BUNDLE_FINGERPRINT,
  fingerprintHash,
} from '../../srv/lib/tool-corpus';
import { CollectionRegistry } from '../../srv/rag-collections';

const embedderFp = fingerprintHash(COMMITTED_BUNDLE_FINGERPRINT);
const id = userCollectionId('notes', 'alice');
const doc = { id: 'one', text: 'text', metadata: {} };

async function fixture() {
  const provider = new InMemoryRagProvider({
    name: 'test',
    supportedScopes: ['user'],
  });
  const newRegistry = () =>
    new CollectionRegistry({
      persistence: createCollectionPersistence(provider, embedderFp),
    });
  const registry = newRegistry();
  await registry.createCollection({
    id,
    logicalId: 'notes',
    scope: 'user',
    owner: 'alice',
    displayName: 'Notes',
    description: '',
  });
  const { records } = unwrap(await provider.describeCollections(), 'describe');
  const { rag } = unwrap(await provider.openCollection(records[0]), 'open');
  const writer = rag.writer?.();
  if (!writer) throw new Error('Missing writer');
  jest.spyOn(rag, 'writer').mockReturnValue(writer);
  const upsert = jest.spyOn(writer, 'upsertRaw');
  return { registry, newRegistry, upsert };
}

test('stamps the current embedder hash on every written document', async () => {
  const { registry, newRegistry, upsert } = await fixture();
  await registry.addDocument(id, doc);
  const restored = newRegistry();
  await restored.updateDocument(id, doc.id, { text: 'updated' });

  expect(upsert).toHaveBeenCalledTimes(2);
  expect(upsert.mock.calls.map(([, , metadata]) => metadata.embedder)).toEqual([
    embedderFp,
    embedderFp,
  ]);
});

test('client metadata cannot set embedder', async () => {
  const { registry, upsert } = await fixture();
  const added = await registry.addDocument(id, {
    ...doc,
    metadata: { embedder: 'forged', a: 1 },
  });

  expect(upsert).toHaveBeenCalledTimes(1);
  const [[recordId, text, metadata]] = upsert.mock.calls;
  expect(metadata.embedder).toBe(embedderFp);
  expect(added.metadata).toEqual({ a: 1 });
  expect(
    restoredDocument(id, { id: recordId, text, metadata }).metadata,
  ).toEqual({ a: 1 });

  const rag = await registry.getRagStore(id);
  if (!rag) throw new Error('Missing collection store');
  const hits = unwrap(await rag.query(new TextOnlyEmbedding(text), 1), 'query');
  expect(hits).toHaveLength(1);
  expect(hits[0].metadata).not.toHaveProperty('embedder');
});

import {
  InMemoryRag,
  type IRagEditor,
  type IRagProvider,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { userCollectionId } from '../../srv/collection-ids';
import { createCollectionPersistence } from '../../srv/lib/collection-persistence';
import { withCollectionToolScope } from '../../srv/lib/collection-write-scope';
import {
  addRagRecord,
  updateRagRecord,
} from '../../srv/lib/rag-write-operations';
import * as storageValues from '../../srv/lib/usage/storage-values';
import { CollectionRegistry } from '../../srv/rag-collections';

async function fixture() {
  const backend = new InMemoryRag();
  const writer = backend.writer();
  jest.spyOn(backend, 'writer').mockReturnValue(writer);
  const editor: IRagEditor = {
    upsert: async (text, metadata, options) => {
      const { id, ...attributes } = metadata;
      if (typeof id !== 'string') throw new Error('Missing id');
      const result = await writer.upsertRaw(id, text, attributes, options);
      return result.ok ? { ok: true, value: { id } } : result;
    },
    deleteById: (id, options) => writer.deleteByIdRaw(id, options),
  };
  const provider: IRagProvider = {
    name: 'test',
    kind: 'vector',
    editable: true,
    supportedScopes: ['user'],
    createCollection: async () => ({
      ok: true,
      value: { rag: backend, editor },
    }),
    openCollection: async () => ({ ok: true, value: { rag: backend, editor } }),
    deleteCollection: async () => ({ ok: true, value: undefined }),
    describeCollections: async () => ({
      ok: true,
      value: { records: [], rejected: [] },
    }),
  };
  const registry = new CollectionRegistry({
    persistence: createCollectionPersistence(provider, 'fp'),
  });
  await registry.restore();
  const id = userCollectionId('notes', 'alice');
  await registry.createCollection({
    id,
    logicalId: 'notes',
    scope: 'user',
    owner: 'alice',
    displayName: 'Notes',
    description: '',
  });
  await addRagRecord(registry, id, {
    id: 'one',
    text: 'old',
    metadata: { title: 'old' },
  });
  await addRagRecord(registry, id, {
    id: 'other',
    text: 'untouched',
    metadata: {},
  });
  return { registry, backend, writer, id };
}

afterEach(() => jest.restoreAllMocks());

test('persistent update reads current backend metadata and createdAt, preserving unrelated snapshot entries', async () => {
  const { registry, backend, writer, id } = await fixture();
  await writer.upsertRaw(`doc:${id}:one`, 'external text', {
    docId: 'one',
    collectionId: id,
    createdAt: '2020-01-01T00:00:00.000Z',
    title: 'external title',
    enabled: false,
    uploadId: 'upload',
  });
  const read = jest.spyOn(backend, 'getById');
  const scan = jest.spyOn(backend, 'scan');
  expect(await registry.getDocument(id, 'one')).toMatchObject({ text: 'old' });
  await withCollectionToolScope(() =>
    updateRagRecord(registry, id, 'one', { text: 'new' }),
  );
  expect(await registry.getDocument(id, 'one')).toMatchObject({
    text: 'new',
    createdAt: '2020-01-01T00:00:00.000Z',
    metadata: { title: 'external title', enabled: false, uploadId: 'upload' },
  });
  expect(await registry.getDocument(id, 'other')).toMatchObject({
    text: 'untouched',
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(scan).not.toHaveBeenCalled();
});

test('missing backend records cannot be resurrected or reported as deleted', async () => {
  const { registry, writer, id } = await fixture();
  await writer.deleteByIdRaw(`doc:${id}:one`);
  const upsert = jest.spyOn(writer, 'upsertRaw');
  expect(
    await updateRagRecord(registry, id, 'one', { text: 'resurrection' }),
  ).toBeNull();
  expect(await registry.deleteDocument(id, 'one')).toBe(false);
  expect(upsert).not.toHaveBeenCalled();
});

test.each(['add', 'update', 'delete'] as const)(
  'failed %s reconciles only the submitted record and still reports failure',
  async (operation: 'add' | 'update' | 'delete') => {
    const { registry, backend, writer, id } = await fixture();
    const persist = writer.upsertRaw.bind(writer);
    const remove = writer.deleteByIdRaw.bind(writer);
    jest
      .spyOn(writer, 'upsertRaw')
      .mockImplementationOnce(async (record, text, metadata, options) => {
        await persist(record, text, metadata, options);
        return {
          ok: false,
          error: new RagError('Upsert failed: fetch failed', 'UPSERT_ERROR'),
        };
      });
    jest
      .spyOn(writer, 'deleteByIdRaw')
      .mockImplementationOnce(async (record, options) => {
        await remove(record, options);
        return {
          ok: false,
          error: new RagError('Delete failed: fetch failed', 'DELETE_ERROR'),
        };
      });
    const read = jest.spyOn(backend, 'getById');
    const scan = jest.spyOn(backend, 'scan');
    const write =
      operation === 'add'
        ? addRagRecord(registry, id, { id: 'one', text: 'settled' })
        : operation === 'update'
          ? updateRagRecord(registry, id, 'one', { text: 'settled' })
          : registry.deleteDocument(id, 'one');
    await expect(write).rejects.toThrow('fetch failed');
    if (operation === 'delete')
      expect(await registry.getDocument(id, 'one')).toBeNull();
    else
      expect(await registry.getDocument(id, 'one')).toMatchObject({
        text: 'settled',
      });
    expect(await registry.getDocument(id, 'other')).toMatchObject({
      text: 'untouched',
    });
    expect(
      read.mock.calls.every(([record]) => record === `doc:${id}:one`),
    ).toBe(true);
    expect(read).toHaveBeenCalledTimes(operation === 'add' ? 1 : 2);
    expect(scan).not.toHaveBeenCalled();
  },
);

test('a backend rejection before submission leaves the snapshot unchanged', async () => {
  const { registry, writer, id } = await fixture();
  jest.spyOn(writer, 'upsertRaw').mockResolvedValueOnce({
    ok: false,
    error: new RagError('Embedding rejected', 'EMBEDDING_FAILED'),
  });
  await expect(
    updateRagRecord(registry, id, 'one', { text: 'rejected' }),
  ).rejects.toThrow();
  expect(await registry.getDocument(id, 'one')).toMatchObject({
    text: 'old',
    metadata: { title: 'old' },
  });
});

test('persistent update counts the snapshot replacement bytes after an external text edit', async () => {
  jest.spyOn(storageValues, 'storageEnabled').mockReturnValue(true);
  const { registry, writer, id } = await fixture();
  await writer.upsertRaw(`doc:${id}:one`, 'much longer external text', {
    docId: 'one',
    collectionId: id,
    createdAt: '2020-01-01T00:00:00.000Z',
  });
  await updateRagRecord(registry, id, 'one', { text: 'new text' });
  expect(registry.storageMeasures('alice')).toMatchObject({
    userCollectionDocuments: 2,
    userCollectionTextBytes: Buffer.byteLength('new textuntouched'),
  });
});

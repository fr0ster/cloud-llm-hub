import type { Request } from 'express';
import { getCollectionRegistry } from '../../srv/agent-manager';
import {
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';
import {
  deleteCollectionOverrides,
  setCollectionOverride,
} from '../../srv/lib/collection-toggle';
import {
  DIALOGUE_ATTACHMENT_CHARS,
  dialogueAttachments,
} from '../../srv/lib/dialogue-attachments';
import { CollectionRegistry } from '../../srv/rag-collections';

jest.mock('../../srv/agent-manager', () => ({
  getCollectionRegistry: jest.fn(),
}));

let registry: CollectionRegistry;
const req = (
  ids: string[] = ['uploads'],
): Pick<Request, 'headers' | 'body'> => ({
  headers: {},
  body: {
    rag_collections: ids,
    attachment_document_ids: ['disabled', 'old', 'file'],
  },
});
beforeEach(() => {
  registry = new CollectionRegistry();
  jest.mocked(getCollectionRegistry).mockReturnValue(registry);
});
afterEach(() => deleteCollectionOverrides('alice', 'session'));

async function uploads(scope: 'user' | 'session' = 'user') {
  const id =
    scope === 'user'
      ? userCollectionId('uploads', 'alice')
      : sessionCollectionId('uploads', 'alice', 'session');
  await registry.createCollection({
    id,
    logicalId: 'uploads',
    displayName: 'Uploads',
    description: '',
    scope,
    owner: 'alice',
    ...(scope === 'session' ? { sessionId: 'session' } : {}),
  });
  return id;
}

test('ordinary dialogue never enumerates or reads collections', async () => {
  const list = jest.spyOn(registry, 'listCollections');
  const stores = jest.spyOn(registry, 'getRagStores');
  expect(
    await dialogueAttachments(req(['docs']), 'alice', 'session'),
  ).toBeUndefined();
  expect(list).not.toHaveBeenCalled();
  expect(stores).not.toHaveBeenCalled();
});

test('explicit uploads read bounded content without semantic queries and exclude disabled records', async () => {
  const id = await uploads();
  await registry.addDocument(id, {
    id: 'disabled',
    text: 'hidden',
    metadata: { enabled: false },
  });
  await registry.addDocument(id, {
    id: 'old',
    text: 'superseded content',
    metadata: { tags: ['superseded'] },
  });
  await registry.addDocument(id, {
    id: 'file',
    metadata: {},
    text: 'attached text '.repeat(3000),
  });
  const store = await registry.getRagStore(id);
  if (!store) throw new Error('Missing store');
  const query = jest.spyOn(store, 'query');
  const list = jest.spyOn(registry, 'listDocuments');
  const result = await dialogueAttachments(req(), 'alice', 'session');
  expect(result).toContain('attached text');
  expect(result).not.toContain('hidden');
  expect(result).not.toContain('superseded content');
  expect(result?.length).toBeLessThanOrEqual(DIALOGUE_ATTACHMENT_CHARS);
  expect(result).toContain('workers can read remaining uploads');
  expect(list).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

test('user upload previews respect the session collection toggle', async () => {
  const id = await uploads();
  await registry.addDocument(id, { id: 'file', metadata: {}, text: 'hidden' });
  setCollectionOverride('alice', 'session', id, false);
  expect(await dialogueAttachments(req(), 'alice', 'session')).toBeUndefined();
});

test('explicit session uploads remain request data even with the collection disabled', async () => {
  const id = await uploads('session');
  await registry.addDocument(id, {
    id: 'file',
    metadata: {},
    text: 'request attachment',
  });
  setCollectionOverride('alice', 'session', id, false);
  expect(await dialogueAttachments(req(), 'alice', 'session')).toContain(
    'request attachment',
  );
});

test('missing uploads fail explicitly rather than silently dropping attachments', async () => {
  await expect(dialogueAttachments(req(), 'alice', 'session')).rejects.toThrow(
    'Attached uploads collection is unavailable',
  );
});

test('only current document IDs are read beyond 100 earlier uploads', async () => {
  const id = await uploads();
  for (let i = 0; i < 101; i++)
    await registry.addDocument(id, {
      id: `previous-${i}`,
      metadata: { source: 'same.txt' },
      text: 'previous request',
    });
  await registry.addDocument(id, {
    id: 'file',
    metadata: { source: 'same.txt' },
    text: 'current request',
  });
  const result = await dialogueAttachments(req(), 'alice', 'session');
  expect(result).toContain('current request');
  expect(result).not.toContain('previous request');
});

test('collection selection alone does not attach earlier uploads', async () => {
  const get = jest.spyOn(registry, 'getDocument');
  expect(
    await dialogueAttachments({ headers: {}, body: {} }, 'alice', 'session'),
  ).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});

jest.mock('../../srv/agent-manager', () => ({
  getCollectionRegistry: jest.fn(),
  getQueryEmbedder: () => undefined,
}));
jest.mock('../../srv/collection-ids', () => ({ resolveRouteId: jest.fn() }));

import type { Message } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { getCollectionRegistry } from '../../srv/agent-manager';
import { resolveRouteId } from '../../srv/collection-ids';
import { CollectionBackendError } from '../../srv/lib/collection-persistence';
import {
  collectionRetrieval,
  requestedCollectionIds,
} from '../../srv/lib/collection-retrieval';
import {
  RAG_CONTEXT_MARKER,
  userTextOf,
} from '../../srv/lib/rag-context-marker';
import { CollectionSearchRag } from '../../srv/rag-collections';

const req = (header?: string, body: unknown = {}) => ({
  headers: header === undefined ? {} : { 'x-rag-collections': header },
  body,
});
const query = jest.fn();
const registry = {
  ready: Promise.resolve(),
  heldPresetFor: jest.fn((): string | undefined => undefined),
  getEnabled: jest.fn((): boolean | undefined => undefined),
  getCollection: jest.fn(
    async (): Promise<{
      id: string;
      logicalId: string;
      scope: string;
      owner: string;
      sessionId?: string;
    }> => ({
      id: 'physical',
      logicalId: 'selected',
      scope: 'user',
      owner: 'alice',
    }),
  ),
  listCollections: jest.fn(
    async (): Promise<
      Array<{ id: string; logicalId: string; scope: string; owner: string }>
    > => [],
  ),
  degradedOf: jest.fn(),
  getRagStores: jest.fn(async () => ({ selected: { query } })),
  getRagStore: jest.fn(async () => ({ query })),
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getCollectionRegistry).mockReturnValue(registry as never);
  jest.mocked(resolveRouteId).mockResolvedValue('physical');
  registry.degradedOf.mockResolvedValue(undefined);
  registry.getEnabled.mockReturnValue(undefined);
  query.mockResolvedValue({
    ok: true,
    value: [{ text: 'knowledge', score: 1 }],
  });
});

it('logs once and continues without retrieval when unselected enumeration fails', async () => {
  registry.listCollections.mockRejectedValueOnce(new Error('restore failed'));
  const log = cds.log('enumeration-test');
  const warn = jest.spyOn(log, 'warn').mockImplementation(() => {});
  const original = {};
  const agent = { deps: { ragStores: original } };
  const messages: Message[] = [{ role: 'user', content: 'question' }];
  try {
    expect(
      await collectionRetrieval(agent).retrieve(
        req(),
        messages,
        'alice',
        undefined,
        log,
      ),
    ).toEqual({ messages });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(registry.getRagStores).not.toHaveBeenCalled();
    expect(agent.deps.ragStores).toBe(original);
  } finally {
    warn.mockRestore();
  }
});

it('keeps the structured 503 refusal for an explicit selection when restore fails', async () => {
  const failure = new CollectionBackendError('restore', {
    name: 'RagError',
    code: 'COLLECTIONS_UNAVAILABLE',
    message: 'restore failed',
  });
  registry.ready = Promise.reject(failure);
  try {
    expect(
      await collectionRetrieval({ deps: { ragStores: {} } }).retrieve(
        req('selected'),
        [],
        'alice',
        undefined,
        cds.log('test'),
      ),
    ).toEqual({
      refusal: {
        status: 503,
        message: failure.message,
        kind: 'service_unavailable',
      },
    });
    expect(registry.listCollections).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  } finally {
    registry.ready = Promise.resolve();
  }
});

it('reads header or body ids, with header precedence', () => {
  expect(
    requestedCollectionIds(req(' a, , b ', { rag_collections: ['c'] })),
  ).toEqual(['a', 'b']);
  expect(
    requestedCollectionIds(req(undefined, { rag_collections: ['c'] })),
  ).toEqual(['c']);
  expect(requestedCollectionIds(req())).toEqual([]);
});

it('resolves ids, appends context with provenance, and restores stores', async () => {
  const original = {};
  const agent = { deps: { ragStores: original } };
  const step = collectionRetrieval(agent);
  const messages: Message[] = [{ role: 'user', content: 'question' }];
  try {
    const result = await step.retrieve(
      req('selected'),
      messages,
      'alice',
      'session',
      cds.log('test'),
    );
    expect(resolveRouteId).toHaveBeenCalledWith(
      registry,
      'selected',
      'alice',
      'session',
      false,
    );
    expect(result.messages?.[0].content).toBe(
      `question${RAG_CONTEXT_MARKER}knowledge`,
    );
    if (!result.messages) throw new Error('unexpected refusal');
    expect(userTextOf(result.messages[0])).toBe('question');
    expect(messages[0].content).toBe('question');
    expect(agent.deps.ragStores).toEqual({
      selected: expect.any(CollectionSearchRag),
    });
    expect(query).toHaveBeenCalledWith(expect.anything(), 3);
  } finally {
    step.restore();
  }
  expect(agent.deps.ragStores).toBe(original);
});

it('keeps the original messages when no result passes the threshold', async () => {
  query.mockResolvedValue({
    ok: true,
    value: [{ text: 'irrelevant', score: -1 }],
  });
  const step = collectionRetrieval({ deps: { ragStores: {} } });
  const messages: Message[] = [{ role: 'user', content: 'question' }];
  try {
    expect(
      (
        await step.retrieve(
          req('selected'),
          messages,
          'alice',
          undefined,
          cds.log('test'),
        )
      ).messages,
    ).toBe(messages);
  } finally {
    step.restore();
  }
});

it.each([409, 503])(
  'returns degraded refusal %s as data without searching',
  async (status) => {
    registry.degradedOf.mockResolvedValue({
      httpStatus: status,
      message: 'unavailable',
    });
    const step = collectionRetrieval({ deps: { ragStores: {} } });
    try {
      expect(
        await step.retrieve(
          req('selected'),
          [],
          'alice',
          undefined,
          cds.log('test'),
        ),
      ).toEqual({
        refusal: {
          status,
          message: 'unavailable',
          kind: status === 409 ? 'conflict' : 'service_unavailable',
        },
      });
      expect(query).not.toHaveBeenCalled();
      expect(registry.getRagStores).not.toHaveBeenCalled();
    } finally {
      step.restore();
    }
  },
);

it('restores injected stores after a search failure', async () => {
  query.mockRejectedValue(new Error('search failed'));
  const original = {};
  const agent = { deps: { ragStores: original } };
  const step = collectionRetrieval(agent);
  try {
    await expect(
      step.retrieve(
        req('selected'),
        [{ role: 'user', content: 'question' }],
        'alice',
        undefined,
        cds.log('test'),
      ),
    ).rejects.toThrow('search failed');
    expect(agent.deps.ragStores).not.toBe(original);
  } finally {
    step.restore();
  }
  expect(agent.deps.ragStores).toBe(original);
});

it('filters disabled collections before querying or injecting stores', async () => {
  registry.getEnabled.mockReturnValue(false);
  const step = collectionRetrieval({ deps: { ragStores: {} } });
  const messages: Message[] = [{ role: 'user', content: 'question' }];
  expect(
    await step.retrieve(
      req('selected'),
      messages,
      'alice',
      'session',
      cds.log('test'),
    ),
  ).toEqual({ messages });
  expect(registry.getRagStore).not.toHaveBeenCalled();
  expect(registry.getRagStores).not.toHaveBeenCalled();
});

it('uses enabled defaults without a selection and respects an empty client intersection', async () => {
  const list = jest.spyOn(registry, 'listCollections');
  list.mockResolvedValueOnce([
    { id: 'physical', logicalId: 'selected', scope: 'user', owner: 'alice' },
  ]);
  const step = collectionRetrieval({ deps: { ragStores: {} } });
  await step.retrieve(
    req(),
    [{ role: 'user', content: 'question' }],
    'alice',
    undefined,
    cds.log('test'),
  );
  expect(query).toHaveBeenCalledTimes(1);
  query.mockClear();
  await step.retrieve(
    req(undefined, { rag_collections: [] }),
    [{ role: 'user', content: 'question' }],
    'alice',
    undefined,
    cds.log('test'),
  );
  expect(query).not.toHaveBeenCalled();
});

it('allows explicitly attached session uploads for that request', async () => {
  registry.getEnabled.mockReturnValue(false);
  registry.getCollection.mockResolvedValueOnce({
    id: 'physical',
    logicalId: 'uploads',
    scope: 'session',
    owner: 'alice',
    sessionId: 'session',
  });
  const step = collectionRetrieval({ deps: { ragStores: {} } });
  await step.retrieve(
    req(undefined, { rag_collections: ['uploads'] }),
    [{ role: 'user', content: 'question' }],
    'alice',
    'session',
    cds.log('test'),
  );
  expect(query).toHaveBeenCalledTimes(1);
});

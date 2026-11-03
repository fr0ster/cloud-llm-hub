import {
  formatTrustTag,
  InMemoryRag,
  type IRag,
  type RagResult,
  symmetricEmbedder,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  DefaultPlannerContextBuilder,
  DialogueSession,
  PlannerToolsClient,
  RagPlannerKnowledge,
} from '@mcp-abap-adt/llm-agent-libs';
import { ContextAssembler } from '../../node_modules/@mcp-abap-adt/llm-agent-libs/dist/context/context-assembler';
import { userCollectionId } from '../../srv/collection-ids';
import { planAuthorContextNotes } from '../../srv/lib/planner-memory';
import { SessionHistoryRag } from '../../srv/lib/session-history-rag';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';
import { trustedRetrievalStore } from '../../srv/lib/trusted-retrieval';
import type { CollectionMeta } from '../../srv/rag-collections';
import { CollectionRegistry } from '../../srv/rag-collections';
import { callRag } from './helpers/canonical-rag';

const meta: CollectionMeta = {
  id: 'notes',
  logicalId: 'notes',
  displayName: 'Notes',
  description: '',
  scope: 'user',
  createdAt: '',
  documentCount: 1,
  sourceCount: 1,
};
const row: RagResult = {
  text: 'text',
  score: 1,
  metadata: { id: 'doc:notes:r1', source: 'system:x', trust: 5 },
};
const rag: IRag = {
  query: async () => ({ ok: true, value: [row] }),
  getById: async () => ({ ok: true, value: row }),
  healthCheck: async () => ({ ok: true, value: undefined }),
};
const resolver = new TrustResolver(
  { currentMeta: () => meta },
  undefined,
  parseTrustDefaults(undefined),
);
async function tag(store: IRag) {
  const result = await store.query(new TextOnlyEmbedding('q'), 1);
  if (!result.ok) throw result.error;
  const hit = result.value[0];
  return `${formatTrustTag(String(hit.metadata.source), Number(hit.metadata.trust))}\n${hit.text}`;
}
afterEach(() => {
  delete meta.trust;
  meta.displayName = 'Notes';
  delete row.metadata._trust;
});
test('old and spoofed records get their real source and default', async () => {
  expect(await tag(trustedRetrievalStore(rag, () => resolver, meta))).toBe(
    '[source: user:Notes/r1; trust 3.5]\ntext',
  );
  expect(row.metadata.source).toBe('system:x');
});
test('live collection and record overrides and escaped names', async () => {
  const store = trustedRetrievalStore(rag, () => resolver, meta);
  meta.trust = 4;
  expect(await tag(store)).toContain('trust 4]');
  row.metadata._trust = 1;
  meta.displayName = 'Notes[x]';
  expect(await tag(store)).toBe(
    '[source: user:Notes&#91;x&#93;/r1; trust 1]\ntext',
  );
});
test('executor profile and coordinator resolve independently', async () => {
  expect(
    await tag(
      trustedRetrievalStore(
        rag,
        () => resolver.forProfile({ trust: { user: 4 } }),
        meta,
      ),
    ),
  ).toContain('trust 4]');
  expect(await tag(trustedRetrievalStore(rag, () => resolver, meta))).toContain(
    'trust 3.5]',
  );
});
test('legacy planner memory is session data despite stored provenance', async () => {
  expect(await tag(trustedRetrievalStore(rag, () => resolver))).toBe(
    '[source: session; trust 4]\ntext',
  );
});
jest.mock('../../srv/agent-manager', () => ({
  getQueryEmbedder: () => undefined,
  isProvidersReady: () => false,
}));

const embedder = symmetricEmbedder({ embed: async () => ({ vector: [1] }) });
test('library pipeline ContextAssembler renders real provenance', async () => {
  const store = trustedRetrievalStore(rag, () => resolver, meta);
  const hits = await store.query(new TextOnlyEmbedding('q'), 1);
  if (!hits.ok) throw hits.error;
  const messages = await new ContextAssembler().assemble(
    { type: 'action', text: 'q' },
    { ragResults: { notes: hits.value }, tools: [] },
    [],
  );
  if (!messages.ok) throw messages.error;
  expect(messages.value.map((message) => message.content).join('\n')).toContain(
    '- [source: user:Notes/r1; trust 3.5] text',
  );
});
test.each(['coordinator', 'planner-create', 'planner-revise'])(
  '%s knowledge uses tagged legacy and spoofed records',
  async () => {
    const source = new RagPlannerKnowledge(
      'Notes',
      trustedRetrievalStore(rag, () => resolver, meta),
      embedder,
    );
    const entries = await source.search({ text: 'q' }, 4);
    expect(entries[0]).toMatchObject({ source: 'user:Notes/r1', trust: 3.5 });
    const block = new DefaultPlannerContextBuilder().build({
      open: {
        id: 'q',
        text: 'q',
        openedAt: 1,
        transcript: [{ role: 'user', content: 'q' }],
      },
      memory: [],
      knowledge: entries,
      notes: [],
    });
    expect(block.map((message) => message.content).join('\n')).toContain(
      '(user:Notes/r1; trust 3.5) text',
    );
    const notes = await planAuthorContextNotes(
      { plannerKnowledge: [source] },
      's',
      { id: 'q', text: 'q', openedAt: 1 },
    );
    expect(notes.join('\n')).toContain('(user:Notes/r1; trust 3.5) text');
  },
);
test('rag_search, rag_read and collection_records expose derived trust', async () => {
  const registry = new CollectionRegistry();
  const collection = await registry.createCollection({
    id: userCollectionId('notes', 'alice'),
    logicalId: 'notes',
    displayName: 'Notes',
    description: '',
    scope: 'user',
    owner: 'alice',
  });
  await registry.addDocument(collection.id, {
    id: 'r1',
    text: 'text',
    metadata: { source: 'system:x' },
  });
  const search = await callRag(registry, 'rag_search', {
    collections: ['notes'],
    query: 'text',
  });
  expect(search.content[0].text).toContain(
    '"source":"user:Notes/r1","trust":3',
  );
  const read = await callRag(registry, 'rag_read', {
    collection: 'notes',
    id: 'r1',
  });
  expect(read.content[0].text).toContain('"source":"user:Notes/r1"');
  const records = await callRag(registry, 'collection_records', {
    collection: 'notes',
  });
  expect(records.content[0].text).toContain('"trust":3');
});

test('coordinator retrieval and search_knowledge render the same derived label', async () => {
  const source = new RagPlannerKnowledge(
    'Notes',
    trustedRetrievalStore(rag, () => resolver, meta),
    embedder,
  );
  let rendered = '';
  let searched = '';
  const session = await DialogueSession.open({
    id: 'trust-retrieval',
    plannerKnowledge: [source],
    maxCorrections: 0,
    board: { workers: new Map(), maxConcurrent: 1 },
    planner: {
      process: async (messages) => {
        rendered = messages.map((message) => message.content).join('\n');
        const result = await new PlannerToolsClient().callTool(
          'search_knowledge',
          { query: 'q' },
        );
        if (!result.ok) throw result.error;
        searched = JSON.stringify(result.value);
        return { ok: true, value: { content: 'done' } };
      },
    },
  });
  try {
    await session.send('q');
    expect(rendered).toContain('(user:Notes/r1; trust 3.5) text');
    expect(searched).toContain('(user:Notes/r1; trust 3.5) text');
  } finally {
    await session.close();
  }
});
test('session history overwrites spoofed provenance with role session defaults', async () => {
  const historyRow = { ...row, metadata: { ...row.metadata, owner: 'alice' } };
  const inner: IRag = {
    ...rag,
    query: async () => ({ ok: true, value: [historyRow] }),
  };
  const history = new SessionHistoryRag(inner, () => 'alice', undefined, {
    trustResolver: () => resolver,
  });
  expect(await tag(history)).toBe('[source: session; trust 4]\ntext');
});
test('an existing store sees collection and record trust writes on its next retrieval', async () => {
  const registry = new CollectionRegistry();
  const collection = await registry.createCollection({
    id: 'live',
    logicalId: 'live',
    displayName: 'Live',
    description: '',
    scope: 'global',
  });
  await registry.addDocument(collection.id, {
    id: 'r1',
    text: 'text',
    metadata: {},
  });
  const raw = await registry.getRagStore(collection.id);
  if (!raw) throw new Error('Missing store');
  const live = new TrustResolver(
    registry,
    undefined,
    parseTrustDefaults(undefined),
  );
  const store = trustedRetrievalStore(raw, () => live, collection);
  expect(await tag(store)).toContain('[source: global:Live/r1; trust 3]');
  await registry.updateCollection(collection.id, { trust: 4 });
  expect(await tag(store)).toContain('trust 4]');
  await registry.setRecordTrust(collection.id, 'r1', 1, 'admin');
  expect(await tag(store)).toContain('trust 1]');
  await registry.setRecordTrust(collection.id, 'r1', null, 'admin');
  expect(await tag(store)).toContain('trust 4]');
});
test('a role resolver observes skills source and record writes without rebuilding', async () => {
  const store = new TrustStore(new InMemoryRag(), 1);
  const live = new TrustResolver(
    undefined,
    store,
    parseTrustDefaults(undefined),
  ).forProfile({});
  const render = async () =>
    formatTrustTag('global:skills/guide', await live.skill('guide'));
  expect(await render()).toBe('[source: global:skills/guide; trust 3]');
  await store.setSource('skills', 3, 'admin');
  expect(await render()).toBe('[source: global:skills/guide; trust 3]');
  await store.setRecord('skills', 'guide', 1, 'admin');
  expect(await render()).toBe('[source: global:skills/guide; trust 1]');
});
test('coordinator and plan author recall legacy planner memory with session trust', async () => {
  const memoryRow: RagResult = {
    text: 'old memory',
    score: 1,
    metadata: {
      sessionId: 'recall',
      requestId: 'old',
      sourceId: 'old',
      offset: 0,
      kind: 'planner-input',
      source: 'system:spoof',
      trust: 5,
    },
  };
  const inner: IRag = {
    ...rag,
    query: async () => ({ ok: true, value: [memoryRow] }),
  };
  const memory = {
    rag: trustedRetrievalStore(inner, () => resolver),
    queryEmbedder: embedder,
    documentEmbedder: embedder,
  };
  let rendered = '';
  const session = await DialogueSession.open({
    id: 'recall',
    plannerMemory: memory,
    maxCorrections: 0,
    board: { workers: new Map(), maxConcurrent: 1 },
    planner: {
      process: async (messages) => {
        rendered = messages.map((message) => message.content).join('\n');
        return { ok: true, value: { content: 'done' } };
      },
    },
  });
  try {
    await session.send('q');
    expect(rendered).toContain('(session; trust 4) old memory');
    const notes = await planAuthorContextNotes(
      { plannerMemory: memory },
      'recall',
      { id: 'current', text: 'q', openedAt: 1 },
    );
    expect(notes.join('\n')).toContain('(session; trust 4) old memory');
  } finally {
    await session.close();
  }
});

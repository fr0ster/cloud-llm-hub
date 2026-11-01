import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
interface Collection {
  id: string;
  trusted: boolean;
  trust?: number;
  trustClass?: string;
  scope: string;
  writable: boolean;
}
interface TrustItem {
  trusted: boolean;
  trust?: number;
  trustOverride?: number;
  trustClass?: string;
}
function harness() {
  const ragFetch = jest.fn(
    async (_path: string, _options: { method: string; body: string }) => ({
      ok: true,
      json: async () => ({}),
    }),
  );
  const alert = jest.fn();
  const reload = jest.fn();
  const api: {
    render: (
      item: TrustItem,
      collection: Collection,
      record?: string,
    ) => string;
    save: (input: {
      value: string;
      disabled: boolean;
      dataset: { collection: string; record?: string };
    }) => Promise<void>;
  } = runInNewContext(
    `${html.slice(
      html.indexOf('        function trustEditable('),
      html.indexOf('        async function loadCollections()'),
    )}\n({render: renderTrust, save: saveTrust})`,
    {
      escapeHtml: (s: string) =>
        s
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;'),
      ragFetch,
      alert,
      loadCollections: reload,
      loadDocuments: reload,
      ragCurrentCollection: 'global',
    },
  );
  return { api, ragFetch, alert, reload };
}
const globalCollection: Collection = {
  id: 'global',
  trusted: true,
  trust: 4.5,
  trustClass: 'global',
  scope: 'global',
  writable: true,
};

test('collection row renders effective trust and class from collectionView', () => {
  const { api } = harness();
  expect(api.render(globalCollection, globalCollection)).toContain(
    'Trust 4.5 (global)',
  );
  expect(html).toContain('renderTrust(c, c)');
});

test('document rows distinguish inherited trust and explicit zero override', () => {
  const { api } = harness();
  expect(
    api.render({ trusted: true, trust: 4.5 }, globalCollection, 'r1'),
  ).toContain('Trust 4.5 (inherited)');
  const override = api.render(
    { trusted: true, trust: 0, trustOverride: 0 },
    globalCollection,
    'r2',
  );
  expect(override).toContain('Trust 0 (override)');
  expect(override).toContain('value="0"');
  expect(html).toContain(
    'renderTrust(d, ragCollectionsCache.find(c => c.id === ragCurrentCollection), d.id)',
  );
});

test('only writable global informational sources have editors, including @skills', () => {
  const { api } = harness();
  expect(
    api.render(globalCollection, { ...globalCollection, writable: false }),
  ).not.toContain('<input');
  expect(
    api.render(globalCollection, { ...globalCollection, scope: 'user' }),
  ).not.toContain('<input');
  expect(
    api.render(globalCollection, { ...globalCollection, id: '@skills' }),
  ).toContain('data-collection="@skills"');
  expect(
    api.render({ trusted: false }, { ...globalCollection, trusted: false }),
  ).toBe('');
  expect(api.render({ trusted: false }, globalCollection, 'executor')).toBe('');
});

test('inline setters encode ids and clear record overrides with null', async () => {
  const h = harness();
  await h.api.save({
    value: '3.5',
    disabled: false,
    dataset: { collection: '@skills' },
  });
  expect(h.ragFetch).toHaveBeenLastCalledWith('/v1/rag/collections/%40skills', {
    method: 'PUT',
    body: '{"trust":3.5}',
  });
  await h.api.save({
    value: '',
    disabled: false,
    dataset: { collection: '@skills', record: 'plugin/a' },
  });
  expect(h.ragFetch).toHaveBeenLastCalledWith(
    '/v1/rag/collections/%40skills/documents/plugin%2Fa/trust',
    { method: 'PATCH', body: '{"trust":null}' },
  );
  expect(h.reload).toHaveBeenCalledTimes(4);
});

test.each(['', '4.55', '-1', '5.1', 'nope'])(
  'invalid collection trust %s makes no write',
  async (value: string) => {
    const h = harness();
    await h.api.save({
      value,
      disabled: false,
      dataset: { collection: 'global' },
    });
    expect(h.ragFetch).not.toHaveBeenCalled();
    expect(h.alert).toHaveBeenCalled();
  },
);

test('MANAGE collection and document loaders render response fields, skills and agents', async () => {
  const elements = new Map<
    string,
    {
      innerHTML: string;
      value: string;
      onchange?: () => void;
      onclick?: () => void;
    }
  >();
  const element = (id: string) => {
    let result = elements.get(id);
    if (!result) {
      result = { innerHTML: '', value: '' };
      elements.set(id, result);
    }
    return result;
  };
  const skills = { ...globalCollection, id: '@skills', displayName: 'Skills' };
  const agents = {
    ...globalCollection,
    id: 'agents',
    displayName: 'Agents',
    collectionKind: 'agents',
    trusted: false,
  };
  const documents = [
    { id: 'inherited', trusted: true, trust: 4.5, text: 'A' },
    { id: 'overridden', trusted: true, trust: 2, trustOverride: 2, text: 'B' },
  ];
  const api: {
    collections: () => Promise<void>;
    documents: () => Promise<void>;
  } = runInNewContext(
    `let ragCollectionsCache = []; let ragCurrentCollection = '@skills';\n${html.slice(html.indexOf('        function trustEditable('), html.indexOf('        async function createCollection()'))}\n${html.slice(html.indexOf('        async function loadDocuments()'), html.indexOf('        async function toggleRecord('))}\n({collections: loadCollections, documents: loadDocuments})`,
    {
      document: { getElementById: element },
      localStorage: { getItem: () => '' },
      escapeHtml: (s: string) => String(s),
      ragFetch: async (path: string) => ({
        json: async () =>
          path.includes('/documents')
            ? { documents, total: documents.length }
            : { collections: [skills, agents] },
      }),
    },
  );
  await api.collections();
  const collectionsHtml = element('rag-collections-list').innerHTML;
  expect(collectionsHtml).toContain('Trust 4.5 (global)');
  expect(collectionsHtml).toContain('data-collection="@skills"');
  expect(collectionsHtml).not.toContain('data-collection="agents"');
  await api.documents();
  expect(element('rag-doc-list').innerHTML).toContain('Trust 4.5 (inherited)');
  expect(element('rag-doc-list').innerHTML).toContain('Trust 2 (override)');
  expect(element('rag-doc-list').innerHTML).toContain(
    'data-record="overridden"',
  );
});

import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import {
  canonicalCollectionMeta,
  encodeAttributes,
  ownMetadata,
  restoredDocument,
} from '../../srv/lib/collection-persistence';
import {
  collectionView,
  documentView,
  sanitizeExternalMetadata,
} from '../../srv/lib/record-policy';
import { skillDocumentView } from '../../srv/lib/skills-pool';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';
import type { CollectionMeta, RagDocument } from '../../srv/rag-collections';

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
const doc: RagDocument = {
  id: 'r1',
  text: 'text',
  createdAt: '',
  metadata: { source: 'file.txt', _trust: 1.5 },
};
const resolver = new TrustResolver(
  undefined,
  undefined,
  parseTrustDefaults(undefined),
);
test('collection persistence retains trust and bounds history', () => {
  const history = Array.from({ length: 25 }, (_, n) => ({
    from: null,
    to: n % 5,
    actor: 'admin',
    at: String(n),
  }));
  const trusted = { ...meta, trust: 4, trustHistory: history };
  expect(canonicalCollectionMeta(trusted).trustHistory).toEqual(
    history.slice(-20),
  );
  expect(encodeAttributes(trusted, true, 'fp').trust).toBe(4);
});
test('internal metadata carries overrides while external metadata cannot spoof them', () => {
  const metadata = {
    source: 'file.txt',
    trust: 5,
    trustHistory: [],
    _trust: 5,
    _trustHistory: [],
  };
  expect(sanitizeExternalMetadata(metadata)).toEqual({ source: 'file.txt' });
  expect(ownMetadata(doc.metadata)._trust).toBe(1.5);
  expect(
    restoredDocument(meta.id, {
      id: 'r1',
      text: 'text',
      metadata: { ...doc.metadata, docId: 'r1' },
    }).metadata._trust,
  ).toBe(1.5);
});
test('shared projections resolve override and inheritance without changing uploaded source', () => {
  const input = resolver.inputFor(doc, { ...meta, trust: 4 });
  expect(documentView(doc, input)).toMatchObject({
    trusted: true,
    trust: 1.5,
    trustOverride: 1.5,
    source: 'user:Notes/r1',
    metadata: { source: 'file.txt' },
  });
  expect(
    collectionView(meta, resolver.inputFor({ ...doc, metadata: {} }, meta)),
  ).toMatchObject({ trusted: true, trust: 3.5, trustClass: 'user' });
  expect(documentView(doc, { trusted: false })).toMatchObject({
    trusted: false,
  });
  expect(documentView(doc, { trusted: false })).not.toHaveProperty('trust');
});

test('virtual skills share live inherited, overridden and cleared document projections', async () => {
  const store = new TrustStore(new InMemoryRag(), 3);
  const resolver = new TrustResolver(
    undefined,
    store,
    parseTrustDefaults(undefined),
  );
  await store.setSource('skills', 4, 'admin');
  expect(await skillDocumentView(doc, resolver)).toMatchObject({
    trust: 4,
    source: 'global:skills/r1',
  });
  await store.setRecord('skills', 'r1', 1, 'admin');
  expect(await skillDocumentView(doc, resolver)).toMatchObject({
    trust: 1,
    trustOverride: 1,
  });
  await store.setSource('skills', 5, 'admin');
  expect(await skillDocumentView(doc, resolver)).toMatchObject({ trust: 1 });
  await store.setRecord('skills', 'r1', null, 'admin');
  const inherited = await skillDocumentView(doc, resolver);
  expect(inherited).toMatchObject({ trust: 5 });
  expect(inherited).not.toHaveProperty('trustOverride');
});

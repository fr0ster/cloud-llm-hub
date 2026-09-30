import {
  bundleFileFor,
  COMMITTED_BUNDLE_FINGERPRINT,
  corpusByRole,
  corpusHash,
  fingerprintHash,
  recordIsCurrent,
  toolRecordAttributes,
  toolStoreName,
} from '../../srv/lib/tool-corpus';

const d = (name: string, text: string, exposition?: string) => ({
  id: `tool:${name}`,
  name,
  text,
  exposition,
  cached: true,
});
const fp = {
  provider: 'ollama',
  embeddingModel: 'bge-m3',
  baseURL: 'http://localhost:11434',
};

describe('tool corpus identity', () => {
  it('corpus hash is order-independent and text-sensitive', () => {
    expect(corpusHash([d('A', 'a'), d('B', 'b')])).toBe(
      corpusHash([d('B', 'b'), d('A', 'a')]),
    );
    expect(corpusHash([d('A', 'a')])).not.toBe(corpusHash([d('A', 'a2')]));
  });

  it('a tool moving between roles changes both role corpus hashes', () => {
    const before = [d('R', 'r', 'read'), d('W', 'w', 'high')];
    const after = [d('R', 'r', 'high'), d('W', 'w', 'high')];
    const rb = corpusByRole(before);
    const ra = corpusByRole(after);
    expect(corpusHash(rb.reader)).not.toBe(corpusHash(ra.reader));
    expect(corpusHash(rb.writer)).not.toBe(corpusHash(ra.writer));
  });

  it('role store names are fixed: one store per role, no hashes', () => {
    expect(toolStoreName('reader')).toBe('tools-reader');
    expect(toolStoreName('writer')).toBe('tools-writer');
  });

  it('the fingerprint hash is 12 hex chars and embedder-sensitive', () => {
    expect(fingerprintHash(fp)).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprintHash({ ...fp, embeddingModel: 'other' })).not.toBe(
      fingerprintHash(fp),
    );
  });

  it('a record is current only when both hashes match', () => {
    const docs = [d('A', 'a')];
    const attrs = toolRecordAttributes('reader', fp, docs);
    expect(attrs).toEqual({
      kind: 'tool-corpus',
      role: 'reader',
      fingerprint: fingerprintHash(fp),
      corpus: corpusHash(docs),
      count: 1,
    });
    expect(recordIsCurrent(attrs, fp, docs)).toBe(true);
    expect(recordIsCurrent(attrs, fp, [d('A', 'a2')])).toBe(false);
    expect(
      recordIsCurrent(attrs, { ...fp, embeddingModel: 'other' }, docs),
    ).toBe(false);
    expect(recordIsCurrent(undefined, fp, docs)).toBe(false);
    expect(recordIsCurrent('x', fp, docs)).toBe(false);
  });

  it('the committed AI Core bundle keeps its file name; others get their own', () => {
    expect(bundleFileFor(COMMITTED_BUNDLE_FINGERPRINT)).toBe(
      'tool-embeddings.json',
    );
    expect(bundleFileFor(fp)).toMatch(/^tool-embeddings\.[0-9a-f]{12}\.json$/);
  });
});

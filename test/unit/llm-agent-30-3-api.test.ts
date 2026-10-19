import { HanaVectorRagProvider } from '@mcp-abap-adt/hana-vector-rag';
import {
  isRagCatalogUpdater,
  isRagFilteredDeleter,
  isRagScanner,
  validateRagCatalogPatch,
} from '@mcp-abap-adt/llm-agent';
import { PgVectorRagProvider } from '@mcp-abap-adt/pg-vector-rag';
import { QdrantRagProvider } from '@mcp-abap-adt/qdrant-rag';

describe('llm-agent 30.3.0 API', () => {
  it('exports the RAG capability guards and the patch validator', () => {
    expect(typeof isRagScanner).toBe('function');
    expect(typeof isRagFilteredDeleter).toBe('function');
    expect(typeof isRagCatalogUpdater).toBe('function');
    expect(typeof validateRagCatalogPatch).toBe('function');
  });

  it.each([
    ['hana-vector', HanaVectorRagProvider],
    ['pg-vector', PgVectorRagProvider],
    ['qdrant', QdrantRagProvider],
  ])('%s provider exposes updateCollection', (_name, Ctor) => {
    expect(typeof Ctor.prototype.updateCollection).toBe('function');
  });
});

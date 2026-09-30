/**
 * Tool corpus identity: which role a tool belongs to, the fixed Qdrant store
 * per role, and the hashes that identify its content (recorded in the store's
 * catalog record) and the embedding bundle file for a given embedder.
 *
 * Deliberately does not import `../agent-manager` — that file imports this
 * one, and a two-way top-level import would be a runtime cycle.
 */
import { createHash } from 'node:crypto';
import type { EmbedderFingerprint } from './providers';

export type ToolRole = 'reader' | 'writer';

/** One shared-corpus doc: the upsert `id`, final `text`, exposition tag, cached flag. */
export type SharedCorpusDoc = {
  id: string;
  name: string;
  text: string;
  exposition?: string;
  cached: boolean;
};

/**
 * Which collection a tool belongs in, from its exposition group.
 *
 * The boundary is the ROLE boundary — exactly what `resolveExposition` grants —
 * NOT a fresh judgement about which tools modify. `high` is not a synonym for
 * modifiable: roughly 70 of its 156 tools are reads (GetPackage, GetDomain,
 * GetTable…). Deriving a second opinion here is how a collection drifts away
 * from the boundary the execution check actually enforces.
 */
export function collectionFor(exposition: string | undefined): ToolRole {
  return exposition === 'high' ||
    exposition === 'compact' ||
    exposition === 'low'
    ? 'writer'
    : 'reader';
}

/** The fingerprint of the committed, build-time AI Core embedding bundle. */
export const COMMITTED_BUNDLE_FINGERPRINT: EmbedderFingerprint = {
  provider: 'sap-ai-sdk',
  embeddingModel: 'text-embedding-3-small',
  resourceGroup: 'default',
};

const h12 = (s: string) =>
  createHash('sha256').update(s).digest('hex').slice(0, 12);

/** 12 hex chars identifying an embedder — provider, model, endpoint, resource group. */
export function fingerprintHash(fp: EmbedderFingerprint): string {
  return h12(
    JSON.stringify([
      fp.provider,
      fp.embeddingModel,
      fp.baseURL ?? '',
      fp.resourceGroup ?? '',
    ]),
  );
}

/** Split a shared corpus into its reader and writer collections. */
export function corpusByRole(
  docs: SharedCorpusDoc[],
): Record<ToolRole, SharedCorpusDoc[]> {
  const out: Record<ToolRole, SharedCorpusDoc[]> = { reader: [], writer: [] };
  for (const doc of docs) out[collectionFor(doc.exposition)].push(doc);
  return out;
}

/** 12 hex chars identifying a corpus's content — order-independent, text-sensitive. */
export function corpusHash(docs: SharedCorpusDoc[]): string {
  const pairs = docs.map((x) => `${x.id}\u0000${x.text}`).sort();
  return h12(pairs.join('\u0001'));
}

/**
 * The role's one Qdrant store (under the configured prefix). The name is fixed:
 * the store holds the CURRENT corpus only, and which embedder and corpus it
 * holds is recorded in its catalog record (`fingerprintHash`, `corpusHash`),
 * not in its name (spec §4.4).
 */
export function toolStoreName(role: ToolRole): string {
  return `tools-${role}`;
}

/** What a role store's catalog record carries: which embedder and corpus it holds. */
export type ToolRecordAttributes = {
  kind: 'tool-corpus';
  role: ToolRole;
  fingerprint: string;
  corpus: string;
  count: number;
};

/** The record attributes for a role store holding `docs`, embedded with `fp`. */
export function toolRecordAttributes(
  role: ToolRole,
  fp: EmbedderFingerprint,
  docs: SharedCorpusDoc[],
): ToolRecordAttributes {
  return {
    kind: 'tool-corpus',
    role,
    fingerprint: fingerprintHash(fp),
    corpus: corpusHash(docs),
    count: docs.length,
  };
}

/**
 * Whether a record's attributes say its store holds `docs` embedded with `fp`
 * — both hashes equal. The build step skips on true; startup loads only on true.
 */
export function recordIsCurrent(
  attributes: unknown,
  fp: EmbedderFingerprint,
  docs: SharedCorpusDoc[],
): boolean {
  if (!attributes || typeof attributes !== 'object') return false;
  const a = attributes as Record<string, unknown>;
  return a.fingerprint === fingerprintHash(fp) && a.corpus === corpusHash(docs);
}

/**
 * The bundle file for an embedder's fingerprint. The committed AI Core bundle
 * keeps its historical name (`srv/tool-embeddings.json`, loaded with zero
 * embedding calls at startup); every other fingerprint gets its own file so it
 * never overwrites or is mistaken for that one.
 */
export function bundleFileFor(fp: EmbedderFingerprint): string {
  return fingerprintHash(fp) === fingerprintHash(COMMITTED_BUNDLE_FINGERPRINT)
    ? 'tool-embeddings.json'
    : `tool-embeddings.${fingerprintHash(fp)}.json`;
}

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
  readOnlyHint?: boolean;
};

/** Collections follow MCP effects; absent annotations conservatively mean write. */
export function collectionFor(readOnlyHint: boolean | undefined): ToolRole {
  return readOnlyHint === true ? 'reader' : 'writer';
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

function resourceGroupFingerprints(
  fp: EmbedderFingerprint,
  resourceGroups: readonly string[],
): EmbedderFingerprint[] {
  return fp.provider === 'sap-ai-sdk'
    ? resourceGroups.map((resourceGroup) => ({ ...fp, resourceGroup }))
    : [];
}

/** Match hash-only records against the current fingerprint and configured AI Core groups. */
export function compatibleFingerprintHashes(
  fp: EmbedderFingerprint,
  resourceGroups: readonly string[] = [],
): ReadonlySet<string> {
  return new Set(
    [fp, ...resourceGroupFingerprints(fp, resourceGroups)].map(fingerprintHash),
  );
}

/** Match a stored fingerprint or catalog hash against the compatible identities. */
export function fingerprintMatches(
  stored: EmbedderFingerprint | string,
  runtime: EmbedderFingerprint,
  resourceGroups?: readonly string[],
): boolean {
  const storedHash =
    typeof stored === 'string' ? stored : fingerprintHash(stored);
  return compatibleFingerprintHashes(runtime, resourceGroups).has(storedHash);
}

/** Split a shared corpus into its reader and writer collections. */
export function corpusByRole(
  docs: SharedCorpusDoc[],
): Record<ToolRole, SharedCorpusDoc[]> {
  const out: Record<ToolRole, SharedCorpusDoc[]> = { reader: [], writer: [] };
  for (const doc of docs) out[collectionFor(doc.readOnlyHint)].push(doc);
  return out;
}

/** 12 hex chars identifying a corpus's content — order-independent, text-sensitive. */
export function corpusHash(docs: SharedCorpusDoc[]): string {
  const pairs = docs
    .map((x) => `${x.id}\u0000${x.text}\u0000${x.readOnlyHint === true}`)
    .sort();
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
 * — compatible embedder and identical corpus. Both build and startup use it.
 */
export function recordIsCurrent(
  attributes: unknown,
  fp: EmbedderFingerprint,
  docs: SharedCorpusDoc[],
  resourceGroups?: readonly string[],
): boolean {
  if (!attributes || typeof attributes !== 'object') return false;
  return (
    'fingerprint' in attributes &&
    typeof attributes.fingerprint === 'string' &&
    fingerprintMatches(attributes.fingerprint, fp, resourceGroups) &&
    'corpus' in attributes &&
    attributes.corpus === corpusHash(docs)
  );
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

/** Prefer the exact filename, then try the filenames for configured groups. */
export function bundleFilesFor(
  fp: EmbedderFingerprint,
  resourceGroups: readonly string[] = [],
): string[] {
  const fingerprints = [fp, ...resourceGroupFingerprints(fp, resourceGroups)];
  return [...new Set(fingerprints.map(bundleFileFor))];
}

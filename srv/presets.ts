// srv/presets.ts
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import cds from '@sap/cds';

import type { CollectionRegistry } from './rag-collections';

// ---------------------------------------------------------------------------
// Preset pack registry
// ---------------------------------------------------------------------------

export interface PresetPack {
  /** logical pack key — also the bundled content subdir name */
  key: string;
  /** human label shown in MANAGE */
  displayName: string;
  /** content subdir under srv/presets/ */
  dir: string;
}

export const PRESET_PACKS: readonly PresetPack[] = [
  { key: 'rap-skills', displayName: 'RAP Skills', dir: 'rap-skills' },
  { key: 'rap-context', displayName: 'RAP Context', dir: 'rap-context' },
] as const;

// ---------------------------------------------------------------------------
// User key helpers
// ---------------------------------------------------------------------------

/** Deterministic, sanitized, PII-free user key — lowercase hex. */
export function sanitizeUserKey(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

/** Per-user physical collection id, URL- and filesystem-safe. */
export function presetCollectionId(packKey: string, userId: string): string {
  return `${packKey}__u_${sanitizeUserKey(userId)}`;
}

// ---------------------------------------------------------------------------
// Bundled document loader
// ---------------------------------------------------------------------------

const PRESETS_ROOT = path.join(__dirname, 'presets');

export interface PresetDoc {
  id: string;
  text: string;
}

/** Read a pack's bundled markdown into docs keyed by filename (no extension). */
export function loadPackDocuments(packKey: string): PresetDoc[] {
  const dir = path.join(PRESETS_ROOT, packKey);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => ({
      id: f.replace(/\.md$/, ''),
      text: fs.readFileSync(path.join(dir, f), 'utf8'),
    }));
}

// ---------------------------------------------------------------------------
// ensurePresets
// ---------------------------------------------------------------------------

type DocLoader = (packKey: string) => PresetDoc[];

/**
 * Ensure each preset pack exists for the user and is fully seeded.
 * - Creates the per-user collection if absent (scope 'user', preset:true so
 *   the server's defaultEnabled = !preset rule makes it default OFF — opt-in).
 * - Adds only the documents currently missing (document-level idempotency),
 *   so a partial seed self-heals on the next call and user edits are kept.
 * - A single document failure is logged and skipped; the loop continues so
 *   the next open retries only that document.
 * `loadDocs` is injectable for tests; defaults to the bundled loader.
 */
export async function ensurePresets(
  registry: CollectionRegistry,
  userId: string,
  loadDocs: DocLoader = loadPackDocuments,
): Promise<void> {
  for (const pack of PRESET_PACKS) {
    const id = presetCollectionId(pack.key, userId);
    if (!registry.getCollection(id)) {
      registry.createCollection({
        id,
        logicalId: pack.key,
        displayName: pack.displayName,
        description: `Preset: ${pack.displayName}`,
        scope: 'user',
        owner: userId,
        preset: true,
      });
    }
    for (const doc of loadDocs(pack.key)) {
      if (!registry.getDocument(id, doc.id)) {
        try {
          await registry.addDocument(id, {
            id: doc.id,
            text: doc.text,
            metadata: { preset: pack.key },
          });
        } catch (err) {
          cds.log('presets').warn('preset doc seed failed', {
            collection: id,
            doc: doc.id,
            error: (err as Error).message,
          });
        }
      }
    }
  }
}

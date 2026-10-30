import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import type { RagDocument } from '../rag-collections';
import {
  type AgentProfileRecord,
  profileFrontmatter,
  validateAgentProfileRecord,
} from './agent-profile-records';

export interface AgentProfileSeedStore {
  /** Must resolve the exact global identity and await backend restoration. */
  ensureGlobal(): Promise<void>;
  read(): Promise<RagDocument[]>;
  /** One complete record per backend upsert. */
  upsert(record: AgentProfileRecord): Promise<RagDocument>;
}
export interface AgentProfileSeedFile {
  readonly filename: string;
  readonly content: string;
}
export function parseAgentProfileSeeds(
  files: readonly AgentProfileSeedFile[],
): AgentProfileRecord[] {
  const names = new Set<string>();
  return files.map(({ filename, content }) => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) throw new Error(`Invalid seed ${filename}: frontmatter`);
    let fields: ReturnType<typeof profileFrontmatter.safeParse>;
    try {
      fields = profileFrontmatter.safeParse(
        load(match[1], { schema: JSON_SCHEMA }),
      );
    } catch {
      throw new Error(`Invalid seed ${filename}: YAML`);
    }
    if (!fields.success)
      throw new Error(
        `Invalid seed ${filename}: ${fields.error.issues[0]?.path.join('.') || 'metadata'}`,
      );
    const metadata = fields.data;
    if (basename(filename, '.md') !== metadata.name)
      throw new Error(`Invalid seed ${filename}: name`);
    if (names.has(metadata.name))
      throw new Error(`Invalid seed ${filename}: duplicate name`);
    names.add(metadata.name);
    return {
      id: metadata.name,
      text: content.slice(match[0].length),
      metadata: { ...metadata, canonicalKey: metadata.name },
    };
  });
}
export async function loadAgentProfileSeeds(
  directory = join(__dirname, '../agent-profiles'),
): Promise<AgentProfileRecord[]> {
  const filenames = (await readdir(directory))
    .filter((name) => name.endsWith('.md'))
    .sort();
  const files = await Promise.all(
    filenames.map(async (filename) => ({
      filename,
      content: await readFile(join(directory, filename), 'utf8'),
    })),
  );
  return parseAgentProfileSeeds(files);
}
export async function seedAgentProfiles(
  store: AgentProfileSeedStore,
  seeds: readonly AgentProfileRecord[],
  plannerRecord: string,
): Promise<void> {
  // Validate everything before any mutation, even when stored records win.
  const names = new Set<string>();
  for (const seed of seeds) {
    validateAgentProfileRecord({ ...seed, createdAt: '' });
    if (names.has(seed.id)) throw new Error('Duplicate agent seed name');
    names.add(seed.id);
  }
  await store.ensureGlobal();
  const existing = await store.read();
  const validate = (documents: RagDocument[]): void => {
    const ids = new Set<string>();
    for (const document of documents) {
      const record = validateAgentProfileRecord(document);
      if (ids.has(record.id))
        throw new Error('Duplicate agent record identity');
      ids.add(record.id);
    }
  };
  validate(existing);
  for (const required of [
    'analyst',
    'executor',
    'checker',
    '_worker-base',
    plannerRecord,
  ])
    if (
      !names.has(required) &&
      !existing.some((record) => record.id === required)
    )
      throw new Error(`Missing required agent seed: ${required}`);
  for (const seed of seeds) {
    if (!existing.some((document) => document.id === seed.id))
      validateAgentProfileRecord(await store.upsert(seed));
  }
  const stored = await store.read();
  validate(stored);
  for (const required of [
    'analyst',
    'executor',
    'checker',
    '_worker-base',
    plannerRecord,
  ])
    if (!stored.some((record) => record.id === required))
      throw new Error(`Missing required agent record: ${required}`);
}

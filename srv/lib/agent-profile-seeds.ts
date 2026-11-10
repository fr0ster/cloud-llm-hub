import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import cds from '@sap/cds';
import { JSON_SCHEMA, load } from 'js-yaml';
import type { RagDocument } from '../rag-collections';
import {
  type AgentProfileRecord,
  profileFrontmatter,
  validateAgentProfileRecord,
} from './agent-profile-records';
import { awaitModelCatalog } from './model-catalog';

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
type MetadataValue =
  | string
  | number
  | boolean
  | undefined
  | MetadataValue[]
  | { [key: string]: MetadataValue };

function canonicalMetadata(value: MetadataValue): MetadataValue {
  if (Array.isArray(value)) return value.map(canonicalMetadata);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => [key, canonicalMetadata(field)]),
  );
}

export async function seedAgentProfiles(
  store: AgentProfileSeedStore,
  seeds: readonly AgentProfileRecord[],
  plannerRecord: string,
): Promise<void> {
  const pendingCatalog = awaitModelCatalog();
  if (pendingCatalog) await pendingCatalog;
  // Validate all seeds before mutation; release seeds replace changed built-ins.
  const names = new Set<string>();
  const validatedSeeds = seeds.map((seed) =>
    validateAgentProfileRecord({ ...seed, createdAt: '' }),
  );
  for (const seed of validatedSeeds) {
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
    'planner-create',
    'planner-revise',
  ])
    if (
      !names.has(required) &&
      !existing.some((record) => record.id === required)
    )
      throw new Error(`Missing required agent seed: ${required}`);
  const records = new Map(
    existing.map((document) => {
      const record = validateAgentProfileRecord(document);
      return [record.id, record];
    }),
  );
  const log = cds.log('agent-profiles');
  let updated = 0;
  for (const seed of validatedSeeds) {
    const record = records.get(seed.id);
    if (
      !record ||
      record.text !== seed.text ||
      JSON.stringify(canonicalMetadata(record.metadata)) !==
        JSON.stringify(canonicalMetadata(seed.metadata))
    ) {
      validateAgentProfileRecord(await store.upsert(seed));
      updated++;
      log.info('Built-in agent profile updated', { id: seed.id });
    }
  }
  const stored = await store.read();
  validate(stored);
  for (const required of [
    'analyst',
    'executor',
    'checker',
    '_worker-base',
    plannerRecord,
    'planner-create',
    'planner-revise',
  ])
    if (!stored.some((record) => record.id === required))
      throw new Error(`Missing required agent record: ${required}`);
  log.info('Built-in agent profiles synchronized', {
    updated,
    unchanged: validatedSeeds.length - updated,
  });
}

import { existsSync, readdirSync, readFileSync } from 'node:fs';
/**
 * The mandatory skill pool — composed here, fixed at deploy time.
 *
 * llm-agent is domain-agnostic: it vectorizes, matches and injects skills but has
 * no opinion on which ones matter. cloud-llm-hub is domain-aware, so the pool of
 * mandatory skills is decided here and logged at startup — it must be knowable
 * from a deploy log, not a function of what any user enabled.
 *
 * Sources, in merge order (later wins):
 *   1. the connected llm-agent plugin, if it exports a skillManager
 *   2. the in-code preset in `srv/skills/` — the product's own rules
 */
import path from 'node:path';
import type { ISkillManager } from '@mcp-abap-adt/llm-agent';
import { FileSystemSkillManager } from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';
import { JSON_SCHEMA, load } from 'js-yaml';
import { z } from 'zod';
import type { RagDocument } from '../rag-collections';
import {
  CompositeSkillManager,
  SkillKindConflict,
  type SkillSource,
  validateSkillKinds,
} from './composite-skill-manager';
import { collectionView, documentView } from './record-policy';
import type { TrustResolver } from './trust-resolver';

/** Absolute path to the in-code skills directory (`srv/skills`). */
export const SKILLS_DIR = path.join(__dirname, '..', 'skills');

export function buildSkillsPool(opts?: {
  dirs?: string[];
  pluginManager?: ISkillManager;
  resolver?: () => TrustResolver;
}): CompositeSkillManager {
  const dirs = opts?.dirs ?? [SKILLS_DIR];
  const sources: SkillSource[] = [];
  if (opts?.pluginManager) {
    sources.push({ source: 'plugin', manager: opts.pluginManager });
  }
  // Preset last: the product's own rules win a name collision.
  // Compare kinds here: the library wraps directory collisions in generic SkillError.
  for (const dir of dirs) {
    sources.push({
      source: `preset:${dir}`,
      manager: new FileSystemSkillManager([dir]),
    });
  }
  return new CompositeSkillManager(sources, opts?.resolver);
}

/** Log the resolved pool so the mandatory set is visible in the deploy log. */
export async function logSkillsPool(manager: ISkillManager): Promise<void> {
  const log = cds.log('skills');
  try {
    const validation = await validateSkillKinds(manager);
    if (!validation.ok) throw validation.error;
    const result = await manager.listSkills();
    if (!result.ok) {
      log.warn('skills pool unavailable', { error: result.error.message });
      return;
    }
    log.info('skills pool resolved', {
      count: result.value.length,
      names: result.value.map((s) => s.name),
    });
  } catch (err) {
    if (err instanceof SkillKindConflict) throw err;
    log.warn('skills pool logging failed', { error: String(err) });
  }
}

/** Read only front matter; skill content is never loaded or tagged here. */
export function skillKind(
  name: string,
  dirs: readonly string[] = [SKILLS_DIR],
): 'base' | 'informational' {
  let kind: 'base' | 'informational' = 'informational';
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = entry.isDirectory()
        ? path.join(dir, entry.name, 'SKILL.md')
        : path.join(dir, entry.name);
      if (!entry.isDirectory() && !entry.name.endsWith('.md')) continue;
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
      if (!front) continue;
      const parsed = z
        .object({
          name: z.string(),
          kind: z.enum(['base', 'informational']).optional(),
        })
        .parse(load(front, { schema: JSON_SCHEMA }));
      if (parsed.name === name) kind = parsed.kind ?? 'informational';
    }
  }
  return kind;
}

/** The same synchronous document projection, with the virtual source resolved first. */
export async function skillDocumentView(
  doc: RagDocument,
  resolver: TrustResolver,
) {
  return documentView(doc, await resolver.inputForSkill(doc.id));
}
export async function skillCollectionView(resolver: TrustResolver) {
  const input = await resolver.inputForSkill('');
  return collectionView(
    {
      id: '@skills',
      logicalId: '@skills',
      displayName: 'Skills',
      description: 'Global informational skills',
      scope: 'global',
      createdAt: '',
      documentCount: 0,
      sourceCount: 0,
      ...(input.collectionTrust !== undefined
        ? { trust: input.collectionTrust }
        : {}),
    },
    input,
  );
}
export async function informationalSkillDocuments(
  resolver: TrustResolver,
  manager: Pick<ISkillManager, 'listSkills'> = buildSkillsPool({
    resolver: () => resolver,
  }),
) {
  const skills = await manager.listSkills();
  if (!skills.ok) throw skills.error;
  return Promise.all(
    skills.value
      .filter((skill) => skill.meta.kind !== 'base')
      .map(async (skill) => {
        const content = await skill.getContent();
        if (!content.ok) throw content.error;
        return skillDocumentView(
          {
            id: skill.name,
            text: content.value,
            metadata: { description: skill.description },
            createdAt: '',
          },
          resolver,
        );
      }),
  );
}

/** Base instructions follow the profile; later correction messages retain precedence. */
export async function appendBaseSkills(
  prompt: string,
  pool: CompositeSkillManager,
): Promise<string> {
  const validation = await validateSkillKinds(pool);
  if (!validation.ok) throw validation.error;
  const bodies: string[] = [];
  for (const skill of await pool.baseSkills()) {
    const result = await skill.getContent();
    if (!result.ok) throw result.error;
    bodies.push(result.value);
  }
  return [prompt, ...bodies].filter(Boolean).join('\n\n');
}

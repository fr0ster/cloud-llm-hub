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
  type SkillSource,
} from './composite-skill-manager';
import { documentView } from './record-policy';
import type { TrustResolver } from './trust-resolver';

/** Absolute path to the in-code skills directory (`srv/skills`). */
export const SKILLS_DIR = path.join(__dirname, '..', 'skills');

export function buildSkillsPool(opts?: {
  dirs?: string[];
  pluginManager?: ISkillManager;
}): ISkillManager {
  const dirs = opts?.dirs ?? [SKILLS_DIR];
  const sources: SkillSource[] = [];
  if (opts?.pluginManager) {
    sources.push({ source: 'plugin', manager: opts.pluginManager });
  }
  // Preset last: the product's own rules win a name collision.
  sources.push({
    source: 'preset',
    manager: new FileSystemSkillManager(dirs),
  });
  return new CompositeSkillManager(sources);
}

/** Log the resolved pool so the mandatory set is visible in the deploy log. */
export async function logSkillsPool(manager: ISkillManager): Promise<void> {
  const log = cds.log('skills');
  try {
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
export async function informationalSkillDocuments(
  resolver: TrustResolver,
  manager: ISkillManager = buildSkillsPool(),
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

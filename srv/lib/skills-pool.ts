import { existsSync, readdirSync } from 'node:fs';
/**
 * The mandatory skill pool — composed here, fixed at deploy time.
 *
 * llm-agent is domain-agnostic: it vectorizes, matches and injects skills but has
 * no opinion on which ones matter. cloud-llm-hub is domain-aware, so the pool of
 * mandatory skills is decided here and logged at startup — it must be knowable
 * from a deploy log, not a function of what any user enabled.
 *
 * Sources (ids are independent of display names):
 *   1. the connected llm-agent plugin, if it exports a skillManager
 *   2. the in-code preset in `srv/skills/` — the product's own rules
 */
import path from 'node:path';
import type { ISkill, ISkillManager } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { RagDocument } from '../rag-collections';
import {
  CompositeSkillManager,
  type SkillSource,
} from './composite-skill-manager';
import { loadSkillFromDir } from './filesystem-skill';
import { collectionView, documentView } from './record-policy';
import type { TrustResolver } from './trust-resolver';
import { skillId } from './trusted-skill';

/** Absolute path to the in-code skills directory (`srv/skills`). */
export const SKILLS_DIR = path.join(__dirname, '..', 'skills');

export function buildSkillsPool(opts?: {
  dirs?: (string | { dir: string; source: string })[];
  pluginManager?: ISkillManager;
  resolver?: () => TrustResolver;
}): CompositeSkillManager {
  const dirs = opts?.dirs ?? [SKILLS_DIR];
  const sources: SkillSource[] = [];
  if (opts?.pluginManager) {
    sources.push({ source: 'plugin', manager: opts.pluginManager });
  }
  const labels = new Set<string>();
  for (const entry of dirs) {
    const dir = typeof entry === 'string' ? entry : entry.dir;
    const isHub = path.resolve(dir) === path.resolve(SKILLS_DIR);
    const source =
      typeof entry === 'string'
        ? path.basename(path.resolve(dir))
        : entry.source;
    if (!isHub && (!/^[\w.-]+$/.test(source) || labels.has(source))) {
      throw new Error(
        `Skill source label must be unique and path-free: ${source}`,
      );
    }
    if (!isHub) labels.add(source);
    let skills: ISkill[] = [];
    const refresh = () => {
      const discovered: ISkill[] = [];
      if (existsSync(dir)) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skill = loadSkillFromDir(path.join(dir, entry.name));
          if (!skill) continue;
          skill.meta.id =
            typeof skill.meta.id === 'string'
              ? skill.meta.id
              : isHub
                ? entry.name
                : `${source}/${entry.name}`;
          discovered.push(skill);
        }
      }
      skills = discovered;
    };
    // Like FileSystemSkillManager, discover before returning the manager. Agent
    // builds must not wait for filesystem I/O inside the processing pipeline.
    refresh();
    sources.push({
      source: isHub ? 'hub' : source,
      manager: {
        refresh,
        async listSkills() {
          return { ok: true, value: skills };
        },
        async getSkill(id, options) {
          const result = await this.listSkills(options);
          return result.ok
            ? {
                ok: true,
                value: result.value.find((skill) => skillId(skill) === id),
              }
            : result;
        },
        async matchSkills() {
          return { ok: true, value: [] };
        },
      },
    });
  }
  return new CompositeSkillManager(sources, opts?.resolver);
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
            id: skillId(skill),
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
  const bodies = await pool.baseSkillContents();
  return [prompt, ...bodies].filter(Boolean).join('\n\n');
}

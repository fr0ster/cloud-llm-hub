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
import {
  CompositeSkillManager,
  type SkillSource,
} from './composite-skill-manager';

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

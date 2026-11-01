/**
 * Merges several skill sources into ONE known pool.
 *
 * Why this exists: `builder.js` only falls back to a plugin's skill manager when
 * we set none (`if (plugins.skillManager && !this._skillManager)`). The moment we
 * call `withSkillManager`, the plugin's skills are silently discarded. Composing
 * them here is therefore mandatory, not a nicety.
 *
 * llm-agent is domain-agnostic; cloud-llm-hub is domain-aware, so deciding WHICH
 * skills are mandatory belongs here — and the pool is fixed at deploy time rather
 * than depending on what a user happened to enable.
 *
 * Skills are identified by id. Equal display names do not hide other skills.
 */
import path from 'node:path';
import type { ISkill, ISkillManager } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

import { resolverFor, type TrustResolver } from './trust-resolver';
import { skillId, withSkillTrust } from './trusted-skill';

export type SkillSource = {
  source: string;
  manager: ISkillManager & { refresh?: () => void | Promise<void> };
};

export class CompositeSkillManager implements ISkillManager {
  private readonly warnedAmbiguousIds = new Set<string>();
  private readonly baseContent = new Map<string, Promise<string>>();

  /** Reload source discovery and invalidate base bodies explicitly. */
  async refresh(): Promise<void> {
    this.baseContent.clear();
    await Promise.all(this.sources.map(({ manager }) => manager.refresh?.()));
  }

  /** Cache in-flight reads too, so concurrent agent builds share each body. */
  async baseSkillContents(): Promise<readonly string[]> {
    return Promise.all(
      (await this.baseSkills()).map((skill) => {
        const id = skillId(skill);
        let content =
          skill.meta.trustAmbiguous === true
            ? undefined
            : this.baseContent.get(id);
        if (!content) {
          content = skill.getContent().then((result) => {
            if (!result.ok) throw result.error;
            return result.value;
          });
          if (skill.meta.trustAmbiguous !== true)
            this.baseContent.set(id, content);
        }
        return content;
      }),
    );
  }

  constructor(
    private readonly sources: SkillSource[],
    private readonly resolver: () => TrustResolver = () => resolverFor({}),
  ) {}

  informationalSkills(): ISkillManager {
    const filter = async (
      options?: Parameters<ISkillManager['listSkills']>[0],
    ) => {
      const result = await this.listSkills(options);
      return result.ok
        ? {
            ...result,
            value: result.value
              .filter((s) => s.meta.kind !== 'base')
              .map((skill) => ({
                ...skill,
                name: skillId(skill),
                getContent: skill.getContent.bind(skill),
                listResources: skill.listResources.bind(skill),
                readResource: skill.readResource.bind(skill),
              })),
          }
        : result;
    };
    return {
      listSkills: filter,
      getSkill: async (name, options) => {
        const result = await filter(options);
        return result.ok
          ? { ok: true, value: result.value.find((s) => s.name === name) }
          : result;
      },
      matchSkills: async (text, options) => {
        const result = await filter(options);
        const q = text.toLowerCase();
        return result.ok
          ? {
              ...result,
              value: result.value.filter(
                (s) =>
                  s.name.toLowerCase().includes(q) ||
                  s.description.toLowerCase().includes(q),
              ),
            }
          : result;
      },
    };
  }
  async baseSkills(): Promise<readonly ISkill[]> {
    const result = await this.listSkills();
    if (!result.ok) throw result.error;
    return result.value.filter((s) => s.meta.kind === 'base');
  }

  async listSkills(
    options?: Parameters<ISkillManager['listSkills']>[0],
  ): ReturnType<ISkillManager['listSkills']> {
    const loaded: ISkill[] = [];
    for (const { source, manager } of this.sources) {
      try {
        const result = await manager.listSkills(options);
        if (!result.ok) {
          cds.log('skills').warn('skill source failed, skipping', {
            source,
            error: result.error.message,
          });
          continue;
        }
        const identities = result.value.map((skill) => {
          const location = skillLocation(skill);
          const key = location
            ? path.posix.isAbsolute(location) || /^[A-Za-z]:\//.test(location)
              ? path.posix.basename(location)
              : location
            : skill.name;
          const id =
            typeof skill.meta.id === 'string'
              ? skill.meta.id
              : `${source}/${key}`;
          return { skill, location, id };
        });
        for (const entry of identities) {
          const { skill, id } = entry;
          const ambiguous =
            identities.filter((other) => other.id === id).length > 1;
          if (ambiguous && !this.warnedAmbiguousIds.has(id)) {
            this.warnedAmbiguousIds.add(id);
            cds
              .log('skills')
              .warn('Ambiguous skill id; add an explicit `id` to each skill', {
                source,
                id,
              });
          }
          loaded.push({
            name: skill.name,
            description: skill.description,
            meta: { ...skill.meta, id, trustAmbiguous: ambiguous },
            getContent: skill.getContent.bind(skill),
            listResources: skill.listResources.bind(skill),
            readResource: skill.readResource.bind(skill),
          });
        }
      } catch (err) {
        cds.log('skills').warn('skill source threw, skipping', {
          source,
          error: String(err),
        });
      }
    }
    return {
      ok: true as const,
      value: loaded.map((skill) => {
        const resolve = this.resolver;
        return skill.meta.kind !== 'base'
          ? withSkillTrust(skill, async () =>
              skill.meta.trustAmbiguous === true
                ? resolve().classDefault('global')
                : resolve().skill(skillId(skill)),
            )
          : skill;
      }),
    };
  }

  async getSkill(
    name: string,
    options?: Parameters<ISkillManager['getSkill']>[1],
  ): ReturnType<ISkillManager['getSkill']> {
    const all = await this.listSkills(options);
    if (!all.ok) return all;
    return {
      ok: true as const,
      value: all.value.find((s) => skillId(s) === name),
    };
  }

  async matchSkills(
    text: string,
    options?: Parameters<ISkillManager['matchSkills']>[1],
  ): ReturnType<ISkillManager['matchSkills']> {
    const all = await this.listSkills(options);
    if (!all.ok) return all;
    const q = text.toLowerCase();
    return {
      ok: true as const,
      value: all.value.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      ),
    };
  }
}

/** Library filesystem skills expose dir; plugins may expose location metadata. */
function skillLocation(skill: ISkill): string | undefined {
  const directory = 'dir' in skill ? skill.dir : undefined;
  for (const value of [
    directory,
    skill.meta.relativePath,
    skill.meta.path,
    skill.meta.dir,
  ]) {
    if (typeof value === 'string' && value.length > 0)
      return value.replaceAll('\\', '/').replace(/\/$/, '');
  }
  return undefined;
}

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
 * Collision rule: sources are merged in order and the LAST one wins, mirroring
 * `scanDirsForSkills` ("duplicate names from later directories override earlier
 * ones"). Callers pass the in-code preset last so a plugin cannot silently
 * redefine one of the product's own rules.
 */
import type { ISkill, ISkillManager, Result } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

import { resolverFor, type TrustResolver } from './trust-resolver';
import { withSkillTrust } from './trusted-skill';

export class SkillKindConflict extends Error {
  readonly code = 'SKILL_KIND_CONFLICT';
  constructor(name: string) {
    super(`Skill ${name} has conflicting base and informational kinds`);
  }
}
export async function validateSkillKinds(
  pool: ISkillManager,
): Promise<Result<void, SkillKindConflict>> {
  try {
    const result = await pool.listSkills();
    if (!result.ok) {
      if (result.error instanceof SkillKindConflict)
        return { ok: false, error: result.error };
      throw result.error;
    }
    const kinds = new Map<string, boolean>();
    for (const skill of result.value) {
      const base = skill.meta.kind === 'base';
      const previous = kinds.get(skill.name);
      if (previous !== undefined && previous !== base)
        return { ok: false, error: new SkillKindConflict(skill.name) };
      kinds.set(skill.name, base);
    }
    return { ok: true, value: undefined };
  } catch (error) {
    if (error instanceof SkillKindConflict) return { ok: false, error };
    throw error;
  }
}

export type SkillSource = { source: string; manager: ISkillManager };

export class CompositeSkillManager implements ISkillManager {
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
            value: result.value.filter((s) => s.meta.kind !== 'base'),
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
    const byName = new Map<string, ISkill>();
    for (const { source, manager } of this.sources) {
      try {
        const result = await manager.listSkills(options);
        if (!result.ok) {
          if (result.error instanceof SkillKindConflict) throw result.error;
          cds.log('skills').warn('skill source failed, skipping', {
            source,
            error: result.error.message,
          });
          continue;
        }
        // Later source wins — see the collision rule above.
        for (const skill of result.value) {
          const previous = byName.get(skill.name);
          if (
            previous &&
            (previous.meta.kind === 'base') !== (skill.meta.kind === 'base')
          )
            throw new SkillKindConflict(skill.name);
          byName.set(skill.name, skill);
        }
      } catch (err) {
        if (err instanceof SkillKindConflict) throw err;

        cds.log('skills').warn('skill source threw, skipping', {
          source,
          error: String(err),
        });
      }
    }
    return {
      ok: true as const,
      value: [...byName.values()].map((skill) => {
        const resolve = this.resolver;
        return skill.meta.kind !== 'base'
          ? withSkillTrust(skill, () => resolve().skill(skill.name))
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
    return { ok: true as const, value: all.value.find((s) => s.name === name) };
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

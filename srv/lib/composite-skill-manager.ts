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
import type { ISkill, ISkillManager } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

export type SkillSource = { source: string; manager: ISkillManager };

export class CompositeSkillManager implements ISkillManager {
  constructor(private readonly sources: SkillSource[]) {}

  async listSkills(
    options?: Parameters<ISkillManager['listSkills']>[0],
  ): ReturnType<ISkillManager['listSkills']> {
    const byName = new Map<string, ISkill>();
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
        // Later source wins — see the collision rule above.
        for (const skill of result.value) byName.set(skill.name, skill);
      } catch (err) {
        cds.log('skills').warn('skill source threw, skipping', {
          source,
          error: String(err),
        });
      }
    }
    return { ok: true as const, value: [...byName.values()] };
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

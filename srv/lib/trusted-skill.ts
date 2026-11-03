import {
  formatTrustTag,
  type ISkill,
  type ISkillManager,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import type { TrustResolver } from './trust-resolver';

/** Managers assign ids before composition; standalone legacy skills retain their external key. */
export function skillId(skill: ISkill): string {
  return typeof skill.meta.id === 'string' ? skill.meta.id : skill.name;
}

const originals = new WeakMap<ISkill, ISkill>();

/** Tool projections expose the original body, with trust carried in attributes. */
export function untaggedSkillContent(
  skill: ISkill,
): ReturnType<ISkill['getContent']> {
  return (originals.get(skill) ?? skill).getContent();
}

/** Preserve the skill receiver, metadata and resources; resolve trust on each read. */
export function withSkillTrust(
  skill: ISkill,
  trust: () => Promise<number>,
): ISkill {
  const original = originals.get(skill) ?? skill;
  const wrapped = new Proxy(original, {
    get(target, property) {
      if (property === 'getContent')
        return async (...args: Parameters<ISkill['getContent']>) => {
          const result = await target.getContent(...args);
          return result.ok
            ? {
                ...result,
                value: `${formatTrustTag(`${target.meta.kind === 'correction' ? 'correction' : 'system'}:skills/${skillId(target)}`, await trust())}\n${result.value}`,
              }
            : result;
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  originals.set(wrapped, original);
  return wrapped;
}

/** Selection descriptions share the same live source as selected skill bodies. */
export async function trustedSkillResults(
  rows: RagResult[],
  resolver: TrustResolver,
  manager?: Pick<ISkillManager, 'listSkills'>,
): Promise<RagResult[]> {
  const skills = await manager?.listSkills();
  if (skills && !skills.ok) throw skills.error;
  const ambiguous = new Set(
    skills?.value
      .filter((skill) => skill.meta.trustAmbiguous === true)
      .map(skillId),
  );
  return Promise.all(
    rows.map(async (row) => {
      const id = row.metadata.id;
      if (typeof id !== 'string' || !id.startsWith('skill:')) return row;
      const name = id.slice('skill:'.length);
      return {
        ...row,
        metadata: {
          ...row.metadata,
          source: `${skills?.value.find((skill) => skillId(skill) === name)?.meta.kind === 'correction' ? 'correction' : 'system'}:skills/${name}`,
          trust: await resolver.skill(
            name,
            ambiguous.has(name),
            skills?.value.find((skill) => skillId(skill) === name)?.meta
              .kind === 'correction'
              ? 'correction'
              : 'system',
          ),
        },
      };
    }),
  );
}

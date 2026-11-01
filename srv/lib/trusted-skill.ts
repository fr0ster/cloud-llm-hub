import {
  formatTrustTag,
  type ISkill,
  type RagResult,
} from '@mcp-abap-adt/llm-agent';
import type { TrustResolver } from './trust-resolver';

const originals = new WeakMap<ISkill, ISkill>();

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
                value: `${formatTrustTag(`global:skills/${target.name}`, await trust())}\n${result.value}`,
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
): Promise<RagResult[]> {
  return Promise.all(
    rows.map(async (row) => {
      const id = row.metadata.id;
      if (typeof id !== 'string' || !id.startsWith('skill:')) return row;
      const name = id.slice('skill:'.length);
      return {
        ...row,
        metadata: {
          ...row.metadata,
          source: `global:skills/${name}`,
          trust: await resolver.skill(name),
        },
      };
    }),
  );
}

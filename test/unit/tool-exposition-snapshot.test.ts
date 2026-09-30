import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_LOCAL_TOOL_EXPOSITIONS } from '../../srv/lib/cloud-local-tools';
import {
  type ExpositionLevel,
  resolveExposition,
} from '../../srv/lib/exposition';
import {
  buildToolExpositionMap,
  HANDLER_GROUPS,
} from '../../srv/lib/tool-exposition-map';
import { lowLevelOnlyTools } from './helpers/low-level-tools';

const SNAPSHOT = join(__dirname, '..', 'fixtures', 'tool-exposition.json');
const REGENERATE = 'npx tsx tools/generate-tool-exposition.ts';

interface Snapshot {
  totals: { tools: number; byLevel: Record<string, number> };
  tools: Record<string, string>;
}

const snapshot: Snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const live = buildToolExpositionMap(CLOUD_LOCAL_TOOL_EXPOSITIONS);

// The map decides who may execute what. These tests do not establish which
// level a tool BELONGS in — that is a human judgement, taken when the upstream
// package split its tools into sets. What they do is make sure the judgement is
// complete, and that it cannot change without somebody seeing it.
describe('tool → exposition map: completeness', () => {
  it('classifies every tool it knows about', () => {
    const unclassified = [...live.entries()]
      .filter(([, level]) => !level)
      .map(([tool]) => tool);
    expect(unclassified).toEqual([]);
  });

  it('uses only known levels', () => {
    const known = new Set<string>(HANDLER_GROUPS);
    const strange = [...live.entries()]
      .filter(([, level]) => !known.has(level))
      .map(([tool, level]) => `${tool}=${level}`);
    expect(strange).toEqual([]);
  });

  it('leaves no tool reachable without a role', () => {
    // resolveExposition([]) is empty, so nothing may be reached — the check in
    // assertToolAllowed refuses on an empty allow-list. This asserts the two
    // ends agree: no level is granted to a caller with no role.
    expect(resolveExposition([])).toEqual([]);
  });
});

describe('tool → exposition map: no silent drift', () => {
  it('matches the committed snapshot', () => {
    const current: Record<string, string> = {};
    for (const name of [...live.keys()].sort()) {
      current[name] = live.get(name) as string;
    }

    // A failure here is not necessarily a bug — an upstream release may have
    // added or moved tools. It means: look at the diff, decide whether the new
    // classification is right, then `${REGENERATE}`.
    expect(current).toEqual(snapshot.tools);
  });

  it('keeps the totals it claims', () => {
    expect(live.size).toBe(snapshot.totals.tools);
    for (const [level, count] of Object.entries(snapshot.totals.byLevel)) {
      const actual = [...live.values()].filter((l) => l === level).length;
      expect(`${level}=${actual}`).toBe(`${level}=${count}`);
    }
  });
});

describe('what each level actually reaches', () => {
  const reachable = (roles: string[]): string[] => {
    const allowed = new Set<ExpositionLevel>(resolveExposition(roles));
    return [...live.entries()]
      .filter(([, level]) => allowed.has(level))
      .map(([tool]) => tool);
  };

  it('never lets a reader reach a tool tagged high', () => {
    const readerTools = new Set(reachable(['MCP_Reader']));
    const forbidden = [...live.entries()]
      .filter(([, l]) => l === 'high')
      .filter(([tool]) => readerTools.has(tool))
      .map(([tool]) => tool);
    expect(forbidden).toEqual([]);
  });

  // The hub serves neither the low-level API nor the compact facade, so no
  // tool of theirs is in the map — and a tool not in the map is refused to
  // everyone (assertToolAllowed fails closed on an unclassified tool).
  it('classifies no low-level or compact tool', () => {
    const lowOnly = new Set(lowLevelOnlyTools());
    const stray = [...live.keys()].filter(
      (t) => lowOnly.has(t) || /^Handler[A-Z]/.test(t),
    );
    expect(stray).toEqual([]);
  });
});

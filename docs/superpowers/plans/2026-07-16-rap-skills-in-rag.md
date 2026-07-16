# RAP Skills in RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make our RAP rules actually reach the executor, so creating ABAP objects follows verified rules instead of the model's general (often wrong) ABAP knowledge.

**Architecture:** llm-agent already vectorizes skills into `toolsRag` as `skill:<name>`, matches them through the same RAG query it uses for tools, and injects their content into the system message. Two things block us: our own `ExpositionFilteringRag` drops every skill (they carry no `exposition` metadata), and setting `withSkillManager` silently discards a plugin's skills. So we unblock the filter, compose a deterministic deploy-time pool (plugin + in-code preset), and write real content.

**Tech Stack:** TypeScript, `@mcp-abap-adt/llm-agent` + `llm-agent-libs` 17.0.0 (`FileSystemSkillManager`, `scanDirsForSkills`, `ISkillManager`), Jest, Biome.

## Global Constraints

- **All artifacts in English** — code, comments, docs, SKILL.md content, commit messages.
- **Never write ABAP rules from general knowledge.** Every rule is read from the live system (DEV, package `TEST_RAG_APP`, 19 `ZDEMO01_*` objects) and reviewed by the user. General ABAP knowledge is likely wrong for a given system.
- **Naming policy is the customer's.** Skills state only what the platform requires; say "name per the project's policy". `ZDEMO01_`/`T`/`D`/`DOM_`/`DE_` may appear only as clearly labelled illustration, never as a rule.
- **Nothing moves.** `srv/presets/rap-skills/`, `srv/presets/rap-context/`, `docs/tutorials/rap-bo-book-catalog/**` and their tests (`presets.test.ts`, `presets-content-drift.test.ts`) stay untouched. `srv/skills/` is new and additive.
- **Only `description` is matched semantically.** The builder embeds `Skill: <name>\n<description>`; the body is injected only after a match. Write descriptions as the request a user would make.
- **Skills are never on the critical path.** Any skill failure → `warn` log, continue without skills. Never fail a request.
- **The bypass must be narrow:** only ids starting with `skill:`. Untagged **tools** must still be dropped (v6.22.0 security fix).
- Skill layout is fixed by the library: `srv/skills/<name>/SKILL.md`, YAML frontmatter with `name` + `description`, body = content.
- Run `npx biome check --write srv test` before each commit; `npx tsc --noEmit` and `npx jest test/unit/` must pass.

---

### Task 1: Let `skill:*` through the exposition filter

The blocker. Without this the whole feature is a silent no-op: the builder upserts skills with empty metadata, and our filter drops anything untagged.

**Files:**
- Modify: `srv/agent-manager.ts` (the `filtered` predicate inside `ExpositionFilteringRag.query`, ~line 176)
- Test: `test/unit/exposition-filtering-rag.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ExpositionFilteringRag` now passes results whose `metadata.id` starts with `skill:` regardless of `exposition`; everything else keeps the v6.22.0 behaviour (untagged → dropped when a role filter is active).

- [ ] **Step 1: Write the failing test**

Create `test/unit/exposition-filtering-rag.test.ts`:

```ts
import { ExpositionFilteringRag } from '../../srv/agent-manager';

type Row = { score: number; metadata: Record<string, unknown> };

function innerWith(rows: Row[]) {
  return {
    query: async () => ({ ok: true as const, value: rows }),
    writer: () => undefined,
  };
}

describe('ExpositionFilteringRag exposition filter', () => {
  const rows: Row[] = [
    { score: 0.9, metadata: { id: 'tool:CreateDomain', exposition: 'high' } },
    { score: 0.8, metadata: { id: 'tool:HandlerLowLevel' } }, // untagged tool
    { score: 0.7, metadata: { id: 'skill:creating-draft-table' } }, // untagged skill
  ];

  it('keeps skill:* even though they carry no exposition', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).toContain('skill:creating-draft-table');
  });

  it('still drops an untagged TOOL when a role filter is active', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {
      ragFilter: { exposition: ['high'] },
    });
    if (!res.ok) throw new Error('query failed');
    const ids = res.value.map((r) => r.metadata.id);
    expect(ids).not.toContain('tool:HandlerLowLevel');
    expect(ids).toContain('tool:CreateDomain');
  });

  it('returns everything when no role filter is active', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const rag = new ExpositionFilteringRag(innerWith(rows) as any);
    const res = await rag.query({} as never, 10, {});
    if (!res.ok) throw new Error('query failed');
    expect(res.value).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/exposition-filtering-rag.test.ts -t 'keeps skill'`
Expected: FAIL — `skill:creating-draft-table` is missing (filtered out because it has no `exposition`).

- [ ] **Step 3: Write minimal implementation**

In `srv/agent-manager.ts`, replace the `filtered` predicate:

```ts
    const allowed = new Set(allowedExpositions);
    const filtered = result.value.filter((r) => {
      // Skills are instruction TEXT, not callable tools. `exposition` gates tool
      // ACCESS; a skill cannot be invoked, so role-filtering it would only hide
      // rules while changing nothing about what the caller may do. The builder
      // upserts them with empty metadata (`upsertRaw('skill:<name>', text, {})`),
      // so without this they would all be dropped and skill injection would
      // silently do nothing. Narrow on purpose: ONLY the `skill:` prefix — an
      // untagged TOOL must still be dropped (the v6.22.0 bypass fix).
      const id = r.metadata.id;
      if (typeof id === 'string' && id.startsWith('skill:')) return true;
      return (
        !!r.metadata.exposition && allowed.has(r.metadata.exposition as string)
      );
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/unit/exposition-filtering-rag.test.ts test/unit/exposition.test.ts`
Expected: PASS — all three new tests plus the existing exposition suite.

- [ ] **Step 5: Commit**

```bash
npx biome check --write srv test
npx tsc --noEmit
git add srv/agent-manager.ts test/unit/exposition-filtering-rag.test.ts
git commit -m "fix(rag): let skill:* through the exposition filter

The builder upserts skills as skill:<name> with EMPTY metadata, and our
exposition filter drops anything untagged (the v6.22.0 bypass fix). Both chat
and execute_step always pass ragFilter.exposition, so every skill was being
discarded — skill injection would have been a silent no-op.

Skills are instruction text, not callable tools: exposition gates tool ACCESS,
and a skill cannot be invoked. Role-filtering them would hide rules without
changing what the caller may do. The bypass is narrow — only the skill: prefix;
an untagged TOOL is still dropped."
```

---

### Task 2: `CompositeSkillManager`

`builder.js:880` reads `if (plugins.skillManager && !this._skillManager)` — setting ours silently discards the plugin's. To have a pool of *both*, we must merge them ourselves.

**Files:**
- Create: `srv/lib/composite-skill-manager.ts`
- Test: `test/unit/composite-skill-manager.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `class CompositeSkillManager implements ISkillManager` with constructor `(sources: SkillSource[])` where `type SkillSource = { source: string; manager: ISkillManager }`. Sources are merged in order — **later wins** a name collision. Exposes `listSkills`, `getSkill`, `matchSkills`. Also exports `type SkillSource`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/composite-skill-manager.test.ts`:

```ts
import {
  CompositeSkillManager,
  type SkillSource,
} from '../../srv/lib/composite-skill-manager';

function skill(name: string, description: string, body: string) {
  return {
    name,
    description,
    meta: { name, description },
    getContent: async () => ({ ok: true as const, value: body }),
    listResources: async () => ({ ok: true as const, value: [] }),
    readResource: async () => ({ ok: true as const, value: '' }),
  };
}

function manager(skills: ReturnType<typeof skill>[]) {
  return {
    listSkills: async () => ({ ok: true as const, value: skills }),
    getSkill: async (n: string) => ({
      ok: true as const,
      value: skills.find((s) => s.name === n),
    }),
    matchSkills: async () => ({ ok: true as const, value: skills }),
  };
}

function failingManager() {
  return {
    listSkills: async () => ({
      ok: false as const,
      error: new Error('plugin exploded'),
    }),
    getSkill: async () => ({ ok: false as const, error: new Error('nope') }),
    matchSkills: async () => ({ ok: false as const, error: new Error('nope') }),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test doubles
const src = (source: string, m: any): SkillSource => ({ source, manager: m });

describe('CompositeSkillManager', () => {
  it('merges skills from every source', async () => {
    const c = new CompositeSkillManager([
      src('plugin', manager([skill('a', 'desc a', 'body a')])),
      src('preset', manager([skill('b', 'desc b', 'body b')])),
    ]);
    const r = await c.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value.map((s) => s.name).sort()).toEqual(['a', 'b']);
  });

  it('later source wins a name collision', async () => {
    const c = new CompositeSkillManager([
      src('plugin', manager([skill('dup', 'plugin desc', 'plugin body')])),
      src('preset', manager([skill('dup', 'preset desc', 'preset body')])),
    ]);
    const r = await c.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value).toHaveLength(1);
    const content = await r.value[0].getContent();
    if (!content.ok) throw new Error('getContent failed');
    expect(content.value).toBe('preset body');
  });

  it('a failing source is skipped, the rest still load', async () => {
    const c = new CompositeSkillManager([
      src('plugin', failingManager()),
      src('preset', manager([skill('b', 'desc b', 'body b')])),
    ]);
    const r = await c.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value.map((s) => s.name)).toEqual(['b']);
  });

  it('getSkill finds by exact name', async () => {
    const c = new CompositeSkillManager([
      src('preset', manager([skill('b', 'desc b', 'body b')])),
    ]);
    const r = await c.getSkill('b');
    if (!r.ok) throw new Error('getSkill failed');
    expect(r.value?.name).toBe('b');
    const missing = await c.getSkill('nope');
    if (!missing.ok) throw new Error('getSkill failed');
    expect(missing.value).toBeUndefined();
  });

  it('matchSkills does case-insensitive substring on name and description', async () => {
    const c = new CompositeSkillManager([
      src(
        'preset',
        manager([
          skill('creating-draft-table', 'Create the draft table', 'body'),
          skill('creating-domain', 'Create a domain', 'body'),
        ]),
      ),
    ]);
    const r = await c.matchSkills('DRAFT');
    if (!r.ok) throw new Error('matchSkills failed');
    expect(r.value.map((s) => s.name)).toEqual(['creating-draft-table']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/composite-skill-manager.test.ts`
Expected: FAIL — `Cannot find module '../../srv/lib/composite-skill-manager'`.

- [ ] **Step 3: Write minimal implementation**

Create `srv/lib/composite-skill-manager.ts`:

```ts
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

  async listSkills(options?: Parameters<ISkillManager['listSkills']>[0]) {
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

  async getSkill(name: string, options?: { signal?: AbortSignal }) {
    const all = await this.listSkills(options);
    if (!all.ok) return all;
    return { ok: true as const, value: all.value.find((s) => s.name === name) };
  }

  async matchSkills(text: string, options?: { signal?: AbortSignal }) {
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
```

Note: `matchSkills` is implemented for contract completeness only — our flow never calls it (skills are matched via RAG results keyed `skill:<name>`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/unit/composite-skill-manager.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
npx biome check --write srv test
npx tsc --noEmit
git add srv/lib/composite-skill-manager.ts test/unit/composite-skill-manager.test.ts
git commit -m "feat(skills): add CompositeSkillManager

builder.js only uses a plugin's skillManager when we set none, so calling
withSkillManager silently discards it. Merging the sources ourselves is the only
way to have a pool of both.

llm-agent is domain-agnostic; cloud-llm-hub is domain-aware, so deciding which
skills are mandatory belongs here, and the pool is fixed at deploy time rather
than depending on what a user enabled. Later source wins a collision (mirroring
scanDirsForSkills), so callers pass the in-code preset last. A failing source is
logged and skipped — skills are never on the critical path."
```

---

### Task 3: Build the pool and wire it into the agent

**Files:**
- Create: `srv/lib/skills-pool.ts`
- Create: `srv/skills/.gitkeep` (the directory must exist; content arrives in Task 4)
- Modify: `srv/agent-manager.ts` (the `SmartAgentBuilder` chain, next to `builder.setToolsRag(toolsRag)` ~line 1704)
- Test: `test/unit/skills-pool.test.ts` (create)

**Interfaces:**
- Consumes: `CompositeSkillManager`, `type SkillSource` from Task 2.
- Produces: `buildSkillsPool(opts?: { dirs?: string[]; pluginManager?: ISkillManager }): ISkillManager` — returns a composite over `[plugin?, preset]` (preset last, so it wins). Also `SKILLS_DIR` (absolute path to `srv/skills`). `logSkillsPool(manager): Promise<void>` logs the resolved pool once at startup.

- [ ] **Step 1: Write the failing test**

Create `test/unit/skills-pool.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSkillsPool } from '../../srv/lib/skills-pool';

function writeSkill(baseDir: string, name: string, description: string, body: string) {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

describe('buildSkillsPool', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('loads skills from the skills directory', async () => {
    writeSkill(tmp, 'creating-draft-table', 'Create the draft table', 'rules here');
    const pool = buildSkillsPool({ dirs: [tmp] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value.map((s) => s.name)).toEqual(['creating-draft-table']);
    expect(r.value[0].description).toBe('Create the draft table');
  });

  it('a missing directory yields an empty pool, not a throw', async () => {
    const pool = buildSkillsPool({ dirs: [path.join(tmp, 'does-not-exist')] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value).toEqual([]);
  });

  it('the in-code preset wins over a plugin skill of the same name', async () => {
    writeSkill(tmp, 'dup', 'preset desc', 'preset body');
    const pluginManager = {
      listSkills: async () => ({
        ok: true as const,
        value: [
          {
            name: 'dup',
            description: 'plugin desc',
            meta: { name: 'dup', description: 'plugin desc' },
            getContent: async () => ({ ok: true as const, value: 'plugin body' }),
            listResources: async () => ({ ok: true as const, value: [] }),
            readResource: async () => ({ ok: true as const, value: '' }),
          },
        ],
      }),
      getSkill: async () => ({ ok: true as const, value: undefined }),
      matchSkills: async () => ({ ok: true as const, value: [] }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const pool = buildSkillsPool({ dirs: [tmp], pluginManager: pluginManager as any });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value).toHaveLength(1);
    const content = await r.value[0].getContent();
    if (!content.ok) throw new Error('getContent failed');
    expect(content.value).toBe('preset body');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/skills-pool.test.ts`
Expected: FAIL — `Cannot find module '../../srv/lib/skills-pool'`.

- [ ] **Step 3: Write minimal implementation**

Create `srv/lib/skills-pool.ts`:

```ts
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
```

Then in `srv/agent-manager.ts`, add the import next to the other `./lib/*` imports:

```ts
import { buildSkillsPool, logSkillsPool } from './lib/skills-pool';
```

and wire it immediately after `builder.setToolsRag(toolsRag);`:

```ts
  // Tools RAG store for MCP tool selection (auto-vectorized)
  builder.setToolsRag(toolsRag);

  // Mandatory skill pool. The builder vectorizes each skill into toolsRag as
  // `skill:<name>` = "Skill: <name>\n<description>" and the hardcoded flow
  // injects the matched skill's body into the system message. Wired here (agent
  // level), so chat and execute_step behave identically.
  const skillsPool = buildSkillsPool();
  builder.withSkillManager(skillsPool);
  await logSkillsPool(skillsPool);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/unit/skills-pool.test.ts && npx tsc --noEmit`
Expected: PASS — 3 tests, and a clean typecheck.

- [ ] **Step 5: Verify the full unit suite is still green**

Run: `npx jest test/unit/`
Expected: PASS — every suite, including `presets.test.ts` and `presets-content-drift.test.ts` untouched.

- [ ] **Step 6: Commit**

```bash
npx biome check --write srv test
git add srv/lib/skills-pool.ts srv/skills/.gitkeep srv/agent-manager.ts test/unit/skills-pool.test.ts
git commit -m "feat(skills): compose the mandatory pool and wire it into the agent

llm-agent is domain-agnostic; cloud-llm-hub is domain-aware, so the pool of
mandatory skills is decided here and logged at startup — knowable from a deploy
log rather than a function of what a user enabled.

Sources merge plugin-then-preset, so the in-code preset wins a collision. Wired
at the agent level next to setToolsRag, so chat and execute_step behave
identically with no per-request deps hack. A missing directory yields an empty
pool rather than an error — skills are never on the critical path."
```

---

### Task 4: The first real skill — `creating-draft-table`

The worked example from the spec, and the end-to-end proof that a skill reaches the model.

**Files:**
- Create: `srv/skills/creating-draft-table/SKILL.md`
- Test: `test/unit/skills-content.test.ts` (create)

**Interfaces:**
- Consumes: `SKILLS_DIR`, `buildSkillsPool` from Task 3.
- Produces: the first shipped skill; the content pattern every later skill follows (description = the user's request, body = platform rules only).

- [ ] **Step 1: Write the failing test**

Create `test/unit/skills-content.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { buildSkillsPool } from '../../srv/lib/skills-pool';

const SKILLS_SRC = path.join(__dirname, '..', '..', 'srv', 'skills');

describe('shipped skills', () => {
  it('every skill dir has a SKILL.md with name and description frontmatter', () => {
    const dirs = fs
      .readdirSync(SKILLS_SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const md = fs.readFileSync(path.join(SKILLS_SRC, d, 'SKILL.md'), 'utf8');
      expect(md).toMatch(/^---\n[\s\S]*?\nname:\s*\S+/m);
      expect(md).toMatch(/\ndescription:\s*\S+/);
    }
  });

  it('ships creating-draft-table with the CDS-element naming rule', async () => {
    const pool = buildSkillsPool({ dirs: [SKILLS_SRC] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    const skill = r.value.find((s) => s.name === 'creating-draft-table');
    expect(skill).toBeDefined();
    const content = await skill!.getContent();
    if (!content.ok) throw new Error('getContent failed');
    expect(content.value).toContain('sych_bdl_draft_admin_inc');
    expect(content.value.toLowerCase()).toContain('cds element');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/skills-content.test.ts`
Expected: FAIL — the skills directory has no subdirectories yet (`expect(dirs.length).toBeGreaterThan(0)`).

- [ ] **Step 3: Write the skill**

Create `srv/skills/creating-draft-table/SKILL.md`:

```markdown
---
name: creating-draft-table
description: Create the draft table for a RAP business object with draft enabled — how its fields are named, which keys it takes, and the draft admin include
---

# Creating a draft table

The draft table mirrors the persistent table. Same types, **different field names**.

## Field names — the rule that trips people up

Draft fields are named after the **CDS element names**, not the persistent table's
database field names: lowercase, **no underscores**. The CDS view exposes a persistent
field `book_uuid` as the element `BookUuid`, so the draft field is `bookuuid`.

| Persistent field | CDS element | Draft field |
|---|---|---|
| `book_uuid` | `BookUuid` | `bookuuid` |
| `pub_year` | `PubYear` | `pubyear` |
| `currency_code` | `CurrencyCode` | `currencycode` |
| `local_last_changed_at` | `LocalLastChangedAt` | `locallastchangedat` |

(Names above are an illustration from one example object — apply the rule, not the names.
Object names themselves follow the project's own naming policy.)

## Keys

`key client : abap.clnt not null`, then the persistent table's key fields — in CDS
naming. Types stay identical to the persistent table (a `sysuuid_x16` key stays
`sysuuid_x16`).

## Mandatory include

Every draft table ends with the draft administration include:

```abap
"%admin" : include sych_bdl_draft_admin_inc;
```

## Currency and quantity semantics

`@Semantics.amount.currencyCode` must point at the **draft table's own** currency field,
never at the persistent table's:

```abap
@Semantics.amount.currencyCode : 'zdemo01_dbook.currencycode'
price : zdemo01_de_price;
```

## Shape

```abap
@EndUserText.label : 'Draft: <entity>'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table <draft_table> {
  key client         : abap.clnt not null;
  key <key>          : sysuuid_x16 not null;
  <business fields, CDS-element names, same data elements as the persistent table>
  createdby          : abp_creation_user;
  createdat          : abp_creation_time;
  lastchangedby      : abp_lastchange_user;
  lastchangedat      : abp_lastchange_time;
  locallastchangedat : abp_locinst_lastchange_time;
  "%admin"           : include sych_bdl_draft_admin_inc;
}
```
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/unit/skills-content.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Verify against the live system (the rule must match reality)**

Read the real draft table on DEV and confirm the skill states the same rule.

Run (via the `acme_dev` MCP, one `execute_step`):
> `Show the complete definition of the draft table ZDEMO01_DBOOK in package TEST_RAG_APP: every field name in order, which fields are keys, and each field's type or data element, including any include. Quote the actual definition verbatim. Read-only.`

Expected: keys `client` + `bookuuid`; fields `pubyear`, `currencycode`, `createdby`, `createdat`, `lastchangedby`, `lastchangedat`, `locallastchangedat`; final line `"%admin" : include sych_bdl_draft_admin_inc;`; `@Semantics.amount.currencyCode : 'zdemo01_dbook.currencycode'`.

If reality differs from the skill, **the skill is wrong — fix the skill**, never the other way round.

- [ ] **Step 6: Commit**

```bash
npx biome check --write srv test
git add srv/skills/creating-draft-table/SKILL.md test/unit/skills-content.test.ts
git commit -m "feat(skills): add creating-draft-table, sourced from the live system

The first real skill. Every rule was read from the working RAP BO on DEV
(package TEST_RAG_APP): the draft/persistent table pair ZDEMO01_DBOOK/ZDEMO01_TBOOK
was diffed to derive the actual naming rule, rather than written from general
ABAP knowledge.

The rule: draft fields are named after the CDS ELEMENT names (lowercase, no
underscores), not the persistent table's DB field names; types stay identical;
keys are client + the persistent key in CDS naming; the draft admin include is
mandatory; and @Semantics.amount.currencyCode must point at the draft's own
field. Object names in the tables are labelled as illustration — naming policy
stays the customer's.

The description is written as the request a user would make, because only
name+description is embedded for the semantic match; the body is injected after."
```

---

### Task 5: Verify a skill actually reaches the model end-to-end

Content is worthless if injection silently fails. This task proves the wiring on a deployed instance before we write fifteen more skills.

**Files:**
- Modify: none (verification only)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: evidence that `skills_selected` fires and the skill body reaches the system message.

- [ ] **Step 1: Deploy to staging**

```bash
cd .worktrees/ai-apps-stg && ./tools/deploy.sh staging
```
Expected: `=== Done: deploy/acme-prod-stg ===`, exit 0.

- [ ] **Step 2: Confirm the pool is in the startup log**

```bash
cf logs cloud-llm-hub-staging-srv --recent | grep -o '"msg":"skills pool resolved[^}]*'
```
Expected: a line reporting `count: 1` and `names: [ 'creating-draft-table' ]`.

- [ ] **Step 3: Confirm the skill is selected for a semantically close request**

Send one `execute_step` via the staging MCP (or the chat endpoint) with a task phrased as a
user would, deliberately NOT naming the skill:
> `What should the field names and keys of a draft table look like for a RAP business object with draft enabled? Do not create anything — just explain.`

```bash
cf logs cloud-llm-hub-staging-srv --recent | grep -o '"msg":"[^"]*skills_selected[^"]*'
```
Expected: `skills_selected` with `selectedNames: [ 'creating-draft-table' ]`, and the answer
mentions the CDS-element naming rule and `sych_bdl_draft_admin_inc` — content that only the
skill provides.

- [ ] **Step 4: Confirm an unrelated request does NOT pull the skill**

> `List the clients defined in this system. Read-only.`

Expected: no `creating-draft-table` in `skills_selected` for that request. If it is selected
for everything, the `description` is too generic — rewrite it and repeat from Step 1.

- [ ] **Step 5: Record the outcome**

If Steps 2–4 pass, the channel is proven and Task 6 may proceed. If not, STOP and fix the
wiring — do not write more content on top of a broken channel.

---

### Task 6: The remaining fifteen skills

Only after Task 5 proves the channel works.

**Files:**
- Create, one directory each under `srv/skills/`: `creating-domain`, `creating-data-element`, `creating-persistent-table`, `creating-interface-cds-view`, `creating-projection-cds-view`, `creating-metadata-extension`, `creating-bdef`, `creating-bimp`, `creating-projection-bdef`, `creating-service-definition`, `creating-service-binding`, `activating-objects`, `enforcing-target-package`, `avoiding-hallucinations`, `managing-rag-artifacts`
- Modify: `test/unit/skills-content.test.ts`

**Interfaces:**
- Consumes: the content pattern from Task 4.
- Produces: the full 16-skill pool.

- [ ] **Step 1: Read each object from the live system before writing its skill**

For every skill, read the corresponding real object in package `TEST_RAG_APP` on DEV via
`execute_step` (one object per step — the `execute_step` contract requires minimal steps),
and derive the rule from what is actually there. Sources, per skill:

| Skill | Live object(s) to read |
|---|---|
| `creating-domain` | `ZDEMO01_DOM_TITLE`, `ZDEMO01_DOM_PRICE`, `ZDEMO01_DOM_PUBYEAR` |
| `creating-data-element` | `ZDEMO01_DE_TITLE`, `ZDEMO01_DE_PRICE` |
| `creating-persistent-table` | `ZDEMO01_TBOOK` |
| `creating-interface-cds-view` | `ZDEMO01_I_BOOK` (DDLS) |
| `creating-projection-cds-view` | `ZDEMO01_C_BOOK` (DDLS) |
| `creating-metadata-extension` | `ZDEMO01_C_BOOK_MDE` |
| `creating-bdef` | `ZDEMO01_I_BOOK` (BDEF) |
| `creating-bimp` | `ZBP_DEMO1_I_BOOK` |
| `creating-projection-bdef` | `ZDEMO01_C_BOOK` (BDEF) |
| `creating-service-definition` | the `ZDEMO01_*` service definition |
| `creating-service-binding` | the `ZDEMO01_*` STOB objects |

`activating-objects`, `enforcing-target-package`, `avoiding-hallucinations` and
`managing-rag-artifacts` are procedural, not object-shaped: derive them from the observed
behaviour recorded in this project's docs and from `EXECUTE_STEP_DESCRIPTION`, and keep them
short.

- [ ] **Step 2: Write each SKILL.md following the Task 4 pattern**

Each file: frontmatter `name` (= directory name) and `description` (phrased as the request a
user would make — it is the ONLY text embedded for matching), then a body with the platform
rules, the gotchas, and a shape block. Illustrative names must be labelled as illustration.

- [ ] **Step 3: Extend the content test**

Add to `test/unit/skills-content.test.ts`:

```ts
  it('ships the full RAP skill set', async () => {
    const pool = buildSkillsPool({ dirs: [SKILLS_SRC] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    expect(r.value.map((s) => s.name).sort()).toEqual(
      [
        'activating-objects',
        'avoiding-hallucinations',
        'creating-bdef',
        'creating-bimp',
        'creating-data-element',
        'creating-domain',
        'creating-draft-table',
        'creating-interface-cds-view',
        'creating-metadata-extension',
        'creating-persistent-table',
        'creating-projection-bdef',
        'creating-projection-cds-view',
        'creating-service-binding',
        'creating-service-definition',
        'enforcing-target-package',
        'managing-rag-artifacts',
      ].sort(),
    );
  });

  it('every description is distinct enough to match on', async () => {
    const pool = buildSkillsPool({ dirs: [SKILLS_SRC] });
    const r = await pool.listSkills();
    if (!r.ok) throw new Error('listSkills failed');
    const descriptions = r.value.map((s) => s.description.toLowerCase());
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
```

- [ ] **Step 4: Run the tests**

Run: `npx jest test/unit/skills-content.test.ts && npx jest test/unit/`
Expected: PASS — the full pool of 16, and every other suite still green.

- [ ] **Step 5: User review of the content**

Ask the user to review the 16 SKILL.md files as the ABAP expert. Their review is the gate —
the rules were read from one system, and only they can say whether a rule is universal or an
artefact of that system.

- [ ] **Step 6: Commit**

```bash
npx biome check --write srv test
git add srv/skills test/unit/skills-content.test.ts
git commit -m "feat(skills): complete the RAP skill set

Fifteen more skills, each sourced by reading the corresponding real object in
package TEST_RAG_APP on DEV rather than from general ABAP knowledge, and
reviewed by the user as the ABAP expert.

Descriptions are phrased as the request a user would make, since only
name+description is embedded for the semantic match; bodies carry the platform
rules and the gotchas. Naming stays the customer's policy — object names appear
only as labelled illustration."
```

---

## Notes for the implementer

- **The pool is re-embedded per destination.** `builder.build()` runs once per destination and each build re-upserts every skill into the shared `toolsRag` (`upsertRaw` → one embedding per skill). With 4 destinations × 16 skills that is ~64 embedding calls at startup — a few seconds, accepted deliberately. If it ever hurts, the fix is upstream (vectorize once per shared store), not a local hack.
- **The bundle is unaffected.** `planBundleLoad` iterates `runtimeDocs` from `getSharedCorpusDocs()` — tools only. Skills are upserted separately by the builder, so `srv/tool-embeddings.json` needs no regeneration.
- **Do not "fix" a rule from memory.** If a skill and the live system disagree, read the system again and fix the skill.

// Integration tests for CdsDumpRepository.insertParsed — closes #50.
//
// What's actually under test: the SQL paths in srv/dump-repository.ts that
// (1) find the canonical 'created' row in a signature group, (2) read all
// slot rows for that canonical key, and (3) feed them to the pure decision
// function decideJiraInsertStatus. A typo in either SELECT predicate (e.g.
// 'create' instead of 'created', or losing the jiraIssueKey filter) would
// pass the existing pure-function tests; this suite would not.
//
// Decision contract (from srv/jira-policy.ts):
//   • Output jiraStatus is either 'pending' or 'unheard' — never 'commented'.
//     ('commented' is later set by JiraWorker after it actually posts the
//      comment to Jira.)
//   • jiraIssueKey echoes canonical.jiraIssueKey whenever canonical exists,
//     regardless of open/done status — JiraWorker decides per-row whether to
//     create a fresh ticket (closed canonical → key gets overwritten) or
//     comment on the existing one.
//
// Side-effecting bootstrap in srv/monitor-service.ts is gated on
// process.env.NODE_ENV === 'test' so cds.test() boots the OData layer
// without leaking setTimeout worker loops.
//
import { join } from 'node:path';
// @ts-expect-error - @sap/cds has no type definitions
import cds from '@sap/cds';
import type { LifecycleProbe } from '../../srv/discoverer';
import { CdsDumpRepository } from '../../srv/dump-repository';
import type {
  DumpListItem,
  JiraIssueRef,
  ParsedDump,
} from '../../srv/interfaces';

const PROJECT_ROOT = join(__dirname, '..', '..');

declare const SELECT: any;
declare const INSERT: any;
declare const DELETE: any;

// CAP server boot (sqlite deploy + cds-deploy of CSN) takes ~5-15s on a cold
// run; Jest's default 5s hook timeout is too tight.
jest.setTimeout(60_000);

cds.test(PROJECT_ROOT);

const SIG = 'sig-FOO';
const SYSTEM = 'E19.100';

function fakeParsed(dumpId: string): ParsedDump {
  return {
    rawPayload: `dump ${dumpId}`,
    header: {
      system: SYSTEM,
      dumpId,
      runtimeError: 'OBJECTS_OBJREF_NOT_ASSIGNED',
      program: 'ZCL_TEST',
      include: 'ZCL_TEST_CM01',
      sourceLine: 42,
    },
    callStack: [],
    variables: [],
    sourceExtract: undefined,
  };
}

function fakeItem(dumpId: string, occurredAt: string): DumpListItem {
  return { system: SYSTEM, dumpId, occurredAt };
}

function makeLifecycle(
  category: 'open' | 'done',
  spy: { calls: string[] },
): LifecycleProbe {
  // Mirrors the per-tick cache from srv/discoverer.createLifecycleProbe — a Map
  // keyed on jiraIssueKey, so two inserts in the same probe instance don't
  // re-hit Jira. Spy captures only the underlying upstream calls (post-cache).
  const cache = new Map<string, JiraIssueRef>();
  return {
    async getIssueCached(key: string): Promise<JiraIssueRef> {
      const hit = cache.get(key);
      if (hit) return hit;
      spy.calls.push(key);
      const issue: JiraIssueRef = {
        key,
        statusCategoryKey: category === 'done' ? 'done' : 'indeterminate',
      };
      cache.set(key, issue);
      return issue;
    },
    cache,
  } as unknown as LifecycleProbe;
}

async function clearDumps() {
  const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
  await DELETE.from(MonitoredDump);
}

async function seedRow(overrides: {
  dumpId: string;
  jiraStatus: string;
  jiraIssueKey?: string;
  firstSeenAt?: string;
  signature?: string;
}) {
  const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
  await INSERT.into(MonitoredDump).entries({
    ID: cds.utils.uuid(),
    system: SYSTEM,
    dumpId: overrides.dumpId,
    signature: overrides.signature ?? SIG,
    firstSeenAt:
      overrides.firstSeenAt ?? new Date(Date.now() - 60_000).toISOString(),
    occurredAt:
      overrides.firstSeenAt ?? new Date(Date.now() - 60_000).toISOString(),
    runtimeError: 'OBJECTS_OBJREF_NOT_ASSIGNED',
    program: 'ZCL_TEST',
    rawPayload: `seed ${overrides.dumpId}`,
    analysisStatus: 'done',
    analysisAttempts: 0,
    jiraStatus: overrides.jiraStatus,
    jiraIssueKey: overrides.jiraIssueKey,
    jiraAttempts: 0,
    skipJira: false,
  });
}

async function readDump(dumpId: string) {
  const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
  return SELECT.one.from(MonitoredDump).where({ system: SYSTEM, dumpId });
}

describe('CdsDumpRepository.insertParsed (integration, closes #50)', () => {
  let repo: CdsDumpRepository;
  let spy: { calls: string[] };

  beforeEach(async () => {
    await clearDumps();
    repo = new CdsDumpRepository(SYSTEM);
    spy = { calls: [] };
  });

  test('1. canonical=null (first occurrence) → pending, no key, no Jira read', async () => {
    const lifecycle = makeLifecycle('open', spy);
    await repo.insertParsed(
      fakeItem('D-1', '2026-01-01T00:00:00Z'),
      fakeParsed('D-1'),
      SIG,
      lifecycle,
    );
    const row = await readDump('D-1');
    expect(row.jiraStatus).toBe('pending');
    expect(row.jiraIssueKey).toBeFalsy();
    expect(spy.calls).toHaveLength(0);
  });

  test('2. canonical=open + slot has only "created" → pending on canonical key (slot is not "taken" by created alone)', async () => {
    await seedRow({
      dumpId: 'D-1',
      jiraStatus: 'created',
      jiraIssueKey: 'X-1',
    });
    const lifecycle = makeLifecycle('open', spy);
    await repo.insertParsed(
      fakeItem('D-2', '2026-01-02T00:00:00Z'),
      fakeParsed('D-2'),
      SIG,
      lifecycle,
    );
    const row = await readDump('D-2');
    expect(row.jiraStatus).toBe('pending');
    expect(row.jiraIssueKey).toBe('X-1');
    expect(spy.calls).toEqual(['X-1']);
  });

  test('3. canonical=open + slot has "commented" → unheard on canonical key', async () => {
    await seedRow({
      dumpId: 'D-1',
      jiraStatus: 'created',
      jiraIssueKey: 'X-1',
      firstSeenAt: '2026-01-01T00:00:00Z',
    });
    await seedRow({
      dumpId: 'D-2',
      jiraStatus: 'commented',
      jiraIssueKey: 'X-1',
      firstSeenAt: '2026-01-02T00:00:00Z',
    });
    const lifecycle = makeLifecycle('open', spy);
    await repo.insertParsed(
      fakeItem('D-3', '2026-01-03T00:00:00Z'),
      fakeParsed('D-3'),
      SIG,
      lifecycle,
    );
    const row = await readDump('D-3');
    expect(row.jiraStatus).toBe('unheard');
    expect(row.jiraIssueKey).toBe('X-1');
  });

  test('4. canonical=open + slot has "unheard" → unheard on canonical key', async () => {
    await seedRow({
      dumpId: 'D-1',
      jiraStatus: 'created',
      jiraIssueKey: 'X-1',
      firstSeenAt: '2026-01-01T00:00:00Z',
    });
    await seedRow({
      dumpId: 'D-2',
      jiraStatus: 'unheard',
      jiraIssueKey: 'X-1',
      firstSeenAt: '2026-01-02T00:00:00Z',
    });
    const lifecycle = makeLifecycle('open', spy);
    await repo.insertParsed(
      fakeItem('D-3', '2026-01-03T00:00:00Z'),
      fakeParsed('D-3'),
      SIG,
      lifecycle,
    );
    const row = await readDump('D-3');
    expect(row.jiraStatus).toBe('unheard');
    expect(row.jiraIssueKey).toBe('X-1');
  });

  test('5. canonical=open + slot has "failed" alongside "created" → unheard on canonical key', async () => {
    await seedRow({
      dumpId: 'D-1',
      jiraStatus: 'created',
      jiraIssueKey: 'X-1',
      firstSeenAt: '2026-01-01T00:00:00Z',
    });
    await seedRow({
      dumpId: 'D-2',
      jiraStatus: 'failed',
      jiraIssueKey: 'X-1',
      firstSeenAt: '2026-01-02T00:00:00Z',
    });
    const lifecycle = makeLifecycle('open', spy);
    await repo.insertParsed(
      fakeItem('D-3', '2026-01-03T00:00:00Z'),
      fakeParsed('D-3'),
      SIG,
      lifecycle,
    );
    const row = await readDump('D-3');
    expect(row.jiraStatus).toBe('unheard');
    expect(row.jiraIssueKey).toBe('X-1');
  });

  test('6. canonical=closed (statusCategoryKey=done) + slot has only "created" → pending on canonical key (worker will create new ticket and overwrite)', async () => {
    await seedRow({
      dumpId: 'D-1',
      jiraStatus: 'created',
      jiraIssueKey: 'X-1',
    });
    const lifecycle = makeLifecycle('done', spy);
    await repo.insertParsed(
      fakeItem('D-2', '2026-01-02T00:00:00Z'),
      fakeParsed('D-2'),
      SIG,
      lifecycle,
    );
    const row = await readDump('D-2');
    expect(row.jiraStatus).toBe('pending');
    expect(row.jiraIssueKey).toBe('X-1');
  });

  test('7. canonical=closed + slot has "commented" → pending (commented does NOT occupy slot in CLOSED branch — new cycle starts)', async () => {
    await seedRow({
      dumpId: 'D-1',
      jiraStatus: 'created',
      jiraIssueKey: 'X-1',
      firstSeenAt: '2026-01-01T00:00:00Z',
    });
    await seedRow({
      dumpId: 'D-2',
      jiraStatus: 'commented',
      jiraIssueKey: 'X-1',
      firstSeenAt: '2026-01-02T00:00:00Z',
    });
    const lifecycle = makeLifecycle('done', spy);
    await repo.insertParsed(
      fakeItem('D-3', '2026-01-03T00:00:00Z'),
      fakeParsed('D-3'),
      SIG,
      lifecycle,
    );
    const row = await readDump('D-3');
    expect(row.jiraStatus).toBe('pending');
    expect(row.jiraIssueKey).toBe('X-1');
  });

  test('8. per-tick lifecycle cache: two inserts on same canonical → one upstream Jira read', async () => {
    await seedRow({
      dumpId: 'D-1',
      jiraStatus: 'created',
      jiraIssueKey: 'X-1',
    });
    const lifecycle = makeLifecycle('open', spy);
    await repo.insertParsed(
      fakeItem('D-2', '2026-01-02T00:00:00Z'),
      fakeParsed('D-2'),
      SIG,
      lifecycle,
    );
    await repo.insertParsed(
      fakeItem('D-3', '2026-01-03T00:00:00Z'),
      fakeParsed('D-3'),
      SIG,
      lifecycle,
    );
    expect(spy.calls).toEqual(['X-1']); // one upstream call shared across both inserts
  });
});

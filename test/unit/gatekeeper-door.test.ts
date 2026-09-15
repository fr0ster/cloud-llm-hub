jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: undefined,
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
  getRequestHistory: () => [],
}));

import { trackCall } from '../../srv/lib/admission-scope';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { isRefusal, type Lease } from '../../srv/lib/session-retention';

const tick = () => new Promise((r) => setImmediate(r));

function configure(live?: number, retained?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (retained === undefined)
    delete process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = String(retained);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

afterEach(() => configure());

function admitted(r: gatekeeper.PipelineAdmission) {
  if ('admitted' in r) return r.admitted;
  throw new Error(`refused: ${'refused' in r ? r.refused : 'closed'}`);
}

describe('with a door', () => {
  it('admits up to the capacity and queues the rest', async () => {
    configure(1);
    const a = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let bAdmitted = false;
    const b = gatekeeper.admitPipeline('u', 'B').then((r) => {
      bAdmitted = true;
      return r;
    });
    await tick();
    expect(bAdmitted).toBe(false);
    a.release();
    admitted(await b).release();
  });

  it('admits a retention-blocked waiter the moment a RAG lease settles', async () => {
    configure(2, 2);
    const ragA = gatekeeper.leaseSession('u', 'A', 'rag') as Lease;
    const ragB = gatekeeper.leaseSession('u', 'B', 'rag') as Lease;
    expect(isRefusal(ragA) || isRefusal(ragB)).toBe(false);
    let admittedC = false;
    const c = gatekeeper.admitPipeline('u', 'C').then((r) => {
      admittedC = true;
      return r;
    });
    await tick();
    // Both slots free, no place: no pipeline starts.
    expect(admittedC).toBe(false);
    ragA.release();
    admitted(await c).release();
    ragB.release();
  });

  it('registers calls made inside run, and drains after them', async () => {
    configure(1);
    const s = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let finish!: () => void;
    s.run(() => {
      void trackCall(new Promise<void>((r) => (finish = r)));
    });
    let drained = false;
    void s.drain().then(() => (drained = true));
    await tick();
    expect(drained).toBe(false);
    finish();
    await tick();
    expect(drained).toBe(true);
    s.release();
  });
});

describe('a request that outlived its session', () => {
  const { appendToSession } =
    require('../../srv/session-store') as typeof import('../../srv/session-store');

  for (const [label, live] of [
    ['with a door', 1],
    ['without a door', undefined],
  ] as const) {
    it(`is answered closed ${label}, and leaves nothing leased`, async () => {
      configure(live);
      appendToSession('A', 'u', { role: 'user', content: 'earlier' });
      // Accepted by the middleware while live; the logout completes first.
      await gatekeeper.deleteSession('u', 'A');
      expect(
        await gatekeeper.admitPipeline('u', 'A', undefined, {
          presented: true,
        }),
      ).toEqual({ closed: true });
      expect(gatekeeper.theRetention().snapshot().retained).toBe(0);
    });
  }

  it('a waiter whose session is closed while it queues is answered closed', async () => {
    configure(1);
    const hold = admitted(await gatekeeper.admitPipeline('v', 'X'));
    appendToSession('A', 'u', { role: 'user', content: 'earlier' });
    const late = gatekeeper.admitPipeline('u', 'A', undefined, {
      presented: true,
    });
    await tick();
    await gatekeeper.deleteSession('u', 'A');
    expect(await late).toEqual({ closed: true });
    hold.release();
  });
});

describe('eviction behind the door', () => {
  const { appendToSession, getSessionHistory } =
    require('../../srv/session-store') as typeof import('../../srv/session-store');

  it('cookie-less churn does not evict a presented idle session', async () => {
    // The door takes the retention place itself, so what the request presented
    // has to reach retention through it — or every admitted chat session looks
    // like churn.
    configure(1, 2);
    appendToSession('P', 'alice', { role: 'user', content: 'keep me' });
    admitted(
      await gatekeeper.admitPipeline('alice', 'P', undefined, {
        presented: true,
      }),
    ).release();
    const minted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sid = `m${i}`;
      minted.push(sid);
      const s = admitted(await gatekeeper.admitPipeline('cline', sid));
      appendToSession(sid, 'cline', { role: 'user', content: 'one-off' });
      s.release();
    }
    try {
      expect(getSessionHistory('P', 'alice')).toHaveLength(1);
      expect(gatekeeper.theRetention().snapshot().evictions).toBeGreaterThan(0);
    } finally {
      await gatekeeper.deleteSession('alice', 'P');
      for (const sid of minted) await gatekeeper.deleteSession('cline', sid);
    }
  });
});

describe('logout with a door', () => {
  it('waits for the admitted pipeline and does not abort it', async () => {
    // A logout is a disconnect with a better name: it may not cut an ADT write
    // between create and activate.
    configure(1);
    const s = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let removed = false;
    const removal = gatekeeper
      .deleteSession('u', 'A')
      .then(() => (removed = true));
    await tick();
    expect(s.signal?.aborted).toBe(false);
    expect(removed).toBe(false);
    s.release();
    await removal;
    expect(removed).toBe(true);
  });
});

describe('without a door', () => {
  it('admits at once and refuses nothing', async () => {
    configure();
    expect(gatekeeper.theDoor()).toBeUndefined();
    const sessions = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        gatekeeper.admitPipeline('u', `S${i}`),
      ),
    );
    for (const s of sessions) admitted(s).release();
  });

  it('still leases the session, so a logout waits for the run', async () => {
    configure();
    const s = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let removed = false;
    const removal = gatekeeper
      .deleteSession('u', 'A')
      .then(() => (removed = true));
    await tick();
    expect(removed).toBe(false);
    s.release();
    await removal;
    expect(removed).toBe(true);
  });

  it('still registers calls, so teardown waits for them', async () => {
    configure();
    const s = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let finish!: () => void;
    s.run(() => {
      void trackCall(new Promise<void>((r) => (finish = r)));
    });
    let drained = false;
    void s.drain().then(() => (drained = true));
    await tick();
    expect(drained).toBe(false);
    finish();
    await tick();
    expect(drained).toBe(true);
    s.release();
  });
});

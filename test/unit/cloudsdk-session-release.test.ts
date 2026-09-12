jest.mock('@sap-cloud-sdk/http-client', () => ({
  executeHttpRequest: jest.fn(),
}));

import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';

const mockExec = executeHttpRequest as jest.Mock;

/**
 * A system that issues NO session of its own — the connectivity-proxy case the
 * generated `SAP_SESSIONID` exists for. Only the server's XSRF cookie comes
 * back, which is what gives our generated id its `<SID>_<CLIENT>` suffix.
 */
function respondsWithoutSession() {
  mockExec.mockImplementation(async () => ({
    status: 200,
    data: '',
    headers: { 'set-cookie': ['sap-XSRF_DEV_100=abc; path=/'] },
  }));
}

/**
 * An on-premise system as measured on DEV: the logon IS the establishing call,
 * so a real `SAP_SESSIONID` arrives with the first answer. Nothing is generated
 * in this case — and this session is the one that piles up in SM04 unless it is
 * given back through the platform's ICF logoff.
 */
function respondsWithServerSession() {
  mockExec.mockImplementation(async () => ({
    status: 200,
    data: '',
    headers: {
      'set-cookie': [
        'sap-XSRF_DEV_100=abc; path=/',
        'SAP_SESSIONID_DEV_100=SERVER_ISSUED; path=/',
      ],
    },
  }));
}

function makeConn() {
  return new CloudSdkAbapConnection(
    {
      url: 'https://example',
      authType: 'basic',
      username: 'U',
      password: 'P',
      client: '100',
    } as never,
    'S4HANA_TEST',
  );
}

async function get(c: CloudSdkAbapConnection) {
  await c.makeAdtRequest({
    url: '/sap/bc/adt/discovery',
    method: 'GET',
    timeout: 5000,
  });
}

/** Requests whose headers ask ADT to end the stateful session (edit-locks). */
function statefulReleaseCalls(): unknown[] {
  return mockExec.mock.calls.filter(
    (c) => c[1]?.headers?.['x-sap-adt-sessiontype'] === 'stateless',
  );
}

/** Requests that hand the platform session back. */
function logoffCalls(): { url: string; cookie?: string }[] {
  return mockExec.mock.calls
    .filter((c) =>
      String(c[1]?.url ?? '').includes('/sap/public/bc/icf/logoff'),
    )
    .map((c) => ({ url: c[1].url, cookie: c[1]?.headers?.Cookie }));
}

describe('CloudSdkAbapConnection — ADT stateful session', () => {
  beforeEach(() => {
    mockExec.mockReset();
    respondsWithoutSession();
  });

  it('releases a session opened by a read-only request', async () => {
    const c = makeConn();
    // Two GETs: the first only captures the server's sap-XSRF_<SID>_<CLIENT>
    // cookie, and our SAP_SESSIONID is minted while building the second.
    await get(c);
    await get(c);
    expect(statefulReleaseCalls()).toHaveLength(0);

    await c.closeSession();
    expect(statefulReleaseCalls()).toHaveLength(1);
  });

  it('still releases a stateful session', async () => {
    const c = makeConn();
    await get(c);
    await get(c);
    c.setSessionType('stateful');

    await c.closeSession();
    expect(statefulReleaseCalls()).toHaveLength(1);
  });

  it('a single request opens nothing — the id is minted on the next one', async () => {
    const c = makeConn();
    await get(c);
    await c.closeSession();
    expect(statefulReleaseCalls()).toHaveLength(0);
  });

  it('does nothing when no session was ever opened', async () => {
    const c = makeConn();
    await c.closeSession();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('is idempotent — a second close does not re-present the session', async () => {
    const c = makeConn();
    await get(c);
    await get(c);

    await c.closeSession();
    await c.closeSession();
    expect(statefulReleaseCalls()).toHaveLength(1);
  });
});

describe('CloudSdkAbapConnection — platform session (ICF logoff)', () => {
  beforeEach(() => {
    mockExec.mockReset();
    respondsWithServerSession();
  });

  // The leak measured on DEV: four read-only requests produced four
  // server-issued SAP_SESSIONIDs and zero releases, because the ADT stateless
  // call ends an ADT stateful chain and is not how the platform takes a
  // session back.
  it('logs off a session the server opened for a read-only request', async () => {
    const c = makeConn();
    await get(c);
    expect(logoffCalls()).toHaveLength(0);

    await c.closeSession();
    expect(logoffCalls()).toHaveLength(1);
  });

  it('presents the session cookie when logging off', async () => {
    const c = makeConn();
    await get(c);
    await c.closeSession();

    expect(logoffCalls()[0].cookie).toContain(
      'SAP_SESSIONID_DEV_100=SERVER_ISSUED',
    );
  });

  it('logs off a session opened by a probe', async () => {
    const c = makeConn();
    // A probe is an authenticated call, so the server opens a session for it
    // too. Discarding its cookie used to make that session unclosable.
    await c.probe('/sap/bc/adt/compatibility/graph');

    await c.closeSession();
    expect(logoffCalls()).toHaveLength(1);
  });

  it('never logs off a session we only generated ourselves', async () => {
    respondsWithoutSession();
    const c = makeConn();
    await get(c);
    await get(c);

    await c.closeSession();
    // The generated id names no server session — sending a logoff on its
    // strength would be tidying up a session we did not open, and the session
    // pool is shared with the same user's SAP GUI logons.
    expect(logoffCalls()).toHaveLength(0);
  });

  it('does not open a session while closing one', async () => {
    const c = makeConn();
    await get(c);
    await c.closeSession();

    // Teardown must read the jar without minting: every request it sends
    // carries the server's id, never a freshly generated one.
    for (const call of mockExec.mock.calls) {
      const cookie = String(call[1]?.headers?.Cookie ?? '');
      if (cookie.includes('SAP_SESSIONID_')) {
        expect(cookie).toContain('SAP_SESSIONID_DEV_100=SERVER_ISSUED');
      }
    }
  });

  // A hang-up on the logoff is the normal outcome: it travels the pinned socket
  // the session used, so ending the session ends the connection before the reply
  // is written. Measured on DEV — this fired on every poll while SM05 showed no
  // accumulated sessions. Reported as a failure it sends the reader hunting a
  // leak that is not there.
  it('does not report the expected hang-up as a failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockExec.mockImplementation(
      async (_dest: unknown, opts: { url?: string }) => {
        if (String(opts?.url ?? '').includes('/sap/public/bc/icf/logoff')) {
          throw new Error('socket hang up');
        }
        return {
          status: 200,
          data: '',
          headers: {
            'set-cookie': [
              'sap-XSRF_DEV_100=abc; path=/',
              'SAP_SESSIONID_DEV_100=SERVER_ISSUED; path=/',
            ],
          },
        };
      },
    );

    const c = makeConn();
    await get(c);
    // Must not throw, and must not surface as a warning.
    await expect(c.closeSession()).resolves.toBeUndefined();
    expect(logoffCalls()).toHaveLength(1);
    warn.mockRestore();
  });

  it('is idempotent — a second close does not log off twice', async () => {
    const c = makeConn();
    await get(c);

    await c.closeSession();
    await c.closeSession();
    expect(logoffCalls()).toHaveLength(1);
  });
});

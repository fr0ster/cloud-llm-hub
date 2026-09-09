import {
  ReadOnlyHandlersGroup,
  SearchHandlersGroup,
  SystemHandlersGroup,
} from '@mcp-abap-adt/core/handlers';
import { SYSTEM_TOOLS_THAT_WRITE } from '../../srv/lib/exposition';

/**
 * A cross-check on the classification, not a classifier.
 *
 * The judgement of which tools change the system was made upstream when the
 * handlers were split into sets. The heuristic that agrees with it: a tool that
 * changes something issues POST, PUT or DELETE; a tool that does not is almost
 * always GET.
 *
 * "Almost" is why this cannot decide anything on its own — ADT also uses POST
 * for reads that need a request body (a virtual-folder search), and for
 * check-runs and validations that compute without persisting. Those are listed
 * below by name, so a NEW non-GET appearing in a reader-level group fails the
 * test and gets looked at.
 */

/** Reader-level tools that legitimately use a non-GET method. */
const KNOWN_NON_GET_READS: Record<string, string> = {
  GetVirtualFoldersLow:
    'ADT virtual-folder search takes its query in a POST body; it reads.',
};

interface RecordedCall {
  method: string;
  url: string;
}

function makeRecordingConnection(calls: RecordedCall[]) {
  return {
    getConfig: () => ({
      url: 'http://probe',
      authType: 'basic',
      client: '100',
    }),
    getSessionId: () => 'probe',
    setSessionType: () => {},
    connect: async () => {},
    getSessionState: () => ({}),
    setSessionState: () => {},
    reset: () => {},
    getBaseUrl: async () => 'http://probe',
    getAuthHeaders: async () => ({}),
    // Records instead of sending. Nothing leaves the process.
    makeAdtRequest: async (o: { method?: string; url?: string }) => {
      calls.push({
        method: (o?.method ?? 'GET').toUpperCase(),
        url: String(o?.url ?? ''),
      });
      return { status: 200, data: '<xml/>', headers: {} };
    },
  };
}

describe('reader-level tools do not issue writing HTTP methods', () => {
  const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

  it('finds no unexplained non-GET among the tools a reader can run', async () => {
    const calls: RecordedCall[] = [];
    const ctx = {
      connection: makeRecordingConnection(calls),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as never;

    const groups = [
      new ReadOnlyHandlersGroup(ctx),
      new SearchHandlersGroup(ctx),
      new SystemHandlersGroup(ctx),
    ];

    const offenders: string[] = [];
    let driven = 0;

    for (const group of groups) {
      for (const h of group.getHandlers() as Array<{
        toolDefinition?: { name?: string };
        definition?: { name?: string };
        handler?: (...a: unknown[]) => unknown;
      }>) {
        const name = h.toolDefinition?.name ?? h.definition?.name;
        if (!name) continue;
        // Re-tagged out of the reader's reach — not this test's business.
        if (name in SYSTEM_TOOLS_THAT_WRITE) continue;

        calls.length = 0;
        try {
          const fn = h.handler;
          if (!fn) continue;
          await (fn.length >= 2
            ? (fn as (c: unknown, a: unknown) => unknown)(ctx, {})
            : (fn as (a: unknown) => unknown)({}));
        } catch {
          // Most handlers validate their arguments and bail before reaching the
          // connection. That is not a failure of this test — it is the reason
          // the probe's coverage is partial, asserted separately below.
        }

        const writes = [
          ...new Set(
            calls
              .filter((c) => WRITE_METHODS.has(c.method))
              .map((c) => c.method),
          ),
        ];
        if (calls.length > 0) driven++;
        if (writes.length > 0 && !(name in KNOWN_NON_GET_READS)) {
          offenders.push(`${name} → ${writes.join(',')}`);
        }
      }
    }

    // Empty means: every reader-level tool this probe could drive either used
    // GET, or is a documented non-GET read.
    expect(offenders).toEqual([]);

    // Guard the guard: if a refactor stops the probe from driving anything, the
    // assertion above would pass vacuously and prove nothing.
    expect(driven).toBeGreaterThan(0);
  });

  it('documents each known non-GET read with a reason', () => {
    for (const [tool, reason] of Object.entries(KNOWN_NON_GET_READS)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(tool).toBeTruthy();
    }
  });
});

import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import { HandlerExporter } from '@mcp-abap-adt/lib/handlers';
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
  ListTransports:
    'Transport search uses a POST query body without changing transports.',
  GetVirtualFolders:
    'ADT virtual-folder search takes its query in a POST body; it reads.',
};

interface RecordedCall {
  method: string;
  url: string;
}

function makeRecordingConnection(calls: RecordedCall[]): IAbapConnection {
  return {
    getSessionId: () => 'probe',
    setSessionType: () => {},
    connect: async () => {},
    getBaseUrl: async () => 'http://probe',
    // Records instead of sending. Nothing leaves the process.
    makeAdtRequest: async ({ method, url }) => {
      calls.push({
        method: (method ?? 'GET').toUpperCase(),
        url: String(url ?? ''),
      });
      return { status: 200, statusText: 'OK', data: '<xml/>', headers: {} };
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
    };

    const entries = new HandlerExporter({
      systemType: 'onprem',
      includeHighLevel: false,
      includeData: true,
    }).getHandlerEntries();

    const offenders: string[] = [];
    let driven = 0;

    for (const entry of entries) {
      const { name } = entry.toolDefinition;
      // Re-tagged out of the reader's reach — not this test's business.
      if (name in SYSTEM_TOOLS_THAT_WRITE) continue;

      calls.length = 0;
      try {
        await entry.call(ctx, {});
      } catch {
        // Most handlers validate their arguments and bail before reaching the
        // connection. That is not a failure of this test — it is the reason
        // the probe's coverage is partial, asserted separately below.
      }

      const writes = [
        ...new Set(
          calls.filter((c) => WRITE_METHODS.has(c.method)).map((c) => c.method),
        ),
      ];
      if (calls.length > 0) driven++;
      if (writes.length > 0 && !(name in KNOWN_NON_GET_READS)) {
        offenders.push(`${name} → ${writes.join(',')}`);
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

/**
 * Probe: does an ADT stateful chain stay on ONE session over a direct
 * (ProxyType Internet) destination read from the Cloud SDK `destinations` env?
 *
 * Usage (a SAP system reachable from this machine; an object in a package YOU
 * own — never a shared read-only package):
 *   destinations='[{"name":"SAP_DEV","url":"https://sap.example.com:44300",
 *     "proxyType":"Internet","authentication":"NoAuthentication","sapClient":"100"}]' \
 *   PROBE_DEST=SAP_DEV PROBE_USER=... PROBE_PASSWORD=... \
 *   PROBE_OBJECT_URI=/sap/bc/adt/oo/classes/zcl_demo_probe \
 *   npx tsx tools/probe-direct-session.ts
 */
import { getTimeout } from '@mcp-abap-adt/connection';
import { createConnection } from '../srv/connections';
import type { CloudSdkAbapConnection } from '../srv/connections/CloudSdkAbapConnection';
import { resolveDestinationSapConfig } from '../srv/connections/destinationResolver';

async function main() {
  const dest = process.env.PROBE_DEST ?? '';
  const uri = process.env.PROBE_OBJECT_URI ?? '';
  const username = process.env.PROBE_USER ?? '';
  const password = process.env.PROBE_PASSWORD ?? '';
  if (!dest || !uri || !username || !password) {
    throw new Error(
      'set PROBE_DEST, PROBE_OBJECT_URI, PROBE_USER, PROBE_PASSWORD',
    );
  }
  const res = await resolveDestinationSapConfig(dest);
  // createConnection is synchronous and takes credentials inside sapConfig.
  const conn = createConnection({
    sapConfig: { ...res.sapConfig, username, password },
    destinationName: res.destinationName,
  }) as CloudSdkAbapConnection;
  conn.setSessionType('stateful');
  let handle: string | undefined;
  const statuses: Record<string, number | string> = {};
  try {
    const lock = await conn.makeAdtRequest({
      url: `${uri}?_action=LOCK&accessMode=MODIFY`,
      method: 'POST',
      headers: { Accept: 'application/vnd.sap.as+xml' },
      // Required by IAbapRequestOptions but not read by CloudSdkAbapConnection's
      // makeAdtRequest (no deadline is applied there); the library's own
      // constant fills the type without adding new timeout behavior.
      timeout: getTimeout('default'),
    });
    statuses.lock = lock.status;
    handle = /<LOCK_HANDLE>([^<]+)</.exec(String(lock.data))?.[1];
    if (!handle)
      throw new Error(`LOCK returned no handle: HTTP ${lock.status}`);
    statuses.read = (
      await conn.makeAdtRequest({
        url: uri,
        method: 'GET',
        timeout: getTimeout('default'),
      })
    ).status;
  } finally {
    // A probe on a real system must never leave a lock: unlock whenever a
    // handle was obtained, and close the session whatever happened.
    try {
      if (handle) {
        statuses.unlock = (
          await conn.makeAdtRequest({
            url: `${uri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`,
            method: 'POST',
            timeout: getTimeout('default'),
          })
        ).status;
      }
    } catch (e) {
      statuses.unlock = `error: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      await conn.closeSession();
      console.log(JSON.stringify(statuses));
    }
  }
  if (statuses.unlock !== 200)
    throw new Error('UNLOCK failed: the chain left the session');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

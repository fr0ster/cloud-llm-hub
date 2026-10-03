/**
 * The SAP responsible person and master system, scoped to one request.
 *
 * ABAP creates name a responsible person and a master system, and
 * `ListTransports` defaults to the responsible person's transports. This
 * process serves several SAP users at once, and the gatekeeper's door admits
 * their runs concurrently, so the values cannot live in the process-wide
 * `getSystemContext()`: whichever run wrote last would name the person for
 * every other run in flight. They are resolved per request instead, and
 * delivered through lib's own request scope — `RequestContext` carries
 * `responsible` and `masterSystem` since `@mcp-abap-adt/lib` 10.1.0
 * (fr0ster/mcp-abap-adt#202), and lib reads them through
 * `getEffectiveSystemContext()` in `createAdtClient`, `ListTransports` and
 * `utils.getSystemInformation()`.
 *
 * The values come from the caller's headers, in lib 16's own terms:
 * - `x-sap-responsible` is the STATED responsible — an explicit override;
 * - `x-sap-login` is the request's LOGIN, which lib uses as the responsible
 *   when none is stated on a connection that is not cloud;
 * - `x-sap-master-system` is the stated master system.
 * On a connection declared `cloud` (`system-type.ts`) lib ignores the login and
 * fills a missing value from the system's `systeminformation` — on the raw MCP
 * route, which hands lib the declared kind. The agent channels' embedded
 * handlers (`HandlerExporter`, which takes no per-destination kind in lib 16)
 * run every destination as on-premise, so there the login applies. A create that
 * ends with no responsible is refused by lib (`system_context_missing`) before
 * any request is sent.
 */

import {
  type RequestContext,
  runWithRequestContext,
} from '@mcp-abap-adt/lib/request-context';
import { getSystemContext } from '@mcp-abap-adt/lib/utils';

/** What lib uses for ADT creates and for the default transport user. */
export interface RequestSystem {
  /** Stated responsible (`x-sap-responsible`): wins over the login. */
  responsible?: string;
  /** The request's login (`x-sap-login`): the responsible when none is stated, on-premise. */
  login?: string;
  masterSystem?: string;
}

function pick(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const raw = headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined || first === null) return undefined;
  return String(first).trim() || undefined;
}

/** This request's values, from its headers; a missing one stays `undefined`. */
export function resolveRequestSystem(
  headers: Record<string, unknown>,
): RequestSystem {
  // SAP user IDs are stored UPPERCASE in the user master; login is
  // case-insensitive but the responsible-person lookup is NOT, so a lowercase
  // proxy login (e.g. "developer") is rejected as an invalid person. lib 16
  // passes the login through as it is, so both values are uppercased here —
  // both map to an SAP user-ID.
  return {
    responsible: pick(headers, 'x-sap-responsible')?.toUpperCase(),
    login: pick(headers, 'x-sap-login')?.toUpperCase(),
    masterSystem: pick(headers, 'x-sap-master-system')?.toUpperCase(),
  };
}

/**
 * Run `fn` — and everything it awaits — with this request's values in lib's
 * request scope. Enter it inside the admitted section, right before the run.
 */
export function runWithRequestSystem<T>(
  values: RequestSystem,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: RequestContext = {
    // Both keys are always present: lib lets a present key replace the process
    // value even when it is `undefined`, so a request without a value never
    // borrows the one some other request or the process left behind. A present
    // `responsible` key also masks the process login: only this request's
    // `login` can stand in for it.
    responsible: values.responsible,
    login: values.login,
    masterSystem: values.masterSystem,
    // Inside a scope lib takes `masterLanguage` from the scope alone, so a
    // scope without the key would drop the process language. Nothing sets the
    // language per request here, so the process value is carried in.
    masterLanguage: getSystemContext().masterLanguage,
  };
  return runWithRequestContext(ctx, fn);
}

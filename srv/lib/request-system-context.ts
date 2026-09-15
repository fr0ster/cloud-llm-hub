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
 * The values come from the caller's headers only. Filling a missing one from
 * the system's own information belongs in lib, next to the request context.
 */

import {
  type RequestContext,
  runWithRequestContext,
} from '@mcp-abap-adt/lib/request-context';
import { getSystemContext } from '@mcp-abap-adt/lib/utils';

/** What lib uses for ADT creates and for the default transport user. */
export interface RequestSystem {
  responsible?: string;
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
  // proxy login (e.g. "developer") is rejected as an invalid person. Uppercase
  // the derived value — safe for both x-sap-responsible and x-sap-login since
  // both map to an SAP user-ID.
  return {
    responsible: (
      pick(headers, 'x-sap-responsible') ?? pick(headers, 'x-sap-login')
    )?.toUpperCase(),
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
    // borrows the one some other request or the process left behind.
    responsible: values.responsible,
    masterSystem: values.masterSystem,
    // Inside a scope lib takes `masterLanguage` from the scope alone, so a
    // scope without the key would drop the process language. Nothing sets the
    // language per request here, so the process value is carried in.
    masterLanguage: getSystemContext().masterLanguage,
  };
  return runWithRequestContext(ctx, fn);
}

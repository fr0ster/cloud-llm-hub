/** Request headers are scoped here; identity is shared across the authenticated session. */

import {
  type RequestContext,
  runWithRequestContext,
  type SystemContextResolver,
} from '@mcp-abap-adt/lib/request-context';
import { getSystemContext } from '@mcp-abap-adt/lib/utils';
import {
  cachedSystemIdentity,
  resolveSystemIdentity,
} from './system-identity-cache';

/** Read the session cache, with a populating fallback for legacy callers. */
export const requestSystemContextResolver: SystemContextResolver = async (
  connection,
) => {
  const cached = cachedSystemIdentity(connection);
  if (cached !== undefined) return cached;
  return resolveSystemIdentity(connection);
};

/** What lib uses for ADT creates and for the default transport user. */
export interface RequestSystem {
  /** Stated responsible (`x-sap-responsible`): wins over lookup and login. */
  responsible?: string;
  /** The request's login (`x-sap-login`): a responsible hint when the endpoint has no user, including PP. */
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
export async function runWithRequestSystem<T>(
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

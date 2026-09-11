/**
 * Per-request "responsible person" for ADT writes (package/object creation etc.).
 *
 * SAP requires a responsible person for creation; #125 emptied `setSystemContext`
 * for the per-request auth model, so the create handlers had none and failed with
 * "Responsible person is required". This wires it from the request: the
 * caller-specified `x-sap-responsible`, else the connecting `x-sap-login` user.
 * `setSystemContext` MERGES, so other context fields are preserved.
 *
 * NOTE: `systemContext` is a process singleton — correct for one SAP user per
 * proxy session (the typical deployment); concurrent writes by different users on
 * the same instance could race (a pre-existing limitation of the singleton).
 *
 * Lives in its own lightweight module (only depends on core/utils) so the
 * lightweight request-connection helper does not have to import the heavy
 * agent-manager module.
 */
import { setSystemContext } from '@mcp-abap-adt/lib/utils';
import cds from '@sap/cds';

export function setRequestResponsible(headers: Record<string, unknown>): void {
  try {
    const pick = (v: unknown): string | undefined =>
      (Array.isArray(v) ? v[0] : v)?.toString().trim() || undefined;
    // SAP user IDs are stored UPPERCASE in the user master; login is
    // case-insensitive but the responsible-person lookup is NOT, so a lowercase
    // proxy login (e.g. "developer") is rejected as an invalid person. Uppercase
    // the derived value — safe for both x-sap-responsible and x-sap-login since
    // both map to an SAP user-ID.
    const responsible = (
      pick(headers['x-sap-responsible']) ?? pick(headers['x-sap-login'])
    )?.toUpperCase();
    // ALWAYS set it (even to undefined) — the singleton is process-wide, so a
    // request WITHOUT these headers (e.g. destination-auth) must NOT inherit the
    // previous request's responsible. setSystemContext merges, so
    // `{ responsible: undefined }` clears just that field. This removes the
    // sequential stale-leak (ALICE → no-login request → still ALICE); the
    // concurrent-race window of the singleton remains a pre-existing limitation.
    setSystemContext({ responsible });
  } catch (err) {
    // Never let responsible-setting break the request flow.
    cds
      .log('agent-manager')
      .warn('setRequestResponsible failed', { error: String(err) });
  }
}

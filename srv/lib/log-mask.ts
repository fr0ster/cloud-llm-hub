/**
 * Log-payload masking helpers — never let a raw SAP login reach a structured
 * log line. The buffer key already carries only `principalHash` (see
 * `srv/lib/principal.ts`); this closes the remaining leak in `log.info`/
 * `log.warn` payloads that used to echo `x-sap-login` / `sapLogin` verbatim.
 */

/**
 * Mask a caller-supplied SAP login for a log payload. Returns the literal
 * `'user-basic'` when a non-empty login is present (matching the existing
 * `auth: sapLogin ? 'user-basic' : ...` convention in
 * `srv/lib/request-connection.ts`), or `'(destination-auth)'` when no login
 * was supplied (destination service user / JWT passthrough).
 */
export function maskLoginForLog(sapLogin?: string | null): string {
  return sapLogin ? 'user-basic' : '(destination-auth)';
}

/**
 * Which kind of SAP system a request talks to — DECLARED, never inferred.
 *
 * The kind decides two things: which direct connector the hub builds
 * (`AdtCloudConnector` for `cloud`, `AdtOnPremConnector` otherwise — taking the
 * class is how `@mcp-abap-adt/connection` is told the system), and what
 * `@mcp-abap-adt/lib` 16 does about a responsible person (`cloud`: asks the
 * system's `systeminformation`; otherwise: the stated responsible, else the
 * login).
 *
 * The one rule, used by every channel:
 *   1. the request's `x-sap-system-type` header;
 *   2. else the destination's `SAP_SYSTEM_TYPE` property (a BTP destination's
 *      additional property, or a field of the Cloud SDK `destinations` entry);
 *   3. else `onprem` — lib's own default.
 *
 * Nothing else decides it: not the destination's proxy type, not the
 * authentication, not the URL. An unknown value is refused, never defaulted.
 */

/** The kinds lib 16 knows (`SapEnvironment`). `legacy` is an older on-premise system. */
export const SYSTEM_TYPES = ['onprem', 'cloud', 'legacy'] as const;
export type SystemType = (typeof SYSTEM_TYPES)[number];

/** The request header that declares the kind. */
export const HEADER_SAP_SYSTEM_TYPE = 'x-sap-system-type';
/** The destination property that declares the kind. */
export const DESTINATION_SYSTEM_TYPE_PROPERTY = 'SAP_SYSTEM_TYPE';
/** The kind when nothing declares one. */
export const DEFAULT_SYSTEM_TYPE: SystemType = 'onprem';

/** A declared kind that is not one of {@link SYSTEM_TYPES}. A 400: the caller's to fix. */
export class InvalidSystemTypeError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_SYSTEM_TYPE';
  constructor(source: string, value: string) {
    super(
      `${source} must be one of ${SYSTEM_TYPES.join(', ')}; got ${JSON.stringify(value)}`,
    );
    this.name = 'InvalidSystemTypeError';
  }
}

function isSystemType(value: string): value is SystemType {
  return (SYSTEM_TYPES as readonly string[]).includes(value);
}

/**
 * One declared value: `undefined` when nothing is declared (absent or blank),
 * the kind when it is a known one (case-insensitive, trimmed), else refused.
 * `source` names where the value came from, for the refusal.
 */
export function parseSystemType(
  raw: string | undefined,
  source: string,
): SystemType | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (isSystemType(value)) return value;
  throw new InvalidSystemTypeError(source, raw ?? '');
}

/**
 * The request's kind: its `x-sap-system-type` header, else the destination's
 * declared kind, else `onprem`. `destination` is the destination's already
 * parsed `SAP_SYSTEM_TYPE` (see `destinationResolver.ts`), or `undefined` for
 * a direct (`x-sap-url`) connection or a destination that declares none.
 */
export function resolveSystemType(
  headers: Record<string, unknown>,
  destination?: SystemType,
): SystemType {
  const raw = headers[HEADER_SAP_SYSTEM_TYPE];
  const first = Array.isArray(raw) ? raw[0] : raw;
  const fromHeader = parseSystemType(
    first === undefined || first === null ? undefined : String(first),
    `Header ${HEADER_SAP_SYSTEM_TYPE}`,
  );
  return fromHeader ?? destination ?? DEFAULT_SYSTEM_TYPE;
}

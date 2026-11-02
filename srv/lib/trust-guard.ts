import { normalizeTrust } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';

const trust = z.number().refine((value) => normalizeTrust(value) !== undefined);
export const collectionTrustArgs = z.object({ trust });
export const recordTrustArgs = z.object({ trust: trust.nullable() });
export type TrustTarget = {
  exists: boolean;
  scope?: string;
  collectionKind?: string;
  kind?: 'base' | 'informational';
};
export function trustWriteError(input: {
  admin: boolean;
  target: TrustTarget;
  value: number | null;
  allowNull: boolean;
}):
  | {
      status: 400 | 403 | 404 | 409;
      code: 'INVALID_TRUST' | 'FORBIDDEN' | 'NOT_FOUND' | 'TRUST_FIXED';
    }
  | undefined {
  if (!input.target.exists) return { status: 404, code: 'NOT_FOUND' };
  if (!input.admin) return { status: 403, code: 'FORBIDDEN' };
  if (
    input.value === null
      ? !input.allowNull
      : normalizeTrust(input.value) === undefined
  )
    return { status: 400, code: 'INVALID_TRUST' };
  if (
    input.target.scope !== 'global' ||
    input.target.collectionKind === 'agents' ||
    input.target.kind === 'base'
  )
    return { status: 409, code: 'TRUST_FIXED' };
  return undefined;
}

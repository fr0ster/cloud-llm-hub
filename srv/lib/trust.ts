import { normalizeTrust } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { BuildValidationError } from './build-validation-error';

export type TrustClass =
  | 'global'
  | 'user'
  | 'session'
  | 'system'
  | 'docs'
  | 'correction'
  | 'target'
  | 'client';
export const trustMapSchema = z
  .object({
    global: z
      .number()
      .refine((v) => normalizeTrust(v) !== undefined)
      .optional(),
    user: z
      .number()
      .refine((v) => normalizeTrust(v) !== undefined)
      .optional(),
    session: z
      .number()
      .refine((v) => normalizeTrust(v) !== undefined)
      .optional(),
    system: z
      .number()
      .refine((v) => normalizeTrust(v) !== undefined)
      .optional(),
    correction: z
      .number()
      .refine((v) => normalizeTrust(v) !== undefined)
      .optional(),
    target: z
      .number()
      .refine((v) => normalizeTrust(v) !== undefined)
      .optional(),
    client: z
      .number()
      .refine((v) => normalizeTrust(v) !== undefined)
      .optional(),
    docs: z
      .number()
      .refine((v) => normalizeTrust(v) !== undefined)
      .optional(),
  })
  .strict();
export type TrustDefaults = Record<TrustClass, number>;
export const trustHistorySchema = z.array(
  z.object({
    from: z.number().nullable(),
    to: z.number().nullable(),
    actor: z.string(),
    at: z.string(),
  }),
);
export type TrustHistoryEntry = z.infer<typeof trustHistorySchema>[number];
export function parseTrustDefaults(value: string | undefined): TrustDefaults {
  const defaults: TrustDefaults = {
    global: 3,
    system: 4.8,
    correction: 4.9,
    target: 4.3,
    docs: 4.2,
    client: 4.4,
    user: 3.5,
    session: 4,
  };
  if (value === undefined) return defaults;
  for (const entry of value.split(',')) {
    const [key, raw, extra] = entry.split('=').map((part) => part.trim());
    const parsed = trustMapSchema.safeParse({ [key ?? '']: Number(raw) });
    if (!raw || extra !== undefined || !parsed.success)
      throw new BuildValidationError(
        `Invalid LLM_AGENT_TRUST_DEFAULTS entry: ${entry}`,
      );
    Object.assign(defaults, parsed.data);
  }
  return defaults;
}
export function classForScope(
  scope: 'global' | 'user' | 'session',
): TrustClass {
  return scope;
}
export function classTrust(
  agentMap: Partial<Record<TrustClass, number>> | undefined,
  defaults: TrustDefaults,
): TrustDefaults {
  const result = { ...defaults };
  for (const key of [
    'global',
    'user',
    'session',
    'system',
    'docs',
    'correction',
    'target',
    'client',
  ] as const) {
    const value = agentMap?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
export function effectiveTrust(
  input: {
    record?: number;
    collection?: number;
    scope: 'global' | 'user' | 'session';
  },
  classes: TrustDefaults,
): number {
  return input.record ?? input.collection ?? classes[input.scope];
}
export type TrustInput = {
  trusted: true;
  class: TrustClass;
  source: string;
  classTrust: number;
  collectionTrust?: number;
  recordTrust?: number;
};
export type RecordTrustView =
  | { trusted: true; trust: number; trustOverride?: number; source: string }
  | { trusted: false };
export function trustView(
  input: TrustInput | { trusted: false },
): RecordTrustView {
  if (!input.trusted) return { trusted: false };
  return {
    trusted: true,
    trust: input.recordTrust ?? input.collectionTrust ?? input.classTrust,
    ...(input.recordTrust !== undefined
      ? { trustOverride: input.recordTrust }
      : {}),
    source: input.source,
  };
}

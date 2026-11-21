import { z } from 'zod';
import { collectionAddress } from './collection-address';

const text = z.string().min(1);
const citationSchema = z.strictObject({
  callId: text.optional(),
  recordId: text.optional(),
  quote: text.optional(),
});
const claim = { claim: text, evidence: citationSchema };
export const checkerClaimsSchema = z
  .array(
    z.discriminatedUnion('system', [
      z.strictObject({
        ...claim,
        system: z.literal('sap'),
        target: z.strictObject({ type: text, name: text }),
      }),
      z.strictObject({
        ...claim,
        system: z.literal('rag'),
        target: collectionAddress.extend({ record: text.optional() }),
      }),
      z.strictObject({
        ...claim,
        system: z.literal('source'),
        target: collectionAddress,
      }),
    ]),
  )
  .min(1);

export type CheckerClaim = z.infer<typeof checkerClaimsSchema>[number];

export const verdictToolSchema = z.strictObject({
  verdict: z.enum(['pass', 'fail']),
  count: z.int().nonnegative().optional(),
  findings: z
    .array(
      z.strictObject({
        claim: text,
        status: z.enum(['confirmed', 'refuted', 'unsupported']),
        evidence: citationSchema,
        reason: text,
      }),
    )
    .min(1),
});

export const verdictSchema = verdictToolSchema.refine(
  ({ verdict, findings }) =>
    (verdict === 'pass') ===
    findings.every(({ status }) => status === 'confirmed'),
  'Pass requires every claim to be confirmed.',
);

export type CheckerVerdict = z.infer<typeof verdictSchema>;

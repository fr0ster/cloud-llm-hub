import { z } from 'zod';

const evidenceClaimSchema = z.object({
  quote: z.string().min(1),
  evidence: z.string().min(1),
  reason: z.string().min(1),
});
const identifier = z.string().min(1);
const citation = {
  callId: identifier
    .optional()
    .describe(
      'Journal ID of the write call. Omit if no call supports the claim.',
    ),
};
const writeClaimSchema = z.discriminatedUnion('system', [
  z.object({
    ...citation,
    system: z.literal('sap'),
    operation: z.enum(['created', 'updated', 'deleted', 'activated']),
    target: z.object({ type: identifier, name: identifier }),
  }),
  z.object({
    ...citation,
    system: z.literal('rag'),
    operation: z.enum([
      'created',
      'updated',
      'deleted',
      'persisted',
      'enabled',
      'disabled',
    ]),
    target: z.object({
      scope: z.enum(['global', 'user', 'session']),
      collection: identifier,
      record: identifier.optional(),
    }),
  }),
]);
export type WriteClaim = z.infer<typeof writeClaimSchema>;

const verdictFields = {
  verdict: z.enum(['pass', 'fail']),
  count: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
};
const claimsDescription =
  'Claims are required and non-empty when verdict is fail.';
const claims = z
  .array(z.union([writeClaimSchema, evidenceClaimSchema]))
  .describe(claimsDescription);
export const verdictToolSchema = z.object({
  ...verdictFields,
  claims: z.array(evidenceClaimSchema).describe(claimsDescription).optional(),
});
export const verdictSchema = z.discriminatedUnion('verdict', [
  z.object({
    ...verdictFields,
    verdict: z.literal(verdictFields.verdict.enum.pass),
    claims: claims.optional(),
  }),
  z.object({
    ...verdictFields,
    verdict: z.literal(verdictFields.verdict.enum.fail),
    claims: claims.min(1),
  }),
]);
export type CheckerVerdict = z.infer<typeof verdictSchema>;

export const writeReviewVerdictSchema = z
  .object({
    ...verdictFields,
    claims: z.array(writeClaimSchema),
  })
  .refine(({ verdict, claims }) => verdict === 'pass' || claims.length > 0);

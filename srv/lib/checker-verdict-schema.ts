import { z } from 'zod';

const claimSchema = z.object({
  quote: z.string().min(1),
  evidence: z.string().min(1),
  reason: z.string().min(1),
});
const verdictFields = {
  verdict: z.enum(['pass', 'fail']),
  count: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
  claims: z
    .array(claimSchema)
    .describe('Claims are required and non-empty when verdict is fail.'),
};
export const verdictToolSchema = z.object({
  ...verdictFields,
  claims: verdictFields.claims.optional(),
});
export const verdictSchema = z.discriminatedUnion('verdict', [
  z.object({
    ...verdictFields,
    verdict: z.literal(verdictFields.verdict.enum.pass),
    claims: verdictFields.claims.optional(),
  }),
  z.object({
    ...verdictFields,
    verdict: z.literal(verdictFields.verdict.enum.fail),
    claims: verdictFields.claims.min(1),
  }),
]);
export type CheckerVerdict = z.infer<typeof verdictSchema>;

import { z } from 'zod';

const claimSchema = z.object({
  quote: z.string().min(1),
  evidence: z.string().min(1),
  reason: z.string().min(1),
});
const verdictFields = {
  count: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
};
export const verdictSchema = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.literal('pass'),
    ...verdictFields,
    claims: z.array(claimSchema).optional(),
  }),
  z.object({
    verdict: z.literal('fail'),
    ...verdictFields,
    claims: z.array(claimSchema).min(1),
  }),
]);
export type CheckerVerdict = z.infer<typeof verdictSchema>;

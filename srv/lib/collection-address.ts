import { z } from 'zod';

export const collectionAddress = z
  .object({
    scope: z.enum(['session', 'user', 'global']),
    collection: z
      .string()
      .regex(/^(?!.*__)(?:[a-z0-9][a-z0-9_-]*|@skills)$/)
      .describe('Exact logical collection name, never a physical id'),
  })
  .strict();
export type CollectionAddress = z.infer<typeof collectionAddress>;

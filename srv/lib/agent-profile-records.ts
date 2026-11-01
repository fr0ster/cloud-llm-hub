import type { WorkerProfile } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import type { RagDocument } from '../rag-collections';

export const profileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine(
    (name) =>
      name !== 'planner' &&
      !name.startsWith('planner-') &&
      name !== 'coordinator' &&
      !name.startsWith('coordinator-'),
  );
export const coordinatorName = z
  .string()
  .regex(/^coordinator(?:-[A-Za-z0-9_-]+)?$/);
export const plannerName = z.string().regex(/^planner(?:-[A-Za-z0-9_-]+)?$/);
export const profileToolPolicy = z.union([
  z.literal('all'),
  z.literal('read-only'),
  z
    .object({
      allow: z.array(z.string().min(1)).optional(),
      deny: z.array(z.string().min(1)).optional(),
    })
    .strict(),
]);
const enabled = z.boolean().optional();
export const profileFrontmatter = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('profile'),
      name: profileName,
      enabled,
      description: z.string(),
      tools: profileToolPolicy,
      result: z.enum(['report', 'verdict']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('worker-base'),
      name: z.literal('_worker-base'),
      enabled,
    })
    .strict(),
  // Existing records are preserved by missing-only seeding.
  z.object({ kind: z.literal('planner'), name: plannerName, enabled }).strict(),
  z
    .object({ kind: z.literal('coordinator'), name: coordinatorName, enabled })
    .strict(),
  z
    .object({
      kind: z.literal('planner-author'),
      name: z.enum(['planner-create', 'planner-revise']),
      enabled,
    })
    .strict(),
]);
export type ProfileFrontmatter = z.infer<typeof profileFrontmatter>;
export type AgentProfileRecord = {
  id: string;
  text: string;
  metadata: ProfileFrontmatter & { canonicalKey: string };
};

/** Errors deliberately identify fields without including configuration text. */
export function validateAgentProfileRecord(
  document: Omit<RagDocument, 'createdAt'> &
    Partial<Pick<RagDocument, 'createdAt'>>,
): AgentProfileRecord {
  if (typeof document.text !== 'string')
    throw new Error(`Invalid agent record ${document.id}: text`);
  const { canonicalKey, ...fields } = document.metadata;
  const parsed = profileFrontmatter.safeParse(fields);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || 'metadata';
    throw new Error(`Invalid agent record ${document.id}: ${field}`);
  }
  if (canonicalKey !== document.id || parsed.data.name !== document.id)
    throw new Error(`Invalid agent record ${document.id}: canonicalKey/name`);
  return {
    id: document.id,
    text: document.text,
    metadata: { ...parsed.data, canonicalKey: document.id },
  };
}

export function workerProfile(
  record: AgentProfileRecord,
): WorkerProfile | undefined {
  const metadata = record.metadata;
  if (metadata.kind !== 'profile') return undefined;
  return {
    name: metadata.name,
    description: metadata.description,
    systemPrompt: record.text,
    tools: metadata.tools,
    result: metadata.result,
  };
}

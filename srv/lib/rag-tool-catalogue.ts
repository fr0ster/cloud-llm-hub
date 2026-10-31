import { z } from 'zod';
import { isReadOnlyTools, profileToolAllowed } from '../request-session';

const session = z
  .string()
  .min(1)
  .describe(
    'Live caller-owned session key; may also come from header or cookie',
  )
  .optional();
const collection = z
  .string()
  .min(1)
  .describe('Existing collection name or physical id');
const offset = z.number().int().nonnegative().optional();
const enabled = z.boolean();

export const ragMcpSchemas = {
  collection_create: z
    .object({
      session,
      name: z.string().min(1),
      scope: z.enum(['user', 'session']),
    })
    .strict(),
  collection_delete: z.object({ session, collection }).strict(),
  record_add: z
    .object({
      session,
      collection,
      record: z.string().min(1).describe('Exact document id').optional(),
      text: z.string().min(1).describe('Full record text, preserved verbatim'),
      title: z.string().describe('Record title').optional(),
      source: z.string().describe('Attribution only; no URL fetch').optional(),
    })
    .strict(),
  record_update: z
    .object({
      session,
      collection,
      record: z.string().min(1).describe('Exact document id'),
      text: z.string().min(1).describe('Full record text, preserved verbatim'),
      title: z.string().describe('Record title').optional(),
      source: z.string().describe('Attribution only; no URL fetch').optional(),
    })
    .strict(),
  record_delete: z
    .object({
      session,
      collection,
      record: z.string().min(1).describe('Exact document id'),
    })
    .strict(),
  rag_search: z.object({
    session,
    query: z.string().min(1),
    collections: z.array(collection).optional(),
    k: z.number().int().min(1).max(20).default(8),
  }),
  rag_read: z.object({
    session,
    collection,
    id: z.string().min(1),
    offset,
    limit: z.number().int().min(1).max(32000).default(8000),
  }),
  collections_list: z.object({ session }),
  collection_set_enabled: z.object({ session, collection, enabled }),
  collection_records: z.object({
    session,
    collection,
    offset,
    limit: z.number().int().min(1).max(200).default(50),
  }),
  record_set_enabled: z.object({
    session,
    collection,
    id: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    uploadId: z.string().optional(),
    enabled,
  }),
};
export type RagMcpTool = keyof typeof ragMcpSchemas;
export const ragToolNames: RagMcpTool[] = [
  'collection_create',
  'collection_delete',
  'record_add',
  'record_update',
  'record_delete',
  'rag_search',
  'rag_read',
  'collections_list',
  'collection_set_enabled',
  'collection_records',
  'record_set_enabled',
];
const writeConditions =
  ' Eligible user/session knowledge collections; existing global mutations require MCP_Admin where REST resolves them; agents collections are excluded. Requires a live caller-owned session (argument, x-clh-session, or clh_session cookie). Maximum UTF-8 JSON arguments: 10 MiB.';
export const ragDescriptions: Record<RagMcpTool, string> = {
  collection_create:
    'Create a user/session knowledge collection idempotently.' +
    writeConditions,
  collection_delete: `Delete a collection.${writeConditions}`,
  record_add:
    'Add one unchunked text record, optionally with an exact caller-chosen record id (existing ids fail with RECORD_EXISTS); source is attribution only, no URL fetch.' +
    writeConditions,
  record_update:
    'Update one record: replace the full text, retaining omitted title/source; source is attribution only, no URL fetch.' +
    writeConditions,
  record_delete: `Delete one record by exact document id.${writeConditions}`,
  rag_search:
    'Search RAG content in collections enabled for this session; collections only narrows the selection.',
  rag_read:
    'Read a RAG record, paged by characters. Disabled content exposes attributes and a reason only.',
  collections_list:
    'List readable collections and their effective session enablement.',
  collection_set_enabled:
    'Enable or disable a collection for this session only.',
  collection_records:
    'List a page of record attributes and visible titles in a collection.',
  record_set_enabled:
    'Enable or disable a record by id or all chunks of a source upload. Requires write permission.',
};

export function isRagTool(name: string): name is RagMcpTool {
  return ragToolNames.some((candidate) => candidate === name);
}
export function ragToolEffect(name: RagMcpTool): 'read' | 'write' {
  return [
    'rag_search',
    'rag_read',
    'collections_list',
    'collection_records',
  ].includes(name)
    ? 'read'
    : 'write';
}
export function eligibleRagTools(): RagMcpTool[] {
  return ragToolNames.filter(
    (name) =>
      profileToolAllowed(name) &&
      (!isReadOnlyTools() || ragToolEffect(name) === 'read'),
  );
}
export function buildRagToolSchemas() {
  return eligibleRagTools().map((name) => ({
    type: 'function' as const,
    function: {
      name,
      description: ragDescriptions[name],
      parameters: z.toJSONSchema(ragMcpSchemas[name], { io: 'input' }),
    },
  }));
}

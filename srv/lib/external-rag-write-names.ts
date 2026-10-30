/** External agent tools must never reach internal LLM adapters. */
export const externalRagWriteNames: ReadonlySet<string> = new Set([
  'collection_create',
  'collection_delete',
  'record_add',
  'record_update',
  'record_delete',
]);

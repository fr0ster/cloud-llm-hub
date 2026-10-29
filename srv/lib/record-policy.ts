import type { RagMetadata } from '@mcp-abap-adt/llm-agent';

/** The single policy for record attributes in LLM-facing reads.
 * Collection enablement is resolved by the caller for the current session.
 * Lifecycle tags (superseded/deprecated) are filtered separately by retrieval.
 */
export type RecordVisibility =
  | { visible: true }
  | { visible: false; reason: 'record-disabled' | 'collection-disabled' };

export function recordPolicy(
  metadata: Readonly<RagMetadata>,
  collectionEnabled: boolean,
): RecordVisibility {
  if (!collectionEnabled)
    return { visible: false, reason: 'collection-disabled' };
  if (metadata.enabled === false)
    return { visible: false, reason: 'record-disabled' };
  return { visible: true };
}

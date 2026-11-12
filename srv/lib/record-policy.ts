import type { RagMetadata } from '@mcp-abap-adt/llm-agent';
import type { CollectionMeta, RagDocument } from '../rag-collections';
import { type RecordTrustView, type TrustInput, trustView } from './trust';

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

/** Safe, normalized attributes shared by all LLM-facing record responses. */
export type RecordAttributes = { enabled: boolean } & RecordTrustView;
export function recordAttributes(
  doc: RagDocument,
  input: TrustInput | { trusted: false },
): RecordAttributes {
  return { enabled: doc.metadata.enabled !== false, ...trustView(input) };
}
export function documentView(
  doc: RagDocument,
  input: TrustInput | { trusted: false },
): RagDocument & RecordAttributes {
  return { ...doc, ...recordAttributes(doc, input) };
}
export function collectionView(
  meta: CollectionMeta,
  input: TrustInput | { trusted: false },
):
  | (CollectionMeta & {
      trusted: true;
      trust: number;
      trustOverride?: number;
      trustClass: TrustInput['class'];
    })
  | (CollectionMeta & { trusted: false }) {
  const { trust: _trust, trustHistory: _history, ...rest } = meta;
  if (!input.trusted) return { ...rest, trusted: false };
  return {
    ...meta,
    trusted: true,
    trust: input.collectionTrust ?? input.classTrust,
    trustClass: input.class,
    ...(input.collectionTrust !== undefined
      ? { trustOverride: input.collectionTrust }
      : {}),
  };
}
/** Called only at informational collection ingress, never on internal payloads. */
export function sanitizeExternalMetadata<T extends object>(
  metadata: T,
): Omit<
  T,
  | 'trust'
  | 'trustHistory'
  | '_trust'
  | '_trustHistory'
  | 'ownerScope'
  | 'userId'
  | 'sessionId'
  | 'roleId'
> {
  const result = { ...metadata };
  for (const key of [
    'trust',
    'trustHistory',
    '_trust',
    '_trustHistory',
    'ownerScope',
    'userId',
    'sessionId',
    'roleId',
  ])
    Reflect.deleteProperty(result, key);
  return result;
}

export type { RecordTrustView } from './trust';

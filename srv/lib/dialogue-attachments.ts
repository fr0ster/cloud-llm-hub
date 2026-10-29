import type { Request } from 'express';
import { getCollectionRegistry } from '../agent-manager';
import { resolveRouteId } from '../collection-ids';
import { requestedCollectionIds } from './collection-retrieval';
import { collectionEnabled } from './collection-toggle';
import { recordPolicy } from './record-policy';

export const DIALOGUE_ATTACHMENT_CHARS = 16_000;

export interface DialogueAttachmentRequest {
  attachment_document_ids?: string[];
}

/** Explicit uploads are request data. Read bounded records without vector search. */
export async function dialogueAttachments(
  req: Pick<
    Request<never, never, DialogueAttachmentRequest>,
    'headers' | 'body'
  >,
  userId: string,
  sessionId: string,
): Promise<string | undefined> {
  const documentIds = req.body?.attachment_document_ids;
  if (!Array.isArray(documentIds) || documentIds.length === 0) return undefined;
  if (
    !documentIds.every((id: string) => typeof id === 'string' && id.length > 0)
  )
    throw new Error('attachment_document_ids must contain nonempty strings');
  if (!requestedCollectionIds(req).includes('uploads')) return undefined;
  const registry = getCollectionRegistry();
  const id = await resolveRouteId(
    registry,
    'uploads',
    userId,
    sessionId,
    false,
  );
  if (!id) throw new Error('Attached uploads collection is unavailable');
  const meta = await registry.getCollection(id);
  if (!meta) throw new Error('Attached uploads collection is unavailable');
  const enabled = collectionEnabled(registry, userId, sessionId, meta);
  const explicitSessionUpload =
    meta.scope === 'session' && meta.sessionId === sessionId;
  let text = '';
  for (const documentId of [...new Set(documentIds)].slice(0, 100)) {
    const doc = await registry.getDocument(id, documentId);
    if (!doc) continue;
    if (
      !recordPolicy(doc.metadata ?? {}, enabled || explicitSessionUpload)
        .visible
    )
      continue;
    const tags = doc.metadata.tags;
    if (
      Array.isArray(tags) &&
      (tags.includes('superseded') || tags.includes('deprecated'))
    )
      continue;
    const source =
      typeof doc.metadata.source === 'string' ? doc.metadata.source : doc.id;
    text += `\n--- ${source} ---\n${doc.text}`.slice(
      0,
      DIALOGUE_ATTACHMENT_CHARS - text.length,
    );
    if (text.length >= DIALOGUE_ATTACHMENT_CHARS) break;
  }
  if (!text) return undefined;
  const notice =
    '\n[Attachment preview bounded to 16000 characters / 100 records; workers can read remaining uploads with RAG tools.]';
  return text.slice(0, DIALOGUE_ATTACHMENT_CHARS - notice.length) + notice;
}

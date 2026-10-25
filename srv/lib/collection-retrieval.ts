import type { Message } from '@mcp-abap-adt/llm-agent';
import type cds from '@sap/cds';
import type { Request } from 'express';
import { getCollectionRegistry, getQueryEmbedder } from '../agent-manager';
import { resolveRouteId } from '../collection-ids';
import { CollectionSearchRag } from '../rag-collections';
import { CollectionBackendError } from './collection-persistence';
import { withRagContext } from './rag-context-marker';

export function requestedCollectionIds(
  req: Pick<Request, 'headers' | 'body'>,
): string[] {
  const header = req.headers['x-rag-collections'] as string | undefined;
  if (header)
    return header
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const collections = req.body?.rag_collections;
  return Array.isArray(collections) ? collections : [];
}

/**
 * Create only after admission: earlier store injection would affect runs ahead
 * of this request in the queue. Restore in finally, including after search errors.
 * Interleaved admitted runs still share deps, a pre-existing race until stores
 * become per-request. CollectionSearchRag excludes tool/destination filters.
 */
export function collectionRetrieval(agent: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: access internal deps for RAG injection
  const deps = (agent as any).deps;
  const originalRagStores = deps.ragStores;
  return {
    restore() {
      if (deps.ragStores !== originalRagStores)
        deps.ragStores = originalRagStores;
    },
    async retrieve(
      req: Pick<Request, 'headers' | 'body'>,
      messages: Message[],
      userId: string,
      sessionId: string | undefined,
      log: ReturnType<typeof cds.log>,
      headersSent = false,
    ): Promise<
      | { messages: Message[]; refusal?: never }
      | {
          refusal: {
            status: number;
            message: string;
            kind: 'conflict' | 'service_unavailable';
          };
          messages?: never;
        }
    > {
      const ragCollectionIds = requestedCollectionIds(req);
      // Resolve each entry: bare logical names → caller's own physical id; physical
      // ids owned by another user → dropped. Session collection shadows user
      // collection. Reused by both the RAG store injection and semantic search below.
      // Persistent collections are restored first; until a restore succeeds a
      // request naming collections gets the explicit 503, not an answer quietly
      // made without them. A chat naming only presets (each entry a preset this
      // process holds for the caller) goes on meanwhile: presets live in this
      // process. A session collection of the same name that the restore has not
      // read back yet cannot shadow it then.
      let presetsOnly: string[] | undefined;
      if (ragCollectionIds.length > 0) {
        try {
          await getCollectionRegistry().ready;
        } catch (err) {
          if (!(err instanceof CollectionBackendError) || headersSent)
            throw err;
          const registry = getCollectionRegistry();
          const presets = ragCollectionIds.map((entry) =>
            registry.heldPresetFor(entry, userId),
          );
          if (presets.every((id): id is string => id !== undefined)) {
            presetsOnly = presets;
          } else {
            log.warn('Chat refused: collections unavailable', {
              error: err.message,
            });
            return {
              refusal: {
                status: err.httpStatus,
                message: err.message,
                kind: 'service_unavailable',
              },
            };
          }
        }
      }
      const resolvedCollectionIds: string[] =
        presetsOnly ??
        (ragCollectionIds.length > 0
          ? await (async () => {
              const registry = getCollectionRegistry();
              const ids: string[] = [];
              for (const entry of ragCollectionIds) {
                const id = await resolveRouteId(
                  registry,
                  entry,
                  userId,
                  sessionId,
                  false,
                );
                if (id !== undefined) ids.push(id);
              }
              return ids;
            })()
          : []);

      // A named collection that cannot be searched (restored incompatible or
      // unavailable) refuses the turn, before anything streams: 409 / 503 naming
      // the collection and its cause — never an answer quietly made without it.
      if (resolvedCollectionIds.length > 0) {
        const refusal = await getCollectionRegistry().degradedOf(
          resolvedCollectionIds,
        );
        if (refusal) {
          log.warn('Chat refused: a named collection is degraded', {
            error: refusal.message,
          });
          return {
            refusal: {
              status: refusal.httpStatus,
              message: refusal.message,
              kind:
                refusal.httpStatus === 409 ? 'conflict' : 'service_unavailable',
            },
          };
        }
      }

      if (resolvedCollectionIds.length > 0) {
        const registry = getCollectionRegistry();
        const dynamicStores = await registry.getRagStores(
          resolvedCollectionIds,
        );
        const injected = Object.keys(dynamicStores);
        if (injected.length > 0) {
          const mergedStores = { ...originalRagStores };
          for (const [key, store] of Object.entries(dynamicStores)) {
            mergedStores[key] = new CollectionSearchRag(store);
          }
          deps.ragStores = mergedStores;
          log.info('Dynamic RAG collections injected', {
            requested: ragCollectionIds,
            resolved: resolvedCollectionIds,
            injected,
          });
        }
      }

      // Semantic search across active RAG collections and inject relevant results.
      // llm-agent hardcoded flow only queries RAG for "action" subprompts —
      // chat questions classified as "chat" → RAG skipped. We do our own search.
      if (resolvedCollectionIds.length > 0) {
        const registry = getCollectionRegistry();
        const userMessage = messages
          .filter((m) => m.role === 'user')
          .slice(-1)[0];
        const queryText =
          typeof userMessage?.content === 'string' ? userMessage.content : '';

        if (queryText) {
          // Search user collections in the ORIGINAL language (no translation).
          // User content may be in any language — translating the query would
          // break matching (e.g., Ukrainian query → English translation won't
          // match Ukrainian anecdote in vector space).
          // Tool selection has its own _toEnglishForRag() in llm-agent.
          const { QueryEmbedding, TextOnlyEmbedding } = await import(
            '@mcp-abap-adt/llm-agent'
          );
          const embedder = getQueryEmbedder();
          const embedding = embedder
            ? new QueryEmbedding(queryText, embedder)
            : new TextOnlyEmbedding(queryText);

          const relevantTexts: string[] = [];
          for (const colId of resolvedCollectionIds) {
            // Degraded collections were refused above, before the turn started.
            const store = await registry.getRagStore(colId);
            if (!store) continue;
            const result = await store.query(embedding, 3);
            if (result.ok) {
              for (const r of result.value) {
                log.info('RAG search result', {
                  collection: colId,
                  score: r.score.toFixed(4),
                  preview: r.text.slice(0, 80),
                });
                const threshold =
                  Number(process.env.RAG_SCORE_THRESHOLD) || 0.15;
                if (r.score >= threshold) {
                  relevantTexts.push(r.text);
                }
              }
            }
          }

          if (relevantTexts.length > 0) {
            const ragContext = relevantTexts.join('\n---\n');
            let lastUserIdx = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
              if (messages[i].role === 'user') {
                lastUserIdx = i;
                break;
              }
            }
            if (lastUserIdx >= 0) {
              messages = [...messages];
              messages[lastUserIdx] = withRagContext(
                messages[lastUserIdx],
                ragContext,
              );
            }
            log.info('RAG semantic search results injected', {
              collections: resolvedCollectionIds,
              resultCount: relevantTexts.length,
              contextChars: ragContext.length,
            });
          }
        }
      }

      return { messages };
    },
  };
}

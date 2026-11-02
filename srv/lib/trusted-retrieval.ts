import type { IRag, RagResult } from '@mcp-abap-adt/llm-agent';
import type { CollectionMeta } from '../rag-collections';
import { restoredDocument } from './collection-persistence';
import type { TrustResolver } from './trust-resolver';

/** Resolve on every read; never trust free-form provenance or capture effective values. */
export function trustedRetrievalStore(
  rag: IRag,
  resolver: () => TrustResolver | Promise<TrustResolver>,
  collection?: CollectionMeta,
): IRag {
  const enrich = async (row: RagResult): Promise<RagResult> => {
    const trust = await resolver();
    const {
      trust: _storedTrust,
      source: _storedSource,
      ...metadata
    } = row.metadata ?? {};
    if (collection?.collectionKind === 'agents') return { ...row, metadata };
    const id = typeof metadata.id === 'string' ? metadata.id : '';
    const input = collection
      ? trust.inputFor(
          restoredDocument(collection.id, { id, text: row.text, metadata }),
          collection,
        )
      : undefined;
    return {
      ...row,
      metadata: {
        ...metadata,
        source: input?.trusted ? input.source : 'session',
        trust: input?.trusted
          ? (input.recordTrust ?? input.collectionTrust ?? input.classTrust)
          : trust.classDefault('session'),
      },
    };
  };
  return new Proxy(rag, {
    get(target, property) {
      if (property === 'query')
        return async (...args: Parameters<IRag['query']>) => {
          const result = await target.query(...args);
          return result.ok
            ? { ...result, value: await Promise.all(result.value.map(enrich)) }
            : result;
        };
      if (property === 'getById')
        return async (...args: Parameters<IRag['getById']>) => {
          const result = await target.getById(...args);
          return result.ok && result.value
            ? { ...result, value: await enrich(result.value) }
            : result;
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

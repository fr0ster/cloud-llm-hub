import {
  type CallOptions,
  type IRag,
  type PlannerKnowledgeEntry,
  type PlannerMemoryEntry,
  type PlannerRequestRecord,
  QueryEmbedding,
} from '@mcp-abap-adt/llm-agent';
import {
  DefaultPlannerContextBuilder,
  type PlannerRetrievalOptions,
} from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';
import { getAgentConfig } from '../agent-config';
import {
  getCollectionRegistry,
  getProviders,
  historyProvider,
} from '../agent-manager';
import { resolveByName } from '../collection-ids';
import {
  PersistentHistoryStore,
  storePrefixFor,
} from './collection-persistence';
import { collectionEnabled } from './collection-toggle';
import { plannerContext, plannerMemoryStore } from './planner-context';
import {
  forgetScopedPlannerMemory,
  scopedPlannerMemory,
} from './planner-memory-scope';
import { turnOwner } from './session-history-rag';
import { fingerprintHash } from './tool-corpus';
import {
  resolverFor,
  runWithTrustResolver,
  type TrustResolver,
} from './trust-resolver';
import { trustedRetrievalStore } from './trusted-retrieval';

let sharedPlannerMemoryRag: IRag | undefined;

export function getSharedPlannerMemoryRag(): IRag | undefined {
  if (sharedPlannerMemoryRag) return sharedPlannerMemoryRag;
  try {
    const stores = getProviders().stores;
    const kind = stores.backendOf('session');
    sharedPlannerMemoryRag = plannerMemoryStore({
      kind,
      create: (scope, name) => stores.create(scope, name),
      persistent: () =>
        new PersistentHistoryStore(
          historyProvider(kind),
          cds.log('planner-memory'),
          {
            storePrefix: storePrefixFor(
              kind,
              getAgentConfig().rag.qdrant?.prefix,
            ),
            storeName: 'h_planner_memory',
          },
        ),
    });
    return sharedPlannerMemoryRag;
  } catch (err) {
    cds.log('planner-memory').warn('Planner memory store could not be built', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Delete only the hub owner scoped planner records. */
export async function forgetPlannerMemory(owner: string): Promise<boolean> {
  try {
    const rag = getSharedPlannerMemoryRag();
    if (!rag) return true;
    return await forgetScopedPlannerMemory(rag, owner);
  } catch (err) {
    cds.log('planner-memory').warn('Planner memory cleanup failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Resolve optional planner retrieval without making session opening depend on providers. */
export async function plannerSessionOptions(
  userId: string,
  key: string,
  resolver?: TrustResolver | (() => Promise<TrustResolver>),
): Promise<PlannerRetrievalOptions> {
  try {
    const embedding = getProviders().embedding;
    return await plannerContext({
      memory: () => {
        const rag = getSharedPlannerMemoryRag();
        return rag
          ? trustedRetrievalStore(
              scopedPlannerMemory(rag, turnOwner(userId, key), key),
              async () =>
                typeof resolver === 'function'
                  ? resolver()
                  : (resolver ?? resolverFor(getCollectionRegistry())),
            )
          : undefined;
      },
      embedding: embedding
        ? {
            retrieval: embedding.retrieval,
            key: fingerprintHash(embedding.fingerprint),
          }
        : undefined,
      names: getAgentConfig().agent.plannerKnowledge ?? [],
      enabled: async (name) => {
        const registry = getCollectionRegistry();
        const id = await resolveByName(
          registry,
          name,
          userId,
          undefined,
          false,
          'user',
        );
        const meta = id ? await registry.getCollection(id) : null;
        return !!meta && collectionEnabled(registry, userId, key, meta);
      },
      collection: async (name) => {
        const registry = getCollectionRegistry();
        const id = await resolveByName(
          registry,
          name,
          userId,
          undefined,
          false,
          'user',
        );
        const rag = id ? await registry.getRagStore(id) : null;
        const meta = id ? await registry.getCollection(id) : null;
        if (!rag || !meta) return rag;
        return trustedRetrievalStore(
          rag,
          async () =>
            typeof resolver === 'function'
              ? resolver()
              : (resolver ?? resolverFor(registry)),
          meta,
        );
      },
      warn: (message) => cds.log('planner-memory').warn(message),
    });
  } catch (err) {
    cds.log('planner-memory').warn('Planner session options unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** Retrieve author evidence using the same request, limits and rendering as the coordinator. */
export async function planAuthorContextNotes(
  config: PlannerRetrievalOptions,
  sessionId: string,
  request: PlannerRequestRecord,
  options: CallOptions = {},
): Promise<string[]> {
  const query = request.text.slice(0, 2_000);
  const memory: PlannerMemoryEntry[] = [];
  const knowledge: PlannerKnowledgeEntry[][] = [];
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const call = { ...options, sessionId, signal };
  const warn = () =>
    cds.log('planner-memory').warn('Plan author retrieval failed');
  try {
    await Promise.race([
      Promise.all([
        ...(config.plannerKnowledge ?? []).map(async (source, index) => {
          try {
            const entries = await source.search(
              { text: query },
              config.knowledgeK ?? 4,
              call,
            );
            signal.throwIfAborted();
            knowledge[index] = entries
              .slice(0, config.knowledgeK ?? 4)
              .map((entry) => ({ ...entry, collection: source.name }));
          } catch {
            warn();
          }
        }),
        (async () => {
          const store = config.plannerMemory;
          if (!store) return;
          try {
            const result = await store.rag.query(
              new QueryEmbedding(query, store.queryEmbedder, call),
              2 * (config.memoryK ?? 8),
              { ...call, ragFilter: { sessionId } },
            );
            signal.throwIfAborted();
            if (!result.ok) throw result.error;
            for (const entry of result.value) {
              const meta = entry.metadata;
              if (
                meta.sessionId !== sessionId ||
                meta.requestId === request.id ||
                ![
                  'planner-input',
                  'planner-reply',
                  'planner-task',
                  'planner-plan',
                ].includes(String(meta.kind)) ||
                typeof meta.requestId !== 'string' ||
                typeof meta.sourceId !== 'string' ||
                typeof meta.offset !== 'number'
              )
                continue;
              memory.push({
                kind: meta.kind as PlannerMemoryEntry['kind'],
                requestId: meta.requestId,
                sourceId: meta.sourceId,
                offset: meta.offset,
                text: entry.text,
                trust:
                  typeof meta.trust === 'number'
                    ? meta.trust
                    : resolverFor({
                        currentMeta: () => undefined,
                      }).classDefault('session'),
                source: 'session',
              });
              if (memory.length >= (config.memoryK ?? 8)) break;
            }
          } catch {
            warn();
          }
        })(),
      ]),
      new Promise<void>((resolve) => {
        const done = () => resolve();
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) resolve();
      }),
    ]);
  } finally {
    controller.abort();
  }
  // The public builder supplies the library's escaped, per-source budgeted blocks.
  return new DefaultPlannerContextBuilder()
    .build({
      open: { ...request, transcript: [{ role: 'user', content: '' }] },
      memory: [...memory],
      knowledge: knowledge.flat(),
      notes: [],
      memoryCharBudget: config.memoryCharBudget,
      knowledgeCharBudget: config.knowledgeCharBudget,
    })
    .map((message) => message.content ?? '')
    .filter(Boolean);
}

/** Role binding is independent of later trust-tag projection at the LLM boundary. */
export function roleRetrievalStore(
  rag: IRag,
  resolver: TrustResolver | (() => Promise<TrustResolver>),
): IRag {
  return new Proxy(rag, {
    get(target, property) {
      if (property === 'query')
        return async (...args: Parameters<IRag['query']>) =>
          runWithTrustResolver(
            typeof resolver === 'function' ? await resolver() : resolver,
            () => target.query(...args),
          );
      if (property === 'getById')
        return async (...args: Parameters<IRag['getById']>) =>
          runWithTrustResolver(
            typeof resolver === 'function' ? await resolver() : resolver,
            () => target.getById(...args),
          );
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

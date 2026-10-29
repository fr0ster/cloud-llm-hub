import type { IRag } from '@mcp-abap-adt/llm-agent';
import type { PlannerRetrievalOptions } from '@mcp-abap-adt/llm-agent-libs';
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
): Promise<PlannerRetrievalOptions> {
  try {
    const embedding = getProviders().embedding;
    return await plannerContext({
      memory: () => {
        const rag = getSharedPlannerMemoryRag();
        return rag
          ? scopedPlannerMemory(rag, turnOwner(userId, key), key)
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
        return id ? registry.getRagStore(id) : null;
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

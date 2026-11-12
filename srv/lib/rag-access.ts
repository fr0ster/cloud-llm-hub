import {
  createHanaVectorRagAccessStores,
  HanaVectorRagProvider,
} from '@mcp-abap-adt/hana-vector-rag';
import {
  InMemoryRagRoleStore,
  InMemorySessionBindingStore,
  type IRagAccessDecision,
  type IRagProvider,
  type IRagRoleAdmin,
  type RagAccess,
} from '@mcp-abap-adt/llm-agent';
import {
  createPgVectorRagAccessStores,
  PgVectorRagProvider,
} from '@mcp-abap-adt/pg-vector-rag';
import {
  createQdrantVectorRagAccessStores,
  QdrantRagProvider,
} from '@mcp-abap-adt/qdrant-rag';
import type { RagBackendKind } from '../agent-config';

export interface HubRagAccess {
  readonly access: RagAccess;
  readonly roleAdmin: IRagRoleAdmin;
}

export function hubAccessDecision(): IRagAccessDecision {
  return {
    async canRead() {
      return true;
    },
    async canWrite(caller, ref) {
      return ref.owner.scope !== 'global' || caller.isAdmin;
    },
  };
}

export function createHubRagAccess(
  collections: IRagProvider | null,
  kind: RagBackendKind,
): HubRagAccess {
  const decision = hubAccessDecision();
  switch (kind) {
    case 'hana-vector': {
      if (!(collections instanceof HanaVectorRagProvider))
        throw new Error('hana-vector requires a HanaVectorRagProvider');
      const { roles, roleAdmin, bindings } =
        createHanaVectorRagAccessStores(collections);
      return { access: { decision, roles, bindings }, roleAdmin };
    }
    case 'pg-vector': {
      if (!(collections instanceof PgVectorRagProvider))
        throw new Error('pg-vector requires a PgVectorRagProvider');
      const { roles, roleAdmin, bindings } =
        createPgVectorRagAccessStores(collections);
      return { access: { decision, roles, bindings }, roleAdmin };
    }
    case 'qdrant': {
      if (!(collections instanceof QdrantRagProvider))
        throw new Error('qdrant requires a QdrantRagProvider');
      const { roles, roleAdmin, bindings } =
        createQdrantVectorRagAccessStores(collections);
      return { access: { decision, roles, bindings }, roleAdmin };
    }
    default: {
      const roles = new InMemoryRagRoleStore(() => true);
      return {
        access: {
          decision,
          roles,
          bindings: new InMemorySessionBindingStore(),
        },
        roleAdmin: roles,
      };
    }
  }
}

let hubRagAccess: HubRagAccess | undefined;
let hubRagAccessFactory: (() => HubRagAccess) | undefined;

export function initHubRagAccess(
  value: HubRagAccess | (() => HubRagAccess),
): void {
  hubRagAccess = typeof value === 'function' ? undefined : value;
  hubRagAccessFactory = typeof value === 'function' ? value : undefined;
}

export function getHubRagAccess(): HubRagAccess {
  if (!hubRagAccess && hubRagAccessFactory)
    hubRagAccess = hubRagAccessFactory();
  if (!hubRagAccess) throw new Error('Hub RagAccess is not initialised');
  return hubRagAccess;
}

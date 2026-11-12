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

import {
  collectionAccessTarget,
  collectionWriteScope,
} from './collection-write-context';
import { RagWriteError } from './rag-write-error';

export interface HubRagAccess {
  readonly access: RagAccess;
  readonly roleAdmin: IRagRoleAdmin;
}

export function collectionWriteError(
  meta: {
    id?: string;
    collectionKind?: string;
    scope?: string;
    owner?: string;
  },
  operation?: 'create' | 'add',
  recordId?: string,
): Error | undefined {
  const {
    isTaskResultStoreWrite,
  }: typeof import('./task-result-store') = require('./task-result-store');
  const {
    collectionAccessError,
  }: typeof import('./collection-access') = require('./collection-access');
  if (
    meta.collectionKind === 'task-results' &&
    !isTaskResultStoreWrite(meta.id, operation, recordId)
  )
    return new RagWriteError(
      'TOOL_FORBIDDEN',
      403,
      'Task results are written by the session store only',
    );
  if (meta.collectionKind !== 'agents') return;
  const scope = collectionWriteScope();
  if (scope?.origin === 'tool')
    return new Error('TOOL_FORBIDDEN: agents configuration is REST-only');
  if (scope?.origin === 'rest') {
    if (meta.scope === 'global' && !scope.admin)
      return new Error('MCP_Admin role required for global collections');
    const refusal = collectionAccessError(
      {
        collectionKind: meta.collectionKind,
        scope: meta.scope,
        owner: meta.owner,
      },
      scope.userId,
      'write',
    );
    if (refusal) return new Error(refusal.message);
  }
}

type WriteMeta = Parameters<typeof collectionWriteError>[0];
export function hubAccessDecision(
  metaFor: (name: string) => WriteMeta | undefined = () => undefined,
): IRagAccessDecision {
  return {
    async canRead() {
      return true;
    },
    async canWrite(caller, ref) {
      const meta = collectionAccessTarget(ref.name) ?? metaFor(ref.name);
      if (meta) {
        const {
          taskResultStoreWriteTarget,
        }: typeof import('./task-result-store') = require('./task-result-store');
        const target = taskResultStoreWriteTarget(ref.name);
        if (
          collectionWriteError(
            meta,
            target?.operation === 'read' ? undefined : target?.operation,
            target?.operation === 'add' ? target.recordId : undefined,
          )
        )
          return false;
      }
      return ref.owner.scope !== 'global' || caller.isAdmin;
    },
  };
}

export function createHubRagAccess(
  collections: IRagProvider | null,
  kind: RagBackendKind,
): HubRagAccess {
  const decision = hubAccessDecision((name) => {
    const {
      getCollectionRegistry,
    }: typeof import('../agent-manager') = require('../agent-manager');
    return getCollectionRegistry().currentMeta(name);
  });
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

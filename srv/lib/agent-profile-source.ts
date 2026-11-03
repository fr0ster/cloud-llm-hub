import type {
  AgentProfileError,
  AgentPrompts,
  CallOptions,
  IAgentProfileSource,
  Result,
  WorkerProfile,
  WorkerProfileSummary,
} from '@mcp-abap-adt/llm-agent';
import { formatTrustTag } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import type { CollectionMeta, RagDocument } from '../rag-collections';
import {
  type AgentProfileRecord,
  validateAgentProfileRecord,
  workerProfile,
} from './agent-profile-records';
import {
  effectiveProfileTools,
  type RegisteredProfileTool,
} from './agent-profile-tools';
import { submitVerdictTool } from './checker-verdict-tool';
import { collectionAccessError } from './collection-access';
import { recordPolicy } from './record-policy';
import { resolverFor, type TrustResolver } from './trust-resolver';

export interface AgentProfileReader {
  readonly trustResolver?: TrustResolver;
  readAgentCollection(
    id: string,
    options?: CallOptions,
  ): Promise<{ meta: CollectionMeta; documents: RagDocument[] } | null>;
}
export interface AgentProfileSelection {
  readonly prepareCatalogue?: () => Promise<void>;
  readonly acceptsPolicyName?: (name: string) => boolean;
  readonly catalogue?: () => readonly RegisteredProfileTool[];
  readonly userId: string;
  readonly globalCollectionId: string;
  readonly selectedCollectionId: () => string | Promise<string>;
  readonly plannerRecord: string;
  readonly timeoutMs?: number;
}
class ProfileFailure extends Error {
  constructor(
    readonly code: AgentProfileError['code'],
    message?: string,
  ) {
    super(message ?? `Agent configuration ${code}`);
  }
}

/** Shared call options bind all reads in one resolution to one validated snapshot. */
export class AgentProfileSource implements IAgentProfileSource {
  private readonly sourceClasses = new WeakMap<
    RagDocument,
    'system' | 'correction'
  >();
  private readonly resolutions = new WeakMap<
    CallOptions,
    Promise<RagDocument[]>
  >();

  constructor(
    private readonly reader: AgentProfileReader,
    private readonly selection: AgentProfileSelection,
  ) {
    if (
      selection.timeoutMs !== undefined &&
      (!Number.isSafeInteger(selection.timeoutMs) || selection.timeoutMs < 1)
    )
      throw new Error('Invalid profile timeout');
  }
  private read(
    options: CallOptions,
    resolution?: CallOptions,
  ): Promise<RagDocument[]> {
    if (!resolution) return this.readCollection(options);
    const existing = this.resolutions.get(resolution);
    if (existing) return existing;
    const documents = this.readCollection(options);
    this.resolutions.set(resolution, documents);
    return documents;
  }

  private async readCollection(options: CallOptions): Promise<RagDocument[]> {
    await this.selection.prepareCatalogue?.();
    const id = await this.selection.selectedCollectionId();
    options.signal?.throwIfAborted();
    const collection = await this.reader.readAgentCollection(id, options);
    if (!collection) throw new ProfileFailure('missing');
    const meta = collection.meta;
    const eligible =
      meta.id === id &&
      meta.collectionKind === 'agents' &&
      !meta.agentsCopyPending &&
      (id === this.selection.globalCollectionId
        ? meta.scope === 'global' &&
          meta.logicalId === id &&
          !meta.owner &&
          !meta.sessionId &&
          !meta.expiresAt &&
          !meta.preset
        : meta.scope === 'user' &&
          Boolean(this.selection.userId) &&
          this.selection.userId !== 'anonymous' &&
          meta.owner === this.selection.userId);
    if (
      !eligible ||
      collectionAccessError(meta, this.selection.userId, false, 'read')
    )
      throw new ProfileFailure('unavailable');
    const identities = new Set<string>();
    for (const document of collection.documents) {
      const key = document.metadata.canonicalKey;
      if (typeof key !== 'string' || identities.has(key) || document.id !== key)
        throw new ProfileFailure('invalid');
      identities.add(key);
    }
    const documents = structuredClone(collection.documents);
    for (const document of documents)
      this.sourceClasses.set(
        document,
        meta.scope === 'global' ? 'system' : 'correction',
      );
    return documents;
  }
  private record(
    documents: RagDocument[],
    name: string,
    kind: AgentProfileRecord['metadata']['kind'],
  ): AgentProfileRecord {
    const document = documents.find((entry) => entry.id === name);
    if (!document) throw new ProfileFailure('missing');
    if (!recordPolicy(document.metadata, true).visible)
      throw new ProfileFailure('disabled');
    let record: AgentProfileRecord;
    try {
      record = validateAgentProfileRecord(document, 'load');
    } catch {
      throw new ProfileFailure('invalid');
    }
    if (record.metadata.kind !== kind) throw new ProfileFailure('invalid');
    this.validateTools(record);
    const sourceClass = this.sourceClasses.get(document) ?? 'system';
    const resolver = resolverFor(this.reader).forProfile(record.metadata);
    if (record.text)
      record.text = `${formatTrustTag(`${sourceClass}:profiles/${record.id}`, resolver.classDefault(sourceClass))}\n${record.text}`;
    return record;
  }
  private validateTools(record: AgentProfileRecord): void {
    if (record.metadata.kind !== 'profile' || !this.selection.catalogue) return;
    try {
      effectiveProfileTools({
        acceptsPolicyName: this.selection.acceptsPolicyName,
        catalogue: this.selection.catalogue(),
        grants: new Set<string>(),
        result: record.metadata.result,
        policy: record.metadata.tools,
      });
    } catch (error) {
      throw new ProfileFailure(
        'invalid',
        `Agent profile ${record.id}: ${error instanceof Error ? error.message : 'Invalid tool policy'}`,
      );
    }
  }
  private async run<T>(
    operation: (options: CallOptions) => Promise<T>,
    options?: CallOptions,
  ): Promise<Result<T, AgentProfileError>> {
    const controller = new AbortController();
    const abort = (): void => {
      const reason = options?.signal?.reason;
      if (reason instanceof Error && /profile.*deadline/i.test(reason.message))
        cds
          .log('agent-profile-source')
          .warn('Agent profile/preparation deadline observed');
      controller.abort();
    };
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();
    let rejectAbort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new ProfileFailure('unavailable'));
        controller.signal.addEventListener('abort', rejectAbort, {
          once: true,
        });
        if (controller.signal.aborted) rejectAbort();
      });
      const value = await Promise.race([
        operation({ ...options, signal: controller.signal }),
        stopped,
      ]);
      controller.signal.throwIfAborted();
      return { ok: true, value };
    } catch (error) {
      const code = error instanceof ProfileFailure ? error.code : 'unavailable';
      return {
        ok: false,
        error: {
          code,
          message:
            error instanceof ProfileFailure
              ? error.message
              : `Agent configuration ${code}`,
        },
      };
    } finally {
      options?.signal?.removeEventListener('abort', abort);
      if (rejectAbort)
        controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
  list(
    options?: CallOptions,
  ): Promise<Result<WorkerProfileSummary[], AgentProfileError>> {
    return this.run(async (call) => {
      const documents = await this.read(call, options);
      const summaries: WorkerProfileSummary[] = [];
      for (const document of documents) {
        if (!recordPolicy(document.metadata, true).visible) continue;
        let record: AgentProfileRecord;
        try {
          record = validateAgentProfileRecord(document, 'load');
        } catch {
          throw new ProfileFailure('invalid');
        }
        this.validateTools(record);
        if (record.metadata.kind === 'profile')
          summaries.push({
            name: record.id,
            description: `${record.metadata.description} Can read hub RAG and store results with collection_create, record_add and record_update (session scope; coordinator persists results, subject to tool policy and caller permissions).${record.metadata.result === 'verdict' ? ` Submits verdicts with ${submitVerdictTool.name}; fail requires at least one evidence-bound claim.` : ''}${record.metadata.tools === 'read-only' || record.metadata.result === 'verdict' ? ' Does not change SAP objects.' : ''}`,
            result: record.metadata.result,
          });
      }
      return summaries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    }, options);
  }
  get(
    name: string,
    options?: CallOptions,
  ): Promise<Result<WorkerProfile, AgentProfileError>> {
    return this.run(async (call) => {
      const profile = workerProfile(
        this.record(await this.read(call, options), name, 'profile'),
      );
      if (!profile) throw new ProfileFailure('invalid');
      return profile;
    }, options);
  }
  async resolveWorker(
    name: string,
    options: CallOptions = {},
  ): Promise<
    Result<{ profile: WorkerProfile; workerBase?: string }, AgentProfileError>
  > {
    const profile = await this.get(name, options);
    if (!profile.ok) return profile;
    const prompts = await this.getPrompts(options);
    if (!prompts.ok) return prompts;
    return {
      ok: true,
      value: { profile: profile.value, workerBase: prompts.value.workerBase },
    };
  }

  getPrompts(
    options?: CallOptions,
  ): Promise<Result<AgentPrompts, AgentProfileError>> {
    return this.run(async (call) => {
      const documents = await this.read(call, options);
      const coordinator = this.record(
        documents,
        this.selection.plannerRecord,
        'coordinator',
      );
      const plannerCreate = this.record(
        documents,
        'planner-create',
        'planner-author',
      );
      const plannerRevise = this.record(
        documents,
        'planner-revise',
        'planner-author',
      );
      return {
        ...(coordinator.metadata.trust ||
        plannerCreate.metadata.trust ||
        plannerRevise.metadata.trust
          ? {
              trust: {
                ...(coordinator.metadata.trust
                  ? { coordinator: coordinator.metadata.trust }
                  : {}),
                ...(plannerCreate.metadata.trust
                  ? { plannerCreate: plannerCreate.metadata.trust }
                  : {}),
                ...(plannerRevise.metadata.trust
                  ? { plannerRevise: plannerRevise.metadata.trust }
                  : {}),
              },
            }
          : {}),
        workerBase: this.record(documents, '_worker-base', 'worker-base').text,
        coordinator: this.record(
          documents,
          this.selection.plannerRecord,
          'coordinator',
        ).text,
        plannerCreate: this.record(
          documents,
          'planner-create',
          'planner-author',
        ).text,
        plannerRevise: this.record(
          documents,
          'planner-revise',
          'planner-author',
        ).text,
      };
    }, options);
  }
}

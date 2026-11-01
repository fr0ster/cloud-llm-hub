import { AsyncLocalStorage } from 'node:async_hooks';
import type { TrustMap } from '@mcp-abap-adt/llm-agent';
import type { CollectionMeta, RagDocument } from '../rag-collections';
import {
  classTrust,
  parseTrustDefaults,
  type TrustClass,
  type TrustDefaults,
  type TrustInput,
  trustMapSchema,
} from './trust';
import type { TrustStore } from './trust-store';

export interface TrustRegistry {
  currentMeta(id: string): CollectionMeta | undefined;
}
/** No resolved-value cache: every projection reads current metadata and stored overrides. */
export class TrustResolver {
  private readonly classes: TrustDefaults;
  constructor(
    private readonly registry: TrustRegistry | undefined,
    private readonly store: TrustStore | undefined,
    private readonly defaults: TrustDefaults,
    profile?: Partial<Record<TrustClass, number>>,
  ) {
    this.classes = classTrust(profile, defaults);
  }
  forProfile(profile: { trust?: TrustMap }): TrustResolver {
    const map =
      profile.trust === undefined
        ? undefined
        : trustMapSchema.parse(profile.trust);
    return new TrustResolver(this.registry, this.store, this.defaults, map);
  }
  classDefault(c: TrustClass): number {
    return this.classes[c];
  }
  systemTool(_name: string): number {
    return this.classDefault('system');
  }
  private meta(meta: CollectionMeta): CollectionMeta {
    return this.registry?.currentMeta(meta.id) ?? meta;
  }
  collection(meta: CollectionMeta): number {
    const current = this.meta(meta);
    return current.trust ?? this.classDefault(current.scope);
  }
  record(doc: RagDocument, meta: CollectionMeta): number {
    return typeof doc.metadata._trust === 'number'
      ? doc.metadata._trust
      : this.collection(meta);
  }
  inputFor(
    doc: RagDocument,
    meta: CollectionMeta,
  ): TrustInput | { trusted: false } {
    const current = this.meta(meta);
    if (current.collectionKind === 'agents') return { trusted: false };
    return {
      trusted: true,
      class: current.scope,
      source: `${current.scope}:${current.displayName}/${doc.id}`,
      classTrust: this.classDefault(current.scope),
      ...(current.trust !== undefined
        ? { collectionTrust: current.trust }
        : {}),
      ...(typeof doc.metadata._trust === 'number'
        ? { recordTrust: doc.metadata._trust }
        : {}),
    };
  }
  async inputForSkill(name: string): Promise<TrustInput> {
    const collectionTrust = await this.store?.getSource('skills');
    const recordTrust = await this.store?.getRecord('skills', name);
    return {
      trusted: true,
      class: 'global',
      source: `global:skills/${name}`,
      classTrust: this.classDefault('global'),
      ...(collectionTrust !== undefined ? { collectionTrust } : {}),
      ...(recordTrust !== undefined ? { recordTrust } : {}),
    };
  }
  async skill(name: string): Promise<number> {
    const input = await this.inputForSkill(name);
    return input.recordTrust ?? input.collectionTrust ?? input.classTrust;
  }
}

const roleTrust = new AsyncLocalStorage<TrustResolver>();
export function runWithTrustResolver<T>(
  resolver: TrustResolver,
  run: () => T,
): T {
  return roleTrust.run(resolver, run);
}
export function resolverFor(
  registry: TrustRegistry & { trustResolver?: TrustResolver },
): TrustResolver {
  return (
    roleTrust.getStore() ??
    registry.trustResolver ??
    new TrustResolver(registry, undefined, parseTrustDefaults(undefined))
  );
}

export type { TrustInput } from './trust';

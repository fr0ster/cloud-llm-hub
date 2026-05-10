import type {
  DumpListItem,
  IDumpSource,
  IJiraClient,
  ISettings,
  JiraIssueRef,
  ParsedDump,
} from './interfaces';
import type { AssigneeRuleRow } from './jira-policy';
import { computeSignature } from './jira-policy';

// Per-tick lifecycle probe: caches `getIssue` results for the duration of one
// `Discoverer.tickOnce` call. Cross-tick reads always re-fetch from Jira so a
// manual closure is detected on the next recurrence INSERT in a later tick
// (event-bounded, see spec). Long-lived TTL caches are explicitly disallowed.
export interface LifecycleProbe {
  getIssueCached(key: string): Promise<JiraIssueRef>;
}

export function createLifecycleProbe(jira: IJiraClient): LifecycleProbe {
  const cache = new Map<string, Promise<JiraIssueRef>>();
  return {
    getIssueCached(key: string): Promise<JiraIssueRef> {
      let p = cache.get(key);
      if (!p) {
        // Cache the in-flight Promise (not the resolved value) so concurrent
        // INSERTs in the same tick share the single Jira call. Errors are NOT
        // cached — on rejection the entry is evicted so the next attempt
        // re-fetches.
        p = jira.getIssue(key).catch((err) => {
          cache.delete(key);
          throw err;
        });
        cache.set(key, p);
      }
      return p;
    },
  };
}

export interface DumpRepository {
  listSystems(): Promise<string[]>;
  maxOccurredAt(system: string): Promise<string | undefined>;
  findByDumpId(
    system: string,
    dumpId: string,
  ): Promise<{ ID: string } | undefined>;
  insertParsed(
    item: DumpListItem,
    parsed: ParsedDump,
    signature: string,
    lifecycle: LifecycleProbe,
  ): Promise<string>;
  findPendingAnalysis(maxAttempts: number): Promise<
    Array<{
      ID: string;
      rawPayload: string;
      system: string;
      dumpId: string;
      analysisAttempts: number;
    }>
  >;
  updateAnalysis(id: string, patch: Record<string, unknown>): Promise<void>;
  findPendingJira(maxAttempts: number): Promise<
    Array<{
      ID: string;
      system: string;
      dumpId: string;
      signature: string;
      runtimeError?: string;
      program?: string;
      category?: string;
      recommendations?: string;
      jiraAttempts: number;
      shortText?: string;
      include?: string;
      sourceLine?: number;
      occurredAt?: string;
      abapUser?: string;
      jiraIssueKey?: string;
    }>
  >;
  updateJira(id: string, patch: Record<string, unknown>): Promise<void>;
  findJiraState(
    id: string,
  ): Promise<
    { jiraStatus: string; jiraIssueKey?: string; skipJira: boolean } | undefined
  >;
  countSignatureWithin(signature: string, sinceIso: string): Promise<number>;
  findRecentByJira(
    signature: string,
    sinceIso: string,
  ): Promise<{ ID: string; jiraIssueKey: string } | undefined>;
  listAssigneeRules(): Promise<AssigneeRuleRow[]>;
  parsePayload(system: string, dumpId: string, raw: string): ParsedDump;
}

export interface DiscovererDeps {
  settings: ISettings;
  dumpSource: IDumpSource;
  repo: DumpRepository;
  // Factory returns a fresh LifecycleProbe at the start of each tick. Discoverer
  // is decoupled from IJiraClient — monitor-service.ts wires the factory as
  // `() => createLifecycleProbe(jira)`.
  lifecycleProbeFactory: () => LifecycleProbe;
  log: (msg: string, err?: unknown) => void;
}

export class Discoverer {
  private running = false;
  constructor(private deps: DiscovererDeps) {}

  async tickOnce(): Promise<void> {
    if (this.running) {
      this.deps.log('discoverer: previous tick still running, skip');
      return;
    }
    this.running = true;
    console.log('[discoverer] tickOnce: start');
    try {
      const sigFields = await this.deps.settings.getCsv(
        'DUMP_SIGNATURE_FIELDS',
      );
      const systems = await this.deps.repo.listSystems();
      console.log('[discoverer] tickOnce: systems=', systems);
      // Fresh per-tick lifecycle probe — discarded when this method returns.
      const lifecycle = this.deps.lifecycleProbeFactory();
      for (const system of systems) {
        const since = await this.computeSince(system);
        console.log('[discoverer] tickOnce: listing', system, 'since', since);
        let items: DumpListItem[];
        try {
          items = await this.deps.dumpSource.listSince(system, since);
        } catch (e) {
          console.error('[discoverer] tickOnce: list failed', system, e);
          this.deps.log(`list ${system} failed`, e);
          continue;
        }
        console.log(
          '[discoverer] tickOnce:',
          system,
          'returned',
          items.length,
          'items',
        );
        for (const it of items) {
          const existing = await this.deps.repo.findByDumpId(
            it.system,
            it.dumpId,
          );
          if (existing) continue;
          try {
            const raw = await this.deps.dumpSource.fetch(it.system, it.dumpId);
            const parsed = this.deps.repo.parsePayload(
              it.system,
              it.dumpId,
              raw,
            );
            const sig = computeSignature(parsed.header, sigFields);
            await this.deps.repo.insertParsed(it, parsed, sig, lifecycle);
          } catch (e) {
            this.deps.log(`fetch ${it.system}/${it.dumpId} failed`, e);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async computeSince(system: string): Promise<string> {
    const last = await this.deps.repo.maxOccurredAt(system);
    if (!last) return new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    return new Date(new Date(last).getTime() - 24 * 3600_000).toISOString();
  }
}

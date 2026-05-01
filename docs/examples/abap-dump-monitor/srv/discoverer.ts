import type { ISettings, IDumpSource, ParsedDump, DumpListItem } from './interfaces';
import { computeSignature } from './jira-policy';
import type { AssigneeRuleRow } from './jira-policy';

export interface DumpRepository {
  listSystems(): Promise<string[]>;
  maxOccurredAt(system: string): Promise<string | undefined>;
  findByDumpId(system: string, dumpId: string): Promise<{ ID: string } | undefined>;
  insertParsed(item: DumpListItem, parsed: ParsedDump, signature: string): Promise<string>;
  findPendingAnalysis(maxAttempts: number): Promise<Array<{ ID: string; rawPayload: string; system: string; dumpId: string; analysisAttempts: number }>>;
  updateAnalysis(id: string, patch: Record<string, unknown>): Promise<void>;
  findPendingJira(maxAttempts: number): Promise<Array<{ ID: string; system: string; dumpId: string; signature: string; runtimeError?: string; program?: string; category?: string; recommendations?: string; jiraAttempts: number; shortText?: string; include?: string; sourceLine?: number; occurredAt?: string; abapUser?: string }>>;
  updateJira(id: string, patch: Record<string, unknown>): Promise<void>;
  findJiraState(id: string): Promise<{ jiraStatus: string; jiraIssueKey?: string; skipJira: boolean } | undefined>;
  countSignatureWithin(signature: string, sinceIso: string): Promise<number>;
  findRecentByJira(signature: string, sinceIso: string): Promise<{ ID: string; jiraIssueKey: string } | undefined>;
  listAssigneeRules(): Promise<AssigneeRuleRow[]>;
  parsePayload(system: string, dumpId: string, raw: string): ParsedDump;
}

export interface DiscovererDeps {
  settings: ISettings;
  dumpSource: IDumpSource;
  repo: DumpRepository;
  log: (msg: string, err?: unknown) => void;
}

export class Discoverer {
  private running = false;
  constructor(private deps: DiscovererDeps) {}

  async tickOnce(): Promise<void> {
    if (this.running) { this.deps.log('discoverer: previous tick still running, skip'); return; }
    this.running = true;
    try {
      const sigFields = await this.deps.settings.getCsv('DUMP_SIGNATURE_FIELDS');
      for (const system of await this.deps.repo.listSystems()) {
        const since = await this.computeSince(system);
        let items: DumpListItem[];
        try { items = await this.deps.dumpSource.listSince(system, since); }
        catch (e) { this.deps.log(`list ${system} failed`, e); continue; }
        for (const it of items) {
          const existing = await this.deps.repo.findByDumpId(it.system, it.dumpId);
          if (existing) continue;
          try {
            const raw = await this.deps.dumpSource.fetch(it.system, it.dumpId);
            const parsed = this.deps.repo.parsePayload(it.system, it.dumpId, raw);
            const sig = computeSignature(parsed.header, sigFields);
            await this.deps.repo.insertParsed(it, parsed, sig);
          } catch (e) { this.deps.log(`fetch ${it.system}/${it.dumpId} failed`, e); }
        }
      }
    } finally { this.running = false; }
  }

  private async computeSince(system: string): Promise<string> {
    const last = await this.deps.repo.maxOccurredAt(system);
    if (!last) return new Date(Date.now() - 24 * 3600_000).toISOString();
    return new Date(new Date(last).getTime() - 24 * 3600_000).toISOString();
  }
}

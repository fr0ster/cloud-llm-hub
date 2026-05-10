// @ts-expect-error - @sap/cds has no type definitions
import cds from '@sap/cds';
import type { DumpRepository, LifecycleProbe } from './discoverer';
import { parseDump } from './dump-parser';
import type { DumpListItem, ParsedDump } from './interfaces';
import { decideJiraInsertStatus } from './jira-policy';

declare const SELECT: any;
declare const INSERT: any;
declare const UPDATE: any;

// Convert ADT 14-digit timestamps (YYYYMMDDHHmmss) or any other input into ISO string.
// Returns null when input is missing/unparseable so SQLite stores NULL instead of crashing.
function toIso(input: unknown): string | null {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export class CdsDumpRepository implements DumpRepository {
  constructor(private systemId: string) {}

  parsePayload(system: string, dumpId: string, raw: string): ParsedDump {
    return parseDump(system, dumpId, raw);
  }
  async listSystems(): Promise<string[]> {
    return this.systemId ? [this.systemId] : [];
  }
  async maxOccurredAt(system: string): Promise<string | undefined> {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    const r = await SELECT.one`max(occurredAt) as m`
      .from(MonitoredDump)
      .where({ system });
    return r?.m;
  }
  async findByDumpId(system: string, dumpId: string) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.one.from(MonitoredDump).where({ system, dumpId });
  }

  async insertParsed(
    item: DumpListItem,
    parsed: ParsedDump,
    signature: string,
    lifecycle: LifecycleProbe,
  ): Promise<string> {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    const ID = cds.utils.uuid();
    // Canonical-key INSERT algorithm — see docs/DEDUPLICATION.md.
    // Pure decision is in `decideJiraInsertStatus` (test/unit/jira-policy.test.ts).
    // The two SELECTs below + the INSERT they feed are covered end-to-end by
    // test/unit/insert-integration.test.ts (cds.test() with in-memory sqlite).
    //
    // canonical = latest row in group with jiraStatus='created' AND jiraIssueKey IS NOT NULL
    const canonicalRow = await SELECT.one
      .from(MonitoredDump)
      .columns('jiraIssueKey')
      .where({ signature, jiraStatus: 'created', jiraIssueKey: { '!=': null } })
      .orderBy('firstSeenAt desc');
    let canonical: {
      jiraIssueKey: string;
      statusCategoryKey: 'open' | 'done';
    } | null = null;
    let slotRows: Array<{ jiraStatus: string }> = [];
    if (canonicalRow?.jiraIssueKey) {
      // Lifecycle recheck via the per-tick cache. Errors propagate so the
      // discoverer's per-row catch logs and skips this dump rather than
      // marking it incorrectly.
      const issue = await lifecycle.getIssueCached(canonicalRow.jiraIssueKey);
      const cat = issue.statusCategoryKey === 'done' ? 'done' : 'open';
      canonical = {
        jiraIssueKey: canonicalRow.jiraIssueKey,
        statusCategoryKey: cat,
      };
      // ALL rows in the group with the same canonical key, regardless of
      // status. The pure decision function picks which statuses count as
      // 'slot occupied' for open vs done branches.
      slotRows = await SELECT.from(MonitoredDump)
        .columns('jiraStatus')
        .where({ signature, jiraIssueKey: canonicalRow.jiraIssueKey });
    }
    const decision = decideJiraInsertStatus({
      canonical,
      slotRowsForCanonicalKey: slotRows,
    });

    await INSERT.into(MonitoredDump).entries({
      ID,
      system: item.system,
      dumpId: item.dumpId,
      runtimeError: parsed.header.runtimeError,
      exceptionClass: parsed.header.exceptionClass,
      // Prefer the MCP feed value (RuntimeListFeeds → d.category — the SAP
      // Application Component code, e.g. 'BC-ABA-LA'). Fall back to the
      // parsed ST22 header value when MCP omits the field; the dump payload
      // itself usually carries 'Application Component' in the top header.
      category: item.category ?? parsed.header.category,
      host: parsed.header.host,
      instance: parsed.header.instance,
      program: parsed.header.program,
      include: parsed.header.include,
      mainProgram: parsed.header.mainProgram,
      sourceLine: parsed.header.sourceLine,
      event: parsed.header.event,
      transactionId: parsed.header.transactionId,
      abapUser: parsed.header.abapUser,
      client: parsed.header.client,
      occurredAt: toIso(parsed.header.occurredAt ?? item.occurredAt),
      firstSeenAt: new Date().toISOString(),
      shortText: parsed.header.shortText,
      signature,
      rawPayload: parsed.rawPayload,
      analysisStatus: 'pending',
      analysisAttempts: 0,
      jiraStatus: decision.jiraStatus,
      jiraIssueKey: decision.jiraIssueKey ?? undefined,
      jiraAttempts: 0,
      skipJira: false,
      callStack: parsed.callStack.map((f) => ({ ...f, ID: cds.utils.uuid() })),
      variables: parsed.variables.map((v) => ({ ...v, ID: cds.utils.uuid() })),
      sourceExtract: parsed.sourceExtract
        ? { ...parsed.sourceExtract, ID: cds.utils.uuid() }
        : undefined,
    });
    return ID;
  }

  async findPendingAnalysis(maxAttempts: number) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    const stuckMs = Number.parseInt(
      process.env.ANALYSIS_STUCK_MS ?? '600000',
      10,
    );
    const stuckCutoff = new Date(Date.now() - stuckMs).toISOString();
    return SELECT.from(MonitoredDump)
      .columns('ID', 'rawPayload', 'system', 'dumpId', 'analysisAttempts')
      .where(
        `analysisAttempts < ${maxAttempts} and (` +
          `analysisStatus in ('pending','failed') ` +
          `or (analysisStatus = 'analyzing' and modifiedAt < '${stuckCutoff}')` +
          `)`,
      );
  }
  async updateAnalysis(id: string, patch: Record<string, unknown>) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    await UPDATE(MonitoredDump).set(patch).where({ ID: id });
  }
  async findPendingJira(maxAttempts: number) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.from(MonitoredDump)
      .columns(
        'ID',
        'system',
        'dumpId',
        'signature',
        'runtimeError',
        'program',
        'category',
        'recommendations',
        'jiraAttempts',
        'shortText',
        'include',
        'sourceLine',
        'occurredAt',
        'abapUser',
        'jiraIssueKey',
      )
      .where(
        `analysisStatus = 'done' and jiraStatus in ('pending','failed') and skipJira = false and jiraAttempts < ${maxAttempts}`,
      );
  }
  async updateJira(id: string, patch: Record<string, unknown>) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    await UPDATE(MonitoredDump).set(patch).where({ ID: id });
  }
  async findJiraState(id: string) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.one
      .from(MonitoredDump)
      .columns('jiraStatus', 'jiraIssueKey', 'skipJira')
      .where({ ID: id });
  }
  async countSignatureWithin(
    signature: string,
    sinceIso: string,
  ): Promise<number> {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    const r = await SELECT.one`count(*) as c`
      .from(MonitoredDump)
      .where({ signature, firstSeenAt: { '>=': sinceIso } });
    return Number(r?.c ?? 0);
  }
  async findRecentByJira(signature: string, sinceIso: string) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.one
      .from(MonitoredDump)
      .columns('ID', 'jiraIssueKey')
      .where({
        signature,
        firstSeenAt: { '>=': sinceIso },
        jiraIssueKey: { '!=': null },
      })
      .orderBy('firstSeenAt desc');
  }
  async listAssigneeRules() {
    const { AssigneeRule } = cds.entities('example.abapdumpmonitor');
    return SELECT.from(AssigneeRule).where({ active: true });
  }
}

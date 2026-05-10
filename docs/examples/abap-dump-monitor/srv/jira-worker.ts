import type { DumpRepository } from './discoverer';
import type { IJiraClient, ISettings } from './interfaces';
import { dueDateForCount, matchAssignee, signatureLabel } from './jira-policy';

export interface JiraWorkerDeps {
  settings: ISettings;
  jira: IJiraClient;
  repo: DumpRepository;
  log: (msg: string, err?: unknown) => void;
}

export interface JiraPendingRow {
  ID: string;
  system: string;
  dumpId: string;
  signature: string;
  runtimeError?: string;
  program?: string;
  include?: string;
  sourceLine?: number;
  category?: string;
  recommendations?: string;
  shortText?: string;
  occurredAt?: string;
  abapUser?: string;
  jiraAttempts: number;
  // Set by the discoverer if a prior dump in the same signature group already
  // has a Jira ticket — lets the worker comment / branch on the known group
  // ticket without an extra searchByLabel round-trip.
  jiraIssueKey?: string;
}

export interface JiraCtx {
  sinceIso: string;
  projectKey: string;
  issueType: string;
  baseLabels: string[];
  defaultAssignee: string | undefined;
  dueCfg: {
    first: number;
    recurring: number;
    frequent: number;
    low: number;
    high: number;
  };
  rules: any[];
}

export class JiraWorker {
  private running = false;
  private mutex: Promise<unknown> = Promise.resolve();
  constructor(private deps: JiraWorkerDeps) {}

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(fn, fn);
    this.mutex = next.catch(() => {}); // never let an error block subsequent work
    return next;
  }

  async tickOnce(): Promise<void> {
    if (this.running) {
      this.deps.log('jira-worker: previous tick still running, skip');
      return;
    }
    this.running = true;
    try {
      const mode = (await this.deps.settings.get('JIRA_MODE')) ?? 'manual';
      if (mode !== 'auto') return;
      const cap = await this.deps.settings.getInt('JIRA_MAX_ATTEMPTS', 3);
      const rows = await this.deps.repo.findPendingJira(cap);
      if (rows.length === 0) return;
      const ctx = await this.buildCtx();
      for (const row of rows) await this.processOne(row as JiraPendingRow, ctx);
    } finally {
      this.running = false;
    }
  }

  async buildCtx(): Promise<JiraCtx> {
    const historyDays = await this.deps.settings.getInt(
      'JIRA_HISTORY_DAYS',
      30,
    );
    return {
      sinceIso: new Date(Date.now() - historyDays * 86400_000).toISOString(),
      projectKey: (await this.deps.settings.get('JIRA_PROJECT_KEY')) ?? '',
      issueType: (await this.deps.settings.get('JIRA_ISSUE_TYPE')) ?? '',
      baseLabels: await this.deps.settings.getCsv('JIRA_LABELS'),
      defaultAssignee:
        (await this.deps.settings.get('JIRA_DEFAULT_ASSIGNEE')) || undefined,
      dueCfg: {
        first: await this.deps.settings.getInt('JIRA_DUE_DAYS_FIRST', 14),
        recurring: await this.deps.settings.getInt(
          'JIRA_DUE_DAYS_RECURRING',
          7,
        ),
        frequent: await this.deps.settings.getInt('JIRA_DUE_DAYS_FREQUENT', 2),
        low: await this.deps.settings.getInt('JIRA_FREQ_THRESHOLD_LOW', 2),
        high: await this.deps.settings.getInt('JIRA_FREQ_THRESHOLD_HIGH', 5),
      },
      rules: await this.deps.repo.listAssigneeRules(),
    };
  }

  async processOne(row: JiraPendingRow, ctx: JiraCtx): Promise<void> {
    return this.withLock(() => this.processOneInner(row, ctx));
  }

  private async processOneInner(
    row: JiraPendingRow,
    ctx: JiraCtx,
  ): Promise<void> {
    console.log(
      `[jira-worker] processOne start ID=${row.ID} dumpId=${row.dumpId}`,
    );
    // Re-read inside the lock. The caller's row snapshot is from before the
    // mutex was acquired, so it may be stale if another path (auto tick or
    // concurrent pushToJira) already moved this row to a terminal state.
    const fresh = await this.deps.repo.findJiraState(row.ID);
    if (!fresh) {
      console.log(`[jira-worker] bail: row deleted ${row.ID}`);
      return;
    }
    if (fresh.skipJira) {
      console.log(`[jira-worker] bail: skipJira ${row.ID}`);
      return;
    }
    if (fresh.jiraStatus !== 'pending' && fresh.jiraStatus !== 'failed') {
      console.log(
        `[jira-worker] bail: status=${fresh.jiraStatus} (not pending/failed) ${row.ID}`,
      );
      return;
    }

    try {
      // Two labels per ticket:
      //   • sigLabel: stable across every recurrence of the same root cause —
      //     the canonical dedup key. Search Jira by this to find an existing
      //     ticket for this signature.
      //   • dumpLabel: per-dump cross-reference (kept as additional metadata,
      //     not used for dedup).
      const sigLabel = signatureLabel(row.signature);
      const dumpLabel = `${row.system}-${row.dumpId}`.replace(
        /[^A-Za-z0-9._-]+/g,
        '_',
      );

      // Resolve the group ticket. The discoverer already set row.jiraIssueKey
      // if a prior dump in this signature group has one — use that directly
      // (one fewer Jira call). Otherwise fall back to a Jira-side search by
      // sigLabel, which also covers manually-created tickets the discoverer
      // never knew about.
      const existing = row.jiraIssueKey
        ? await this.deps.jira.getIssue(row.jiraIssueKey)
        : await this.deps.jira.searchByLabel(sigLabel);
      if (existing) {
        if (existing.statusCategoryKey !== 'done') {
          // Open ticket → comment instead of creating a duplicate.
          await this.deps.jira.comment(
            existing.key,
            this.recurrenceComment(row),
          );
          await this.deps.repo.updateJira(row.ID, {
            jiraStatus: 'commented',
            jiraIssueKey: existing.key,
          });
          return;
        }
        // Closed ticket → fall through to create a new one with a back-reference.
        const count = await this.deps.repo.countSignatureWithin(
          row.signature,
          ctx.sinceIso,
        );
        const duedate = dueDateForCount(count, ctx.dueCfg);
        const assignee = matchAssignee(row, ctx.rules) ?? ctx.defaultAssignee;
        const key = await this.deps.jira.create({
          projectKey: ctx.projectKey,
          issueType: ctx.issueType,
          summary: `[${row.system}] ${row.runtimeError ?? 'ABAP dump'} in ${row.program ?? '?'}@${row.include ?? '?'}:${row.sourceLine ?? '?'}`,
          description: `${this.renderDescription(row)}\n\n_Recurrence after closed ticket ${existing.key}._`,
          duedate,
          labels: [...ctx.baseLabels, sigLabel, dumpLabel],
          assignee,
        });
        await this.deps.repo.updateJira(row.ID, {
          jiraStatus: 'created',
          jiraIssueKey: key,
          jiraError: null,
        });
        return;
      }

      const count = await this.deps.repo.countSignatureWithin(
        row.signature,
        ctx.sinceIso,
      );
      const duedate = dueDateForCount(count, ctx.dueCfg);
      const assignee = matchAssignee(row, ctx.rules) ?? ctx.defaultAssignee;
      const key = await this.deps.jira.create({
        projectKey: ctx.projectKey,
        issueType: ctx.issueType,
        summary: `[${row.system}] ${row.runtimeError ?? 'ABAP dump'} in ${row.program ?? '?'}@${row.include ?? '?'}:${row.sourceLine ?? '?'}`,
        description: this.renderDescription(row),
        duedate,
        labels: [...ctx.baseLabels, sigLabel, dumpLabel],
        assignee,
      });
      console.log(`[jira-worker] created ID=${row.ID} key=${key}`);
      await this.deps.repo.updateJira(row.ID, {
        jiraStatus: 'created',
        jiraIssueKey: key,
        jiraError: null,
      });
      console.log(`[jira-worker] updateJira done ID=${row.ID}`);
    } catch (e: any) {
      console.error(`[jira-worker] FAILED ID=${row.ID}`, e?.message ?? e);
      await this.deps.repo.updateJira(row.ID, {
        jiraStatus: 'failed',
        jiraError: String(e?.message ?? e),
        jiraAttempts: row.jiraAttempts + 1,
      });
    }
  }

  private recurrenceComment(row: {
    ID: string;
    system: string;
    dumpId: string;
    occurredAt?: string;
    abapUser?: string;
  }): string {
    return `New occurrence detected.\nSystem: ${row.system}\nDump: ${row.dumpId}\nWhen: ${row.occurredAt ?? '?'}\nUser: ${row.abapUser ?? '?'}\nMonitoredDump: ${row.ID}`;
  }

  private renderDescription(row: any): string {
    return [
      `*Short text:* ${row.shortText ?? ''}`,
      `*MonitoredDump:* ${row.ID}`,
      `*Occurred at:* ${row.occurredAt ?? ''}`,
      `*User:* ${row.abapUser ?? ''}`,
      ``,
      `h3. Recommendations`,
      row.recommendations ?? '_no recommendations extracted_',
    ].join('\n');
  }
}

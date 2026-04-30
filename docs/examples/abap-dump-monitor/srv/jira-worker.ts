import type { ISettings, IJiraClient } from './interfaces';
import { dueDateForCount, matchAssignee } from './jira-policy';
import type { DumpRepository } from './discoverer';

export interface JiraWorkerDeps {
  settings: ISettings;
  jira: IJiraClient;
  repo: DumpRepository;
  log: (msg: string, err?: unknown) => void;
}

export class JiraWorker {
  private running = false;
  constructor(private deps: JiraWorkerDeps) {}

  async tickOnce(): Promise<void> {
    if (this.running) { this.deps.log('jira-worker: previous tick still running, skip'); return; }
    this.running = true;
    try {
      const cap = await this.deps.settings.getInt('JIRA_MAX_ATTEMPTS', 3);
      const rows = await this.deps.repo.findPendingJira(cap);
      if (rows.length === 0) return;

      const historyDays = await this.deps.settings.getInt('JIRA_HISTORY_DAYS', 30);
      const sinceIso = new Date(Date.now() - historyDays * 86400_000).toISOString();
      const projectKey = (await this.deps.settings.get('JIRA_PROJECT_KEY'))!;
      const issueType = (await this.deps.settings.get('JIRA_ISSUE_TYPE'))!;
      const baseLabels = await this.deps.settings.getCsv('JIRA_LABELS');
      const defaultAssignee = (await this.deps.settings.get('JIRA_DEFAULT_ASSIGNEE')) || undefined;
      const dueCfg = {
        first: await this.deps.settings.getInt('JIRA_DUE_DAYS_FIRST', 14),
        recurring: await this.deps.settings.getInt('JIRA_DUE_DAYS_RECURRING', 7),
        frequent: await this.deps.settings.getInt('JIRA_DUE_DAYS_FREQUENT', 2),
        low: await this.deps.settings.getInt('JIRA_FREQ_THRESHOLD_LOW', 2),
        high: await this.deps.settings.getInt('JIRA_FREQ_THRESHOLD_HIGH', 5)
      };
      const rules = await this.deps.repo.listAssigneeRules();

      for (const row of rows) {
        try {
          const label = `${row.system}:${row.dumpId}`;
          const dup = await this.deps.jira.searchByLabel(label);
          if (dup) {
            await this.deps.repo.updateJira(row.ID, { jiraStatus: 'skipped', jiraIssueKey: dup.key });
            continue;
          }
          const recent = await this.deps.repo.findRecentByJira(row.signature, sinceIso);
          if (recent) {
            const issue = await this.deps.jira.getIssue(recent.jiraIssueKey);
            if (issue.statusCategoryKey !== 'done') {
              await this.deps.jira.comment(issue.key, this.recurrenceComment(row));
              await this.deps.repo.updateJira(row.ID, { jiraStatus: 'commented', jiraIssueKey: issue.key });
              continue;
            }
          }
          const count = await this.deps.repo.countSignatureWithin(row.signature, sinceIso);
          const duedate = dueDateForCount(count, dueCfg);
          const assignee = matchAssignee(row, rules) ?? defaultAssignee;
          const key = await this.deps.jira.create({
            projectKey,
            issueType,
            summary: `[${row.system}] ${row.runtimeError ?? 'ABAP dump'} in ${row.program ?? '?'}@${row.include ?? '?'}:${row.sourceLine ?? '?'}`,
            description: this.renderDescription(row),
            duedate,
            labels: [...baseLabels, label],
            assignee
          });
          await this.deps.repo.updateJira(row.ID, { jiraStatus: 'created', jiraIssueKey: key, jiraError: null });
        } catch (e: any) {
          await this.deps.repo.updateJira(row.ID, {
            jiraStatus: 'failed', jiraError: String(e?.message ?? e), jiraAttempts: row.jiraAttempts + 1
          });
        }
      }
    } finally { this.running = false; }
  }

  private recurrenceComment(row: { ID: string; system: string; dumpId: string; occurredAt?: string; abapUser?: string }): string {
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
      row.recommendations ?? '_no recommendations extracted_'
    ].join('\n');
  }
}

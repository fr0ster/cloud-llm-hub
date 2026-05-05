// @ts-ignore - @sap/cds has no type definitions
import cds from '@sap/cds';

declare const SELECT: any;
declare const INSERT: any;

const SEED: Array<{ key: string; envKey: string; def: string; dataType: string; description: string }> = [
  { key: 'POLL_INTERVAL_MS',         envKey: 'POLL_INTERVAL_MS',         def: '300000',                                  dataType: 'int',    description: 'Discovery interval in ms (min 60000 enforced).' },
  { key: 'JIRA_MODE',                envKey: 'JIRA_MODE',                def: 'manual',                                  dataType: 'string', description: 'manual = wait for UI Push to Jira; auto = JiraWorker creates tickets on its own.' },
  { key: 'ANALYSIS_TICK_MS',         envKey: 'ANALYSIS_TICK_MS',         def: '10000',                                   dataType: 'int',    description: 'Analysis worker tick interval in ms.' },
  { key: 'ANALYSIS_CONCURRENCY',     envKey: 'ANALYSIS_CONCURRENCY',     def: '2',                                       dataType: 'int',    description: 'Max parallel analyses per tick.' },
  { key: 'JIRA_TICK_MS',             envKey: 'JIRA_TICK_MS',             def: '10000',                                   dataType: 'int',    description: 'Jira worker tick interval in ms.' },
  { key: 'LLM_MODEL',                envKey: 'LLM_MODEL',                def: 'anthropic--claude-4.5-sonnet',            dataType: 'string', description: 'cloud-llm-hub model id.' },
  { key: 'LLM_TEMPERATURE',          envKey: 'LLM_TEMPERATURE',          def: '0',                                       dataType: 'string', description: 'LLM temperature. 0 = deterministic decoding (right for strict-format tasks). Raise only if the analyser is repeatedly hallucinating fixes.' },
  { key: 'DUMP_SIGNATURE_FIELDS',    envKey: 'DUMP_SIGNATURE_FIELDS',    def: 'system,runtimeError,program,include',     dataType: 'csv',    description: 'Fields composing the dedup signature.' },
  { key: 'JIRA_HISTORY_DAYS',        envKey: 'JIRA_HISTORY_DAYS',        def: '30',                                      dataType: 'int',    description: 'Window for recurrence count.' },
  { key: 'JIRA_PROJECT_KEY',         envKey: 'JIRA_PROJECT_KEY',         def: 'EPMCSAPDDF',                              dataType: 'string', description: 'Jira project key.' },
  { key: 'JIRA_ISSUE_TYPE',          envKey: 'JIRA_ISSUE_TYPE',          def: 'Story',                                   dataType: 'string', description: 'Jira issue type name.' },
  { key: 'JIRA_DEFAULT_ASSIGNEE',    envKey: 'JIRA_DEFAULT_ASSIGNEE',    def: '',                                        dataType: 'string', description: 'Empty = leave unassigned.' },
  { key: 'JIRA_LABELS',              envKey: 'JIRA_LABELS',              def: 'cloud-llm-hub,abap-dump',                 dataType: 'csv',    description: 'Static labels.' },
  { key: 'JIRA_DUE_DAYS_FIRST',      envKey: 'JIRA_DUE_DAYS_FIRST',      def: '14',                                      dataType: 'int',    description: 'Due days for first occurrence.' },
  { key: 'JIRA_DUE_DAYS_RECURRING',  envKey: 'JIRA_DUE_DAYS_RECURRING',  def: '7',                                       dataType: 'int',    description: 'Due days for recurring.' },
  { key: 'JIRA_DUE_DAYS_FREQUENT',   envKey: 'JIRA_DUE_DAYS_FREQUENT',   def: '2',                                       dataType: 'int',    description: 'Due days for frequent.' },
  { key: 'JIRA_FREQ_THRESHOLD_LOW',  envKey: 'JIRA_FREQ_THRESHOLD_LOW',  def: '2',                                       dataType: 'int',    description: 'count >= LOW && < HIGH → recurring.' },
  { key: 'JIRA_FREQ_THRESHOLD_HIGH', envKey: 'JIRA_FREQ_THRESHOLD_HIGH', def: '5',                                       dataType: 'int',    description: 'count >= HIGH → frequent.' },
  { key: 'JIRA_MAX_ATTEMPTS',        envKey: 'JIRA_MAX_ATTEMPTS',        def: '3',                                       dataType: 'int',    description: 'Retry cap for Jira step.' },
  { key: 'ANALYSIS_MAX_ATTEMPTS',    envKey: 'ANALYSIS_MAX_ATTEMPTS',    def: '3',                                       dataType: 'int',    description: 'Retry cap for analysis step.' }
];

export async function seedSettings(): Promise<void> {
  const db = await cds.connect.to('db');
  const { Setting } = cds.entities('example.abapdumpmonitor');
  for (const s of SEED) {
    const existing = await db.run(SELECT.one.from(Setting).where({ key: s.key }));
    if (existing) continue;
    const value = process.env[s.envKey] ?? s.def;
    await db.run(INSERT.into(Setting).entries({
      key: s.key, value, dataType: s.dataType, description: s.description
    }));
  }
}

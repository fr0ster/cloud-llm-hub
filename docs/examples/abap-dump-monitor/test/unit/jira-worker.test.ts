import { JiraWorker } from '../../srv/jira-worker';
import type { DumpRepository } from '../../srv/discoverer';
import type { ISettings, IJiraClient } from '../../srv/interfaces';

const settings: ISettings = {
  get: jest.fn(async (k: string) => ({
    JIRA_PROJECT_KEY: 'X',
    JIRA_ISSUE_TYPE: 'Story',
    JIRA_DEFAULT_ASSIGNEE: '',
    JIRA_MODE: 'auto'
  } as Record<string, string>)[k]),
  getInt: jest.fn(async (k: string) => ({
    JIRA_MAX_ATTEMPTS: 3,
    JIRA_HISTORY_DAYS: 30,
    JIRA_DUE_DAYS_FIRST: 14,
    JIRA_DUE_DAYS_RECURRING: 7,
    JIRA_DUE_DAYS_FREQUENT: 2,
    JIRA_FREQ_THRESHOLD_LOW: 2,
    JIRA_FREQ_THRESHOLD_HIGH: 5
  } as Record<string, number>)[k]),
  getBool: jest.fn(async () => false),
  getCsv: jest.fn(async (k: string) => k === 'JIRA_LABELS' ? ['a','b'] : []),
  invalidate: jest.fn()
};

function makeRepo(pending: any[]): DumpRepository {
  return {
    listSystems: jest.fn(async () => []),
    maxOccurredAt: jest.fn(async () => undefined),
    findByDumpId: jest.fn(async () => undefined),
    insertParsed: jest.fn(),
    findPendingAnalysis: jest.fn(async () => []),
    updateAnalysis: jest.fn(),
    findPendingJira: jest.fn(async () => pending),
    updateJira: jest.fn(),
    findJiraState: jest.fn(async () => ({ jiraStatus: 'pending', skipJira: false })),
    countSignatureWithin: jest.fn(async () => 1),
    findRecentByJira: jest.fn(async () => undefined),
    listAssigneeRules: jest.fn(async () => []),
    parsePayload: jest.fn() as any
  };
}

const baseRow = { ID: '1', system: 'E19.100', dumpId: 'D-1', signature: 'sig', runtimeError: 'RE', program: 'ZP', include: 'ZI', sourceLine: 1, jiraAttempts: 0 };

describe('JiraWorker.tickOnce', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('happy path (no existing ticket): creates with sigLabel + dumpLabel', async () => {
    const jira: IJiraClient = {
      searchByLabel: jest.fn().mockResolvedValue(undefined),
      getIssue: jest.fn(),
      create: jest.fn().mockResolvedValue('X-1'),
      comment: jest.fn()
    };
    const repo = makeRepo([baseRow]);
    const w = new JiraWorker({ settings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(jira.create).toHaveBeenCalledTimes(1);
    const arg = (jira.create as jest.Mock).mock.calls[0][0];
    expect(arg.summary).toContain('RE');
    expect(arg.labels).toContain('E19.100-D-1');
    expect(arg.labels).toEqual(expect.arrayContaining([expect.stringMatching(/^dump-sig-[0-9a-f]{16}$/)]));
  });

  test('open existing ticket → comment, no new ticket', async () => {
    const jira: IJiraClient = {
      searchByLabel: jest.fn().mockResolvedValue({ key: 'X-OPEN', statusCategoryKey: 'indeterminate' }),
      getIssue: jest.fn(),
      create: jest.fn(),
      comment: jest.fn()
    };
    const repo = makeRepo([baseRow]);
    const w = new JiraWorker({ settings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(jira.comment).toHaveBeenCalledWith('X-OPEN', expect.any(String));
    expect(jira.create).not.toHaveBeenCalled();
    expect(repo.updateJira).toHaveBeenCalledWith('1', expect.objectContaining({ jiraStatus: 'commented', jiraIssueKey: 'X-OPEN' }));
  });

  test('failed retry with inherited jiraIssueKey → still uses getIssue, no searchByLabel', async () => {
    // findPendingJira returns failed rows; if such a row carries an inherited
    // key, the retry path must use getIssue so the group ticket is found, not
    // a stale label search that may miss tickets created before sigLabel existed.
    const jira: IJiraClient = {
      searchByLabel: jest.fn(),
      getIssue: jest.fn().mockResolvedValue({ key: 'X-OPEN', statusCategoryKey: 'indeterminate' }),
      create: jest.fn(),
      comment: jest.fn()
    };
    const repo = makeRepo([{ ...baseRow, jiraIssueKey: 'X-OPEN', jiraStatus: 'failed', jiraAttempts: 1 }]);
    (repo.findJiraState as jest.Mock).mockResolvedValue({ jiraStatus: 'failed', jiraIssueKey: 'X-OPEN', skipJira: false });
    const w = new JiraWorker({ settings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(jira.searchByLabel).not.toHaveBeenCalled();
    expect(jira.getIssue).toHaveBeenCalledWith('X-OPEN');
    expect(jira.comment).toHaveBeenCalledWith('X-OPEN', expect.any(String));
    expect(repo.updateJira).toHaveBeenCalledWith('1', expect.objectContaining({ jiraStatus: 'commented', jiraIssueKey: 'X-OPEN' }));
  });

  test('inherited jiraIssueKey from group → uses getIssue, skips searchByLabel', async () => {
    const jira: IJiraClient = {
      searchByLabel: jest.fn(),
      getIssue: jest.fn().mockResolvedValue({ key: 'X-GROUP', statusCategoryKey: 'indeterminate' }),
      create: jest.fn(),
      comment: jest.fn()
    };
    const repo = makeRepo([{ ...baseRow, jiraIssueKey: 'X-GROUP' }]);
    const w = new JiraWorker({ settings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(jira.searchByLabel).not.toHaveBeenCalled();
    expect(jira.getIssue).toHaveBeenCalledWith('X-GROUP');
    expect(jira.comment).toHaveBeenCalledWith('X-GROUP', expect.any(String));
    expect(jira.create).not.toHaveBeenCalled();
  });

  test('closed existing ticket → create new with back-reference', async () => {
    const jira: IJiraClient = {
      searchByLabel: jest.fn().mockResolvedValue({ key: 'X-CLOSED', statusCategoryKey: 'done' }),
      getIssue: jest.fn(),
      create: jest.fn().mockResolvedValue('X-2'),
      comment: jest.fn()
    };
    const repo = makeRepo([baseRow]);
    const w = new JiraWorker({ settings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(jira.comment).not.toHaveBeenCalled();
    expect(jira.create).toHaveBeenCalledTimes(1);
    const arg = (jira.create as jest.Mock).mock.calls[0][0];
    expect(arg.description).toContain('X-CLOSED');
    expect(repo.updateJira).toHaveBeenCalledWith('1', expect.objectContaining({ jiraStatus: 'created', jiraIssueKey: 'X-2' }));
  });

  test('skips when JIRA_MODE is manual (default)', async () => {
    const jira: IJiraClient = {
      searchByLabel: jest.fn(),
      getIssue: jest.fn(),
      create: jest.fn(),
      comment: jest.fn()
    };
    const repo = makeRepo([baseRow]);
    const localSettings: ISettings = {
      ...settings,
      get: jest.fn(async (k: string) => k === 'JIRA_MODE' ? undefined : (settings.get as any)(k))
    };
    const w = new JiraWorker({ settings: localSettings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(repo.findPendingJira).not.toHaveBeenCalled();
    expect(jira.create).not.toHaveBeenCalled();
    expect(jira.comment).not.toHaveBeenCalled();
  });

  test('runs when JIRA_MODE is auto', async () => {
    const jira: IJiraClient = {
      searchByLabel: jest.fn().mockResolvedValue(undefined),
      getIssue: jest.fn(),
      create: jest.fn().mockResolvedValue('X-1'),
      comment: jest.fn()
    };
    const localSettings: ISettings = {
      ...settings,
      get: jest.fn(async (k: string) => k === 'JIRA_MODE' ? 'auto' : (settings.get as any)(k))
    };
    const repo = makeRepo([baseRow]);
    const w = new JiraWorker({ settings: localSettings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(jira.create).toHaveBeenCalledTimes(1);
  });
});

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

  test('happy path: creates a Jira ticket', async () => {
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
    expect(arg.labels).toContain('E19.100:D-1');
  });

  test('comments on existing open recurring issue', async () => {
    const jira: IJiraClient = {
      searchByLabel: jest.fn().mockResolvedValue(undefined),
      getIssue: jest.fn().mockResolvedValue({ key: 'X-EXISTING', statusCategoryKey: 'indeterminate' }),
      create: jest.fn(),
      comment: jest.fn()
    };
    const repo = makeRepo([baseRow]);
    (repo.findRecentByJira as jest.Mock).mockResolvedValue({ ID: 'old', jiraIssueKey: 'X-EXISTING' });
    const w = new JiraWorker({ settings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(jira.comment).toHaveBeenCalledWith('X-EXISTING', expect.any(String));
    expect(jira.create).not.toHaveBeenCalled();
  });

  test('skips when label search finds existing issue', async () => {
    const jira: IJiraClient = {
      searchByLabel: jest.fn().mockResolvedValueOnce({ key: 'X-DUP', statusCategoryKey: 'done' }),
      getIssue: jest.fn(),
      create: jest.fn(),
      comment: jest.fn()
    };
    const repo = makeRepo([baseRow]);
    const w = new JiraWorker({ settings, jira, repo, log: () => {} });
    await w.tickOnce();
    expect(jira.create).not.toHaveBeenCalled();
    expect(repo.updateJira).toHaveBeenCalledWith('1', expect.objectContaining({ jiraStatus: 'skipped', jiraIssueKey: 'X-DUP' }));
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

import { Discoverer, type DumpRepository } from '../../srv/discoverer';
import type { ISettings, IDumpSource, ParsedDump } from '../../srv/interfaces';

const settings: ISettings = {
  get: jest.fn(async () => undefined),
  getInt: jest.fn(async () => 0),
  getBool: jest.fn(async () => false),
  getCsv: jest.fn(async (k: string) => k === 'DUMP_SIGNATURE_FIELDS' ? ['system','runtimeError','program','include'] : []),
  invalidate: jest.fn()
};

const parsed: ParsedDump = {
  header: { system: 'E19.100', dumpId: 'D-1', runtimeError: 'RE', program: 'ZP', include: 'ZI', sourceLine: 1, occurredAt: '2026-04-29T00:00:00Z' },
  rawPayload: 'raw',
  callStack: [],
  referencedObjects: [],
  variables: []
};

const dumpSource: IDumpSource = {
  listSince: jest.fn().mockResolvedValue([{ system: 'E19.100', dumpId: 'D-1', occurredAt: '2026-04-29T00:00:00Z' }]),
  fetch: jest.fn().mockResolvedValue('raw')
};

function makeRepo(): DumpRepository {
  const dumps: any[] = [];
  return {
    listSystems: jest.fn(async () => ['E19.100']),
    maxOccurredAt: jest.fn(async () => undefined),
    findByDumpId: jest.fn(async (sys, id) => dumps.find(d => d.system === sys && d.dumpId === id)),
    insertParsed: jest.fn(async (p, parsed, signature) => {
      const row = { ID: String(dumps.length + 1), ...p, ...parsed.header, signature, analysisStatus: 'pending', jiraStatus: 'pending', analysisAttempts: 0, jiraAttempts: 0, skipJira: false };
      dumps.push(row);
      return row.ID;
    }),
    findPendingAnalysis: jest.fn(async () => []),
    updateAnalysis: jest.fn(),
    findPendingJira: jest.fn(async () => []),
    updateJira: jest.fn(),
    findJiraState: jest.fn(async () => ({ jiraStatus: 'pending', skipJira: false })),
    countSignatureWithin: jest.fn(async () => 1),
    findRecentByJira: jest.fn(async () => undefined),
    listAssigneeRules: jest.fn(async () => []),
    parsePayload: jest.fn((sys, id, raw) => ({ ...parsed, header: { ...parsed.header, system: sys, dumpId: id }, rawPayload: raw }))
  };
}

describe('Discoverer.tickOnce', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('discovers and inserts a new dump', async () => {
    const repo = makeRepo();
    const d = new Discoverer({ settings, dumpSource, repo, log: () => {} });
    await d.tickOnce();
    expect(repo.insertParsed).toHaveBeenCalledTimes(1);
    const call = (repo.insertParsed as jest.Mock).mock.calls[0];
    expect(call[2]).toBe('E19.100|RE|ZP|ZI'); // signature
  });

  test('skips already-known dump', async () => {
    const repo = makeRepo();
    (repo.findByDumpId as jest.Mock).mockResolvedValue({ ID: 'existing' });
    const d = new Discoverer({ settings, dumpSource, repo, log: () => {} });
    await d.tickOnce();
    expect(repo.insertParsed).not.toHaveBeenCalled();
  });
});

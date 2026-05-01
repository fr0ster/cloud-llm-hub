import { AnalysisWorker } from '../../srv/analysis-worker';
import type { DumpRepository } from '../../srv/discoverer';
import type { ISettings, IAnalyzer, ParsedDump } from '../../srv/interfaces';

const settings: ISettings = {
  get: jest.fn(async () => undefined),
  getInt: jest.fn(async (k: string) => ({ ANALYSIS_MAX_ATTEMPTS: 3, ANALYSIS_CONCURRENCY: 5 } as Record<string, number>)[k] ?? 0),
  getBool: jest.fn(async () => false),
  getCsv: jest.fn(async () => []),
  invalidate: jest.fn()
};

const parsed: ParsedDump = {
  header: { system: 'E19.100', dumpId: 'D-1' },
  rawPayload: 'raw',
  callStack: [],
  referencedObjects: [],
  variables: []
};

function makeRepo(pending: any[]): DumpRepository {
  return {
    listSystems: jest.fn(async () => []),
    maxOccurredAt: jest.fn(async () => undefined),
    findByDumpId: jest.fn(async () => undefined),
    insertParsed: jest.fn(),
    findPendingAnalysis: jest.fn(async () => pending),
    updateAnalysis: jest.fn(),
    findPendingJira: jest.fn(async () => []),
    updateJira: jest.fn(),
    findJiraState: jest.fn(async () => ({ jiraStatus: 'pending', skipJira: false })),
    countSignatureWithin: jest.fn(async () => 0),
    findRecentByJira: jest.fn(async () => undefined),
    listAssigneeRules: jest.fn(async () => []),
    parsePayload: jest.fn((sys, id, raw) => ({ ...parsed, header: { ...parsed.header, system: sys, dumpId: id }, rawPayload: raw }))
  };
}

describe('AnalysisWorker.tickOnce', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('successful analysis updates status to done with no intermediate analyzing write', async () => {
    const analyzer: IAnalyzer = { analyze: jest.fn().mockResolvedValue({ raw: '{}', recommendations: 'do X' }) };
    const repo = makeRepo([{ ID: '1', rawPayload: 'r', system: 'E19.100', dumpId: 'D-1', analysisAttempts: 0 }]);
    const w = new AnalysisWorker({ settings, analyzer, repo, log: () => {} });
    await w.tickOnce();
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(repo.updateAnalysis).toHaveBeenCalledTimes(1);
    const [id, patch] = (repo.updateAnalysis as jest.Mock).mock.calls[0];
    expect(id).toBe('1');
    expect(patch).toMatchObject({ analysisStatus: 'done', recommendations: 'do X' });
  });

  test('failed analysis sets failed + increments attempts', async () => {
    const analyzer: IAnalyzer = { analyze: jest.fn().mockRejectedValue(new Error('boom')) };
    const repo = makeRepo([{ ID: '1', rawPayload: 'r', system: 'E19.100', dumpId: 'D-1', analysisAttempts: 1 }]);
    const w = new AnalysisWorker({ settings, analyzer, repo, log: () => {} });
    await w.tickOnce();
    const [, patch] = (repo.updateAnalysis as jest.Mock).mock.calls[0];
    expect(patch).toMatchObject({ analysisStatus: 'failed', analysisAttempts: 2 });
    expect(String(patch.analysisError)).toContain('boom');
  });

  test('runs up to ANALYSIS_CONCURRENCY rows in parallel', async () => {
    const inflight: number[] = [];
    let max = 0;
    const analyzer: IAnalyzer = {
      analyze: jest.fn(async () => {
        inflight.push(1);
        max = Math.max(max, inflight.length);
        await new Promise(r => setTimeout(r, 10));
        inflight.pop();
        return { raw: '{}', recommendations: 'x' };
      })
    };
    const rows = Array.from({ length: 7 }, (_, i) => ({ ID: String(i), rawPayload: 'r', system: 'E19.100', dumpId: `D-${i}`, analysisAttempts: 0 }));
    const repo = makeRepo(rows);
    const w = new AnalysisWorker({ settings, analyzer, repo, log: () => {} });
    await w.tickOnce();
    expect(analyzer.analyze).toHaveBeenCalledTimes(5); // capped to ANALYSIS_CONCURRENCY=5
    expect(max).toBeGreaterThan(1); // actually concurrent
  });
});

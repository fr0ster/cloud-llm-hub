import type { DumpRepository } from './discoverer';
import type { IAnalyzer, ISettings } from './interfaces';

export interface AnalysisWorkerDeps {
  settings: ISettings;
  analyzer: IAnalyzer;
  repo: DumpRepository;
  log: (msg: string, err?: unknown) => void;
}

export class AnalysisWorker {
  private running = false;
  constructor(private deps: AnalysisWorkerDeps) {}

  async tickOnce(): Promise<void> {
    if (this.running) {
      this.deps.log('analysis-worker: previous tick still running, skip');
      return;
    }
    this.running = true;
    try {
      const cap = await this.deps.settings.getInt('ANALYSIS_MAX_ATTEMPTS', 3);
      const concurrency = await this.deps.settings.getInt(
        'ANALYSIS_CONCURRENCY',
        5,
      );
      const rows = await this.deps.repo.findPendingAnalysis(cap);
      if (rows.length === 0) return;
      const slice = rows.slice(0, concurrency);
      await Promise.all(slice.map((row) => this.processOne(row)));
    } finally {
      this.running = false;
    }
  }

  async processOne(row: {
    ID: string;
    rawPayload: string;
    system: string;
    dumpId: string;
    analysisAttempts: number;
  }): Promise<void> {
    console.log(`[analyzer] processOne start ${row.system}/${row.dumpId}`);
    await this.deps.repo.updateAnalysis(row.ID, {
      analysisStatus: 'analyzing',
    });
    try {
      const parsed = this.deps.repo.parsePayload(
        row.system,
        row.dumpId,
        row.rawPayload,
      );
      const r = await this.deps.analyzer.analyze(parsed);
      await this.deps.repo.updateAnalysis(row.ID, {
        analysisStatus: 'done',
        analysisResult: r.raw,
        recommendations: r.recommendations,
        analysisError: null,
      });
      console.log(
        `[analyzer] processOne done ${row.dumpId} (${(r.recommendations ?? '').length} chars)`,
      );
    } catch (e: any) {
      console.error(
        `[analyzer] processOne failed ${row.dumpId}:`,
        e?.message ?? e,
      );
      await this.deps.repo.updateAnalysis(row.ID, {
        analysisStatus: 'failed',
        analysisError: String(e?.message ?? e),
        analysisAttempts: row.analysisAttempts + 1,
      });
    }
  }
}

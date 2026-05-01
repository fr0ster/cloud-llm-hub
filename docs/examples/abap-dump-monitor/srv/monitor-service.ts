// @ts-ignore - @sap/cds has no type definitions
import cds from '@sap/cds';
import { SettingsService } from './settings-service';
import { seedSettings } from './bootstrap';
import { DumpSource } from './dump-source';
import { Analyzer } from './analyzer';
import { JiraClient, defaultJiraHttpFn } from './jira-client';
import { Discoverer, type DumpRepository } from './discoverer';
import { AnalysisWorker } from './analysis-worker';
import { JiraWorker } from './jira-worker';
import { parseDump } from './dump-parser';
import type { DumpListItem, ParsedDump } from './interfaces';
import express from 'express';
import { join } from 'node:path';

declare const SELECT: any;
declare const INSERT: any;
declare const UPDATE: any;

const log = cds.log('abap-dump-monitor');

// Serve the Fiori Elements app (copied to gen/srv/app/monitor/webapp at build time
// by the cpSync step in mta.yaml). At runtime __dirname is gen/srv/srv, so the
// webapp folder is one level up under app/monitor/webapp.
cds.on('bootstrap', (app: express.Express) => {
  const webappPath = join(__dirname, '..', 'app', 'monitor', 'webapp');
  // Serve the Fiori Elements app (copied to gen/srv/app/monitor/webapp at build time
  // by the cpSync step in mta.yaml). At runtime __dirname is gen/srv/srv, so the
  // webapp folder is one level up under app/monitor/webapp.
  //
  // NOTE: Static assets served here bypass CAP's OData-level auth. The OData
  // endpoints themselves require 'Viewer' role (see monitor-service.cds), which
  // is the primary protection. For production deployments where static asset
  // protection is required, mount the app under the OData path or use a separate
  // auth gate (e.g., reverse proxy, app router).
  app.use('/monitor/webapp', express.static(webappPath));
  log.info(`Fiori UI served from ${webappPath} at /monitor/webapp`);
});

class CdsDumpRepository implements DumpRepository {
  constructor(private systemId: string) {}

  parsePayload(system: string, dumpId: string, raw: string): ParsedDump {
    return parseDump(system, dumpId, raw);
  }
  async listSystems(): Promise<string[]> {
    return this.systemId ? [this.systemId] : [];
  }
  async maxOccurredAt(system: string): Promise<string | undefined> {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    const r = await SELECT.one`max(occurredAt) as m`.from(MonitoredDump).where({ system });
    return r?.m;
  }
  async findByDumpId(system: string, dumpId: string) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.one.from(MonitoredDump).where({ system, dumpId });
  }
  async insertParsed(item: DumpListItem, parsed: ParsedDump, signature: string): Promise<string> {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    const ID = cds.utils.uuid();
    await INSERT.into(MonitoredDump).entries({
      ID,
      system: item.system, dumpId: item.dumpId,
      runtimeError: parsed.header.runtimeError,
      exceptionClass: parsed.header.exceptionClass,
      category: item.category,
      host: parsed.header.host, instance: parsed.header.instance,
      program: parsed.header.program, include: parsed.header.include,
      mainProgram: parsed.header.mainProgram,
      sourceLine: parsed.header.sourceLine,
      event: parsed.header.event, transactionId: parsed.header.transactionId,
      abapUser: parsed.header.abapUser, client: parsed.header.client,
      occurredAt: parsed.header.occurredAt ?? item.occurredAt,
      firstSeenAt: new Date().toISOString(),
      shortText: parsed.header.shortText,
      signature,
      rawPayload: parsed.rawPayload,
      analysisStatus: 'pending',
      analysisAttempts: 0,
      jiraStatus: 'pending',
      jiraAttempts: 0,
      skipJira: false,
      callStack: parsed.callStack.map(f => ({ ...f, ID: cds.utils.uuid() })),
      referencedObjects: parsed.referencedObjects.map(o => ({ ...o, ID: cds.utils.uuid() })),
      variables: parsed.variables.map(v => ({ ...v, ID: cds.utils.uuid() })),
      sourceExtract: parsed.sourceExtract ? { ...parsed.sourceExtract, ID: cds.utils.uuid() } : undefined
    });
    return ID;
  }
  async findPendingAnalysis(maxAttempts: number) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.from(MonitoredDump).columns('ID', 'rawPayload', 'system', 'dumpId', 'analysisAttempts')
      .where(`analysisStatus in ('pending','failed') and analysisAttempts < ${maxAttempts}`);
  }
  async updateAnalysis(id: string, patch: Record<string, unknown>) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    await UPDATE(MonitoredDump).set(patch).where({ ID: id });
  }
  async findPendingJira(maxAttempts: number) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.from(MonitoredDump)
      .columns('ID','system','dumpId','signature','runtimeError','program','category','recommendations','jiraAttempts','shortText','include','sourceLine','occurredAt','abapUser')
      .where(`analysisStatus = 'done' and jiraStatus in ('pending','failed') and skipJira = false and jiraAttempts < ${maxAttempts}`);
  }
  async updateJira(id: string, patch: Record<string, unknown>) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    await UPDATE(MonitoredDump).set(patch).where({ ID: id });
  }
  async findJiraState(id: string) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.one.from(MonitoredDump).columns('jiraStatus', 'jiraIssueKey', 'skipJira').where({ ID: id });
  }
  async countSignatureWithin(signature: string, sinceIso: string): Promise<number> {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    const r = await SELECT.one`count(*) as c`.from(MonitoredDump).where({ signature, firstSeenAt: { '>=': sinceIso } });
    return Number(r?.c ?? 0);
  }
  async findRecentByJira(signature: string, sinceIso: string) {
    const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
    return SELECT.one.from(MonitoredDump).columns('ID', 'jiraIssueKey')
      .where({ signature, firstSeenAt: { '>=': sinceIso }, jiraIssueKey: { '!=': null } })
      .orderBy('firstSeenAt desc');
  }
  async listAssigneeRules() {
    const { AssigneeRule } = cds.entities('example.abapdumpmonitor');
    return SELECT.from(AssigneeRule).where({ active: true });
  }
}

const timers = new Map<string, NodeJS.Timeout>();

function startLoop(name: string, tick: () => Promise<void>, settingKey: string, settings: SettingsService, defaultMs: number, minMs: number) {
  const run = async () => {
    try { await tick(); } catch (e) { log.error(`${name} tick error`, e); }
    finally {
      let ms = defaultMs;
      try {
        ms = Math.max(minMs, await settings.getInt(settingKey, defaultMs));
      } catch (e) {
        log.warn(`${name}: invalid ${settingKey} setting, falling back to ${defaultMs}ms`, e);
      }
      timers.set(name, setTimeout(run, ms));
    }
  };
  timers.set(name, setTimeout(run, 5_000));
}

export default cds.service.impl(async function (this: any) {
  const { Setting } = cds.entities('example.abapdumpmonitor');
  const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
  const db = await cds.connect.to('db');

  await seedSettings();

  const settings = new SettingsService({
    runOne: async (key: string) => {
      const r = await db.run(SELECT.one.from(Setting).where({ key }));
      return r ? { value: r.value, dataType: r.dataType } : undefined;
    }
  });

  this.after('UPDATE', Setting, (_: any, req: any) => {
    const key = (req.data as any).key ?? (req.params?.[0] as any)?.key;
    if (key) settings.invalidate(String(key));
  });

  const sapDest = process.env.SAP_DESTINATION ?? '';
  const systemId = process.env.SAP_SYSTEM_ID ?? sapDest;
  const hubDest = process.env.CLOUD_LLM_HUB_DESTINATION ?? 'CLOUD_LLM_HUB';
  const jiraDest = process.env.JIRA_DESTINATION ?? 'JIRA_EPAM';

  const dumpSource = new DumpSource(hubDest, sapDest);
  const analyzer = new Analyzer(hubDest, sapDest, settings);
  const jira = new JiraClient(jiraDest, defaultJiraHttpFn);
  const repo = new CdsDumpRepository(systemId);

  const logFn = (m: string, e?: unknown) => e ? log.error(m, e) : log.info(m);
  const discoverer = new Discoverer({ settings, dumpSource, repo, log: logFn });
  const analysisWorker = new AnalysisWorker({ settings, analyzer, repo, log: logFn });
  const jiraWorker = new JiraWorker({ settings, jira, repo, log: logFn });

  this.on('pollNow', async () => {
    await discoverer.tickOnce();
    return 'ok';
  });

  this.on('pushToJira', 'MonitoredDump', async (req: any) => {
    const { ID } = req.params[0] as { ID: string };
    const row = await SELECT.one.from(MonitoredDump)
      .columns('ID','system','dumpId','signature','runtimeError','program','category','recommendations','jiraAttempts','jiraStatus','analysisStatus','skipJira','shortText','include','sourceLine','occurredAt','abapUser')
      .where({ ID });
    if (!row) { req.error(404, `MonitoredDump ${ID} not found`); return; }
    if (row.analysisStatus !== 'done') { req.error(400, `pushToJira requires analysisStatus = 'done' (current: ${row.analysisStatus})`); return; }
    if (row.skipJira) { req.error(400, `MonitoredDump ${ID} has skipJira=true`); return; }
    if (row.jiraStatus !== 'pending' && row.jiraStatus !== 'failed') {
      req.error(400, `pushToJira not valid in jiraStatus=${row.jiraStatus}`);
      return;
    }

    await jiraWorker.processOne(row, await jiraWorker.buildCtx());

    const after = await SELECT.one.from(MonitoredDump).columns('jiraStatus','jiraIssueKey','jiraError').where({ ID });
    if (!after) { req.error(500, 'row vanished after processOne'); return; }
    if (after.jiraStatus === 'created' || after.jiraStatus === 'commented' || after.jiraStatus === 'skipped') {
      return after.jiraIssueKey ?? after.jiraStatus;
    }
    req.error(502, `Jira step failed: ${after.jiraError ?? 'unknown error'}`);
  });

  this.after('READ', MonitoredDump, (rows: any) => {
    if (!rows) return;
    const arr = Array.isArray(rows) ? rows : [rows];
    const aMap: Record<string, number> = { done: 3, pending: 2, analyzing: 2, failed: 1 };
    const jMap: Record<string, number> = { created: 3, commented: 3, skipped: 3, pending: 2, failed: 1 };
    for (const r of arr) {
      if (r && typeof r === 'object') {
        if ('analysisStatus' in r) r.analysisStatusCriticality = aMap[r.analysisStatus] ?? 0;
        if ('jiraStatus'     in r) r.jiraStatusCriticality     = jMap[r.jiraStatus]     ?? 0;
      }
    }
  });

  this.on('retryAnalysis', 'MonitoredDump', async (req: any) => {
    const { ID } = req.params[0] as { ID: string };
    const row = await SELECT.one.from(MonitoredDump).columns('ID', 'analysisStatus').where({ ID });
    if (!row) { req.error(404, `MonitoredDump ${ID} not found`); return; }
    if (row.analysisStatus !== 'failed') {
      req.error(400, `retryAnalysis only valid for failed rows (current status: ${row.analysisStatus})`);
      return;
    }
    await UPDATE(MonitoredDump).set({ analysisStatus: 'pending', analysisError: null, analysisAttempts: 0 }).where({ ID });
    return 'ok';
  });

  this.on('retryJira', 'MonitoredDump', async (req: any) => {
    const { ID } = req.params[0] as { ID: string };
    const row = await SELECT.one.from(MonitoredDump).columns('ID', 'jiraStatus').where({ ID });
    if (!row) { req.error(404, `MonitoredDump ${ID} not found`); return; }
    if (row.jiraStatus !== 'failed') {
      req.error(400, `retryJira only valid for failed rows (current status: ${row.jiraStatus})`);
      return;
    }
    await UPDATE(MonitoredDump).set({ jiraStatus: 'pending', jiraError: null, jiraAttempts: 0 }).where({ ID });
    return 'ok';
  });

  if (sapDest) {
    startLoop('discoverer',     () => discoverer.tickOnce(),     'POLL_INTERVAL_MS', settings, 300_000, 60_000);
    startLoop('analysis-worker', () => analysisWorker.tickOnce(), 'ANALYSIS_TICK_MS', settings, 10_000, 1_000);
    startLoop('jira-worker',     () => jiraWorker.tickOnce(),     'JIRA_TICK_MS',     settings, 10_000, 1_000);
  } else {
    log.warn('SAP_DESTINATION not set — polling disabled');
  }
});

cds.on('shutdown', () => {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
});

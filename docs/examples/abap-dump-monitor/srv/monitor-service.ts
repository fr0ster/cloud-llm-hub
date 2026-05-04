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

// Minimal markdown → HTML for sap.m.FormattedText (whitelisted tags only:
// p, ul, ol, li, strong, em, code, pre, h2, h3, h4, br, a). Handles the LLM output
// shape we expect: ## headings, numbered/bulleted lists, **bold**, `code`, code blocks.
function mdToHtml(md: string | null | undefined): string | null {
  if (!md) return null;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeBuf: string[] = [];
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*[^*\s]|[^*\s])\*(?=[\s),.!?;:]|$)/g, '$1<em>$2</em>');
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) {
      if (!inCode) { closeList(); inCode = true; codeBuf = []; }
      else { out.push(`<pre>${esc(codeBuf.join('\n'))}</pre>`); inCode = false; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (heading) { closeList(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre>${esc(codeBuf.join('\n'))}</pre>`);
  return out.join('\n');
}

// Convert ADT 14-digit timestamps (YYYYMMDDHHmmss) or any other input into ISO string.
// Returns null when input is missing/unparseable so SQLite stores NULL instead of crashing.
function toIso(input: unknown): string | null {
  if (input == null || input === '') return null;
  const s = String(input).trim();
  // ADT 14-digit format: 20260501031239
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Serve the Fiori Elements app (copied to gen/srv/app/monitor/webapp at build time
// by the cpSync step in mta.yaml). At runtime __dirname is gen/srv/srv, so the
// webapp folder is one level up under app/monitor/webapp.
(cds as unknown as { on(e: 'bootstrap', cb: (app: express.Express) => void): void }).on('bootstrap', (app: express.Express) => {
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
      occurredAt: toIso(parsed.header.occurredAt ?? item.occurredAt),
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
    // Pick pending/failed rows + any 'analyzing' row whose modifiedAt is older
    // than ANALYSIS_STUCK_MS (default 10min) — that means the worker process
    // died mid-call and the row would otherwise be stranded.
    const stuckMs = Number.parseInt(process.env.ANALYSIS_STUCK_MS ?? '600000', 10);
    const stuckCutoff = new Date(Date.now() - stuckMs).toISOString();
    return SELECT.from(MonitoredDump).columns('ID', 'rawPayload', 'system', 'dumpId', 'analysisAttempts')
      .where(
        `analysisAttempts < ${maxAttempts} and (` +
        `analysisStatus in ('pending','failed') ` +
        `or (analysisStatus = 'analyzing' and modifiedAt < '${stuckCutoff}')` +
        `)`
      );
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
  console.log('[monitor-service] impl: start');
  const { Setting } = cds.entities('example.abapdumpmonitor');
  const { MonitoredDump } = cds.entities('example.abapdumpmonitor');
  const db = await cds.connect.to('db');
  const dbUrl = (db as any).options?.credentials?.url ?? '';
  console.log('[monitor-service] impl: db connected', dbUrl);

  if (dbUrl && dbUrl !== ':memory:') {
    const fs = require('node:fs');
    const path = require('node:path');
    fs.mkdirSync(path.dirname(dbUrl), { recursive: true });
    console.log('[monitor-service] impl: ensuring schema in', dbUrl);
    try {
      const path = require('node:path');
      const sqlPath = path.join(__dirname, 'schema.sql');
      if (fs.existsSync(sqlPath)) {
        const ddl = fs.readFileSync(sqlPath, 'utf8');
        // Use the underlying better-sqlite3 connection: CAP service .run() expects CQN, not SQL.
        const Database = require('better-sqlite3');
        const native = new Database(dbUrl);
        try {
          native.exec(ddl);
          console.log('[monitor-service] impl: schema ensured via native driver');
        } finally {
          native.close();
        }
      } else {
        console.warn('[monitor-service] impl: schema.sql not found at', sqlPath);
      }
    } catch (e: any) {
      // Tables may already exist — that's fine.
      if (!String(e?.message ?? '').includes('already exists')) {
        console.error('[monitor-service] impl: schema ensure failed', e);
        throw e;
      }
      console.log('[monitor-service] impl: schema already exists');
    }
  }

  try {
    await seedSettings();
    console.log('[monitor-service] impl: seedSettings done');
  } catch (e) {
    console.error('[monitor-service] impl: seedSettings failed', e);
    throw e;
  }

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

  // Resolve Jira base URL from the destination on demand. Env JIRA_URL is the
  // legacy fallback for local/dev runs where destinations service isn't bound.
  const { getDestination } = await import('@sap-cloud-sdk/connectivity');
  let jiraBaseCache: string | undefined;
  const resolveJiraBase = async (): Promise<string> => {
    if (jiraBaseCache !== undefined) return jiraBaseCache;
    try {
      const d = await getDestination({ destinationName: jiraDest });
      jiraBaseCache = (d?.url ?? process.env.JIRA_URL ?? '').replace(/\/+$/, '');
    } catch {
      jiraBaseCache = (process.env.JIRA_URL ?? '').replace(/\/+$/, '');
    }
    return jiraBaseCache;
  };
  // Enrich a SELECT result returned from an action (which reads via the schema
  // entity, bypassing this.after('READ', ...)) with the same virtual fields the
  // service-projection after-handler computes — so Fiori sees identical shape
  // whether it gets the entity from action return value or from a normal READ.
  const enrichRow = async (r: any): Promise<any> => {
    if (!r) return r;
    if (r.recommendations && !r.recommendationsHtml) r.recommendationsHtml = mdToHtml(r.recommendations);
    if (r.jiraIssueKey && !r.jiraIssueUrl) {
      const base = await resolveJiraBase();
      if (base) r.jiraIssueUrl = `${base}/browse/${r.jiraIssueKey}`;
    }
    return r;
  };

  this.on('pushToJira', 'MonitoredDump', async (req: any) => {
    const { ID } = req.params[0] as { ID: string };
    const row = await SELECT.one.from(MonitoredDump)
      .columns('ID','system','dumpId','signature','runtimeError','program','category','recommendations','jiraAttempts','jiraStatus','analysisStatus','skipJira','shortText','include','sourceLine','occurredAt','abapUser')
      .where({ ID });
    if (!row) { req.error(404, `MonitoredDump ${ID} not found`); return; }
    if (row.analysisStatus !== 'done') { req.error(400, `pushToJira requires analysisStatus = 'done' (current: ${row.analysisStatus})`); return; }
    if (row.skipJira) { req.error(400, `MonitoredDump ${ID} has skipJira=true`); return; }
    // No jiraStatus guard — single foreground action covers both first push and
    // replay; jiraWorker.processOne handles "comment on existing issue" itself.

    await jiraWorker.processOne(row, await jiraWorker.buildCtx());

    const after = await SELECT.one.from(MonitoredDump).where({ ID });
    if (!after) { req.error(500, 'row vanished after processOne'); return; }
    if (after.jiraStatus === 'created' || after.jiraStatus === 'commented' || after.jiraStatus === 'skipped') {
      return await enrichRow(after);
    }
    req.error(502, `Jira step failed: ${after.jiraError ?? 'unknown error'}`);
  });

  this.after('READ', 'MonitoredDump', async (rows: any) => {
    if (!rows) return;
    const arr = Array.isArray(rows) ? rows : [rows];
    const aMap: Record<string, number> = { done: 3, pending: 2, analyzing: 2, failed: 1 };
    const jMap: Record<string, number> = { created: 3, commented: 3, skipped: 3, pending: 2, failed: 1 };

    // recommendations is a LargeString — Fiori doesn't $select it by default since
    // it's not in any LineItem/FieldGroup. Load it per row when missing so the
    // custom Analysis fragment can render markdown via recommendationsHtml.
    for (const r of arr) {
      if (!r || typeof r !== 'object') continue;
      if ('analysisStatus' in r) r.analysisStatusCriticality = aMap[r.analysisStatus] ?? 0;
      if ('jiraStatus'     in r) r.jiraStatusCriticality     = jMap[r.jiraStatus]     ?? 0;

      let recText: string | null | undefined;
      if ('recommendations' in r) recText = r.recommendations;
      else if (r.ID) {
        const fetched = await SELECT.one.from(MonitoredDump).columns('recommendations').where({ ID: r.ID });
        recText = fetched?.recommendations ?? null;
      }
      r.recommendationsHtml = mdToHtml(recText ?? null);
      console.log(`[after-READ] ID=${r.ID} recLen=${(recText ?? '').length} htmlLen=${(r.recommendationsHtml ?? '').length}`);
      const hasKey = 'jiraIssueKey' in r;
      console.log(`[after-READ-jiradiag] ID=${r.ID} hasKey=${hasKey} keyVal=${JSON.stringify(r.jiraIssueKey)} hasUrl=${'jiraIssueUrl' in r}`);
      if (hasKey && r.jiraIssueKey) {
        const base = await resolveJiraBase();
        r.jiraIssueUrl = base ? `${base}/browse/${r.jiraIssueKey}` : null;
        console.log(`[after-READ] jira ID=${r.ID} key=${r.jiraIssueKey} base=${base} url=${r.jiraIssueUrl}`);
      } else if ('jiraIssueUrl' in r) {
        r.jiraIssueUrl = null;
      }
    }
  });

  // retryAnalysis = synchronous priority analysis. Approuter destination timeout
  // raised to 180s in mta.yaml, so we can run the LLM inline and return the
  // refreshed MonitoredDump entity. Fiori SideEffects then refetches and the
  // Object Page shows the new analysisStatus / recommendations / Html.
  this.on('retryAnalysis', 'MonitoredDump', async (req: any) => {
    const { ID } = req.params[0] as { ID: string };
    const row = await SELECT.one.from(MonitoredDump)
      .columns('ID','system','dumpId','rawPayload','analysisStatus','analysisAttempts')
      .where({ ID });
    if (!row) { req.error(404, `MonitoredDump ${ID} not found`); return; }
    // Allow recovery from 'analyzing' (process crashed mid-call) — processOne
    // will overwrite the status as it progresses. Reject only 'done' / 'pending'
    // (nothing to retry there).
    if (row.analysisStatus === 'done' || row.analysisStatus === 'pending') {
      req.error(400, `Cannot retry — analysisStatus=${row.analysisStatus}`);
      return;
    }

    await analysisWorker.processOne(row);

    const after = await SELECT.one.from(MonitoredDump).where({ ID });
    if (!after) { req.error(500, 'row vanished after analyze'); return; }
    if (after.analysisStatus !== 'done') {
      req.error(502, `Analysis failed: ${after.analysisError ?? 'unknown'}`);
      return;
    }
    return await enrichRow(after);
  });

  console.log('[monitor-service] impl: sapDest=', sapDest, 'systemId=', systemId, 'hubDest=', hubDest, 'jiraDest=', jiraDest);
  if (sapDest) {
    console.log('[monitor-service] impl: starting workers');
    startLoop('discoverer',     () => discoverer.tickOnce(),     'POLL_INTERVAL_MS', settings, 300_000, 60_000);
    startLoop('analysis-worker', () => analysisWorker.tickOnce(), 'ANALYSIS_TICK_MS', settings, 10_000, 1_000);
    startLoop('jira-worker',     () => jiraWorker.tickOnce(),     'JIRA_TICK_MS',     settings, 10_000, 1_000);
    console.log('[monitor-service] impl: workers started');
  } else {
    console.warn('[monitor-service] impl: SAP_DESTINATION not set — polling disabled');
  }
});

cds.on('shutdown', () => {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
});

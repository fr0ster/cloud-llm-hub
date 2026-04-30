# abap-dump-monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone CAP example service under `docs/examples/abap-dump-monitor/` that polls FIDS dumps via cloud-llm-hub MCP, persists them with structured detail, asks cloud-llm-hub to analyze each dump, and creates Jira tickets with recurrence-aware logic — all with hot-reloadable config in a `Setting` table.

**Architecture:** CAP (Node.js) + HANA Cloud + BTP destinations. Background `setTimeout`-recursive polling loop drives a state machine on `MonitoredDump` rows: `pending → analyzing → done → (jira-creating → created/commented)`. Config lives in DB (`Setting`), env vars are bootstrap defaults only. Each `srv/*.ts` module implements one focused interface and is unit-testable in isolation.

**Tech Stack:** `@sap/cds` ^9, `@sap-cloud-sdk/http-client` ^3, `@modelcontextprotocol/sdk` ^1.23.0, Jest, TypeScript, Biome.

**Reference spec:** `docs/superpowers/specs/2026-04-29-abap-dump-monitor-design.md`

---

## File Structure

```
docs/examples/abap-dump-monitor/
├── package.json                       — deps + Jest + scripts
├── tsconfig.json                      — strict TS, NodeNext
├── biome.json                         — extends repo root config
├── .gitignore                         — gen/, node_modules, .mtaext, mta_archives
├── .mtaext.example                    — template; copy to .mtaext, fill destinations + initial Setting seeds
├── mta.yaml                           — CF deployment descriptor + destination init_data
├── xs-security.json                   — Admin / Viewer role templates
├── README.md                          — overview + deploy
├── db/
│   └── schema.cds                     — MonitoredDump + compositions + Setting + AssigneeRule
├── srv/
│   ├── monitor-service.cds            — OData admin service projection
│   ├── monitor-service.ts             — handlers, pollNow/retry actions, poller startup
│   ├── settings-service.ts            — cached, hot-reloading config accessor (ISettings)
│   ├── bootstrap.ts                   — seed Setting from env on first boot
│   ├── dump-source.ts                 — IDumpSource: list + get via cloud-llm-hub MCP
│   ├── dump-parser.ts                 — raw payload → structured composition tree
│   ├── analyzer.ts                    — IAnalyzer: cloud-llm-hub /v1/chat/completions
│   ├── jira-client.ts                 — IJiraClient: search/create/comment/get-status
│   ├── jira-policy.ts                 — signature, frequency, due-date, assignee-rule match
│   ├── poller.ts                      — setTimeout-recursive loop, pollOnce orchestration
│   └── interfaces.ts                  — shared TS types + interface declarations
├── test/
│   ├── fixtures/
│   │   ├── dump-list.sample.json      — RuntimeListFeeds response
│   │   ├── dump-payload.sample.txt    — RuntimeGetDumpById raw payload
│   │   └── jira-issue.sample.json     — Jira REST issue response
│   └── unit/
│       ├── settings-service.test.ts
│       ├── dump-parser.test.ts
│       ├── jira-policy.test.ts
│       ├── jira-client.test.ts
│       └── poller.test.ts
└── docs/
    ├── OVERVIEW.md
    ├── DEPLOYMENT.md
    └── CONSUMER-GUIDE.md
```

Each `srv/*.ts` exports one class (or factory) implementing an interface declared in `interfaces.ts`. Poller takes interfaces by constructor injection, so unit tests stub them without touching CAP / Cloud SDK.

---

## Task 1: Scaffold project

**Files:**
- Create: `docs/examples/abap-dump-monitor/package.json`
- Create: `docs/examples/abap-dump-monitor/tsconfig.json`
- Create: `docs/examples/abap-dump-monitor/biome.json`
- Create: `docs/examples/abap-dump-monitor/.gitignore`

- [ ] **Step 1.1: Create `package.json`**

```json
{
  "name": "abap-dump-monitor",
  "version": "1.0.0",
  "description": "CAP example: scheduled-pull ABAP dump monitor via cloud-llm-hub + Jira",
  "main": "gen/srv/srv/server.js",
  "scripts": {
    "start": "cds-serve",
    "build": "cds build --production",
    "test": "jest",
    "test:watch": "jest --watch",
    "lint": "npx biome check --write .",
    "lint:check": "npx biome check ."
  },
  "dependencies": {
    "@sap/cds": "^9",
    "@sap-cloud-sdk/http-client": "^3",
    "@modelcontextprotocol/sdk": "^1.23.0",
    "express": "^4"
  },
  "devDependencies": {
    "@sap/cds-dk": "^9",
    "@types/jest": "^29",
    "@types/node": "^22",
    "jest": "^29",
    "ts-jest": "^29",
    "typescript": "^5"
  },
  "cds": {
    "requires": {
      "auth": {
        "[production]": { "kind": "xsuaa" },
        "[development]": {
          "kind": "mocked",
          "users": {
            "admin": { "roles": ["Admin", "Viewer"] },
            "viewer": { "roles": ["Viewer"] }
          }
        }
      },
      "db": {
        "[production]": { "kind": "hana-cloud" },
        "[development]": { "kind": "sqlite", "credentials": { "url": ":memory:" } }
      }
    }
  },
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node",
    "testMatch": ["**/test/unit/**/*.test.ts"],
    "moduleFileExtensions": ["ts", "js", "json"]
  }
}
```

- [ ] **Step 1.2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "gen/srv",
    "rootDir": ".",
    "declaration": false,
    "noEmit": false
  },
  "include": ["srv/**/*", "test/**/*"]
}
```

- [ ] **Step 1.3: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "extends": ["../../../biome.json"]
}
```

- [ ] **Step 1.4: Create `.gitignore`**

```
node_modules/
gen/
mta_archives/
.mtaext
*.log
```

- [ ] **Step 1.5: Install and verify**

```bash
cd docs/examples/abap-dump-monitor && npm install
```

Expected: install completes, `node_modules/` populated.

- [ ] **Step 1.6: Commit**

```bash
git add docs/examples/abap-dump-monitor/{package.json,tsconfig.json,biome.json,.gitignore}
git commit -m "feat(examples/abap-dump-monitor): scaffold project"
```

---

## Task 2: Data model

**Files:**
- Create: `docs/examples/abap-dump-monitor/db/schema.cds`

- [ ] **Step 2.1: Create schema**

```cds
namespace example.abapdumpmonitor;

using { managed, cuid } from '@sap/cds/common';

entity MonitoredDump : cuid, managed {
  system            : String(20)  not null;
  client            : String(3);
  dumpId            : String(40)  not null;
  runtimeError      : String(60);
  exceptionClass    : String(60);
  category          : String(40);
  host              : String(40);
  instance          : String(40);
  program           : String(40);
  include           : String(40);
  mainProgram       : String(40);
  sourceLine        : Integer;
  event             : String(40);
  transactionId     : String(40);
  abapUser          : String(12);
  occurredAt        : Timestamp;
  firstSeenAt       : Timestamp;
  shortText         : String(1000);
  signature         : String(200);
  rawPayload        : LargeString;
  analysisStatus    : String(20)  default 'pending';
  analysisResult    : LargeString;
  recommendations   : LargeString;
  analysisError     : String(2000);
  analysisAttempts  : Integer     default 0;
  jiraStatus        : String(20)  default 'pending';
  jiraIssueKey      : String(40);
  jiraError         : String(2000);
  jiraAttempts      : Integer     default 0;
  skipJira          : Boolean     default false;

  callStack         : Composition of many CallStackEntry on callStack.parent = $self;
  referencedObjects : Composition of many ReferencedObject on referencedObjects.parent = $self;
  variables         : Composition of many VariableSnapshot on variables.parent = $self;
  sourceExtract     : Composition of one SourceExtract on sourceExtract.parent = $self;
}

entity CallStackEntry : cuid {
  parent       : Association to MonitoredDump;
  position     : Integer;
  program      : String(40);
  include      : String(40);
  line         : Integer;
  eventType    : String(40);
  eventName    : String(60);
  objectClass  : String(20);
}

entity ReferencedObject : cuid {
  parent      : Association to MonitoredDump;
  objectName  : String(60);
  objectType  : String(20);
  subObject   : String(60);
  package     : String(40);
  source      : String(20);
}

entity VariableSnapshot : cuid {
  parent     : Association to MonitoredDump;
  scope      : String(20);
  name       : String(60);
  type       : String(40);
  value      : LargeString;
  truncated  : Boolean default false;
}

entity SourceExtract : cuid {
  parent    : Association to MonitoredDump;
  program   : String(40);
  include   : String(40);
  lineFrom  : Integer;
  lineTo    : Integer;
  code      : LargeString;
}

entity Setting {
  key          : String(60) not null;
  value        : String(2000);
  dataType     : String(10);
  description  : String(500);
  updatedAt    : Timestamp @cds.on.insert : $now @cds.on.update : $now;
  updatedBy    : String    @cds.on.insert : $user @cds.on.update : $user;
}

annotate Setting with @assert.unique : { key: [key] };
annotate MonitoredDump with @assert.unique : { dumpKey: [system, dumpId] };

entity AssigneeRule : cuid {
  priority             : Integer not null default 100;
  system               : String(20);
  runtimeErrorPattern  : String(120);
  programPattern       : String(60);
  categoryPattern      : String(60);
  assigneeName         : String(120);
  active               : Boolean default true;
  description          : String(500);
}
```

- [ ] **Step 2.2: Compile schema**

Run: `cd docs/examples/abap-dump-monitor && npx cds compile db/schema.cds`
Expected: no errors; compiled CDS printed.

- [ ] **Step 2.3: Commit**

```bash
git add docs/examples/abap-dump-monitor/db/schema.cds
git commit -m "feat(examples/abap-dump-monitor): data model"
```

---

## Task 3: Shared interfaces

**Files:**
- Create: `docs/examples/abap-dump-monitor/srv/interfaces.ts`

- [ ] **Step 3.1: Create interfaces**

```typescript
export interface ISettings {
  get(key: string): Promise<string | undefined>;
  getInt(key: string, fallback?: number): Promise<number>;
  getBool(key: string, fallback?: boolean): Promise<boolean>;
  getCsv(key: string): Promise<string[]>;
  invalidate(key: string): void;
}

export interface DumpListItem {
  system: string;
  dumpId: string;
  occurredAt: string;
  abapUser?: string;
  runtimeError?: string;
  category?: string;
  program?: string;
}

export interface DumpHeader {
  system: string;
  client?: string;
  dumpId: string;
  runtimeError?: string;
  exceptionClass?: string;
  category?: string;
  host?: string;
  instance?: string;
  program?: string;
  include?: string;
  mainProgram?: string;
  sourceLine?: number;
  event?: string;
  transactionId?: string;
  abapUser?: string;
  occurredAt?: string;
  shortText?: string;
}

export interface CallFrame {
  position: number;
  program?: string;
  include?: string;
  line?: number;
  eventType?: string;
  eventName?: string;
  objectClass?: string;
}

export interface ReferencedObject {
  objectName: string;
  objectType: string;
  subObject?: string;
  package?: string;
  source: 'stack' | 'source-extract' | 'message';
}

export interface VariableSnapshot {
  scope: 'local' | 'global' | 'sy';
  name: string;
  type?: string;
  value?: string;
  truncated?: boolean;
}

export interface SourceExtract {
  program?: string;
  include?: string;
  lineFrom?: number;
  lineTo?: number;
  code?: string;
}

export interface ParsedDump {
  header: DumpHeader;
  rawPayload: string;
  callStack: CallFrame[];
  referencedObjects: ReferencedObject[];
  variables: VariableSnapshot[];
  sourceExtract?: SourceExtract;
}

export interface IDumpSource {
  listSince(system: string, fromIso: string): Promise<DumpListItem[]>;
  fetch(system: string, dumpId: string): Promise<string>;
}

export interface AnalysisResult {
  raw: string;
  recommendations: string;
}

export interface IAnalyzer {
  analyze(parsed: ParsedDump): Promise<AnalysisResult>;
}

export interface JiraIssueRef {
  key: string;
  statusCategoryKey: string;
}

export interface JiraCreateInput {
  projectKey: string;
  summary: string;
  description: string;
  issueType: string;
  duedate: string;
  labels: string[];
  assignee?: string;
}

export interface IJiraClient {
  searchByLabel(label: string): Promise<JiraIssueRef | undefined>;
  getIssue(key: string): Promise<JiraIssueRef>;
  create(input: JiraCreateInput): Promise<string>;
  comment(key: string, body: string): Promise<void>;
}
```

- [ ] **Step 3.2: Verify TS compiles**

Run: `cd docs/examples/abap-dump-monitor && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3.3: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/interfaces.ts
git commit -m "feat(examples/abap-dump-monitor): shared interfaces"
```

---

## Task 4: SettingsService (TDD)

**Files:**
- Test: `docs/examples/abap-dump-monitor/test/unit/settings-service.test.ts`
- Create: `docs/examples/abap-dump-monitor/srv/settings-service.ts`

- [ ] **Step 4.1: Write failing test**

```typescript
import { SettingsService } from '../../srv/settings-service';

describe('SettingsService', () => {
  const fakeDbResponses: Record<string, { value: string; dataType: string } | undefined> = {};
  const fakeRun = jest.fn(async (key: string) => fakeDbResponses[key]);
  const svc = new SettingsService({ runOne: fakeRun }, 5000);

  beforeEach(() => {
    fakeRun.mockClear();
    for (const k of Object.keys(fakeDbResponses)) delete fakeDbResponses[k];
  });

  test('get returns string value from DB', async () => {
    fakeDbResponses['POLL_INTERVAL_MS'] = { value: '60000', dataType: 'int' };
    expect(await svc.get('POLL_INTERVAL_MS')).toBe('60000');
  });

  test('getInt parses int', async () => {
    fakeDbResponses['POLL_INTERVAL_MS'] = { value: '60000', dataType: 'int' };
    expect(await svc.getInt('POLL_INTERVAL_MS')).toBe(60000);
  });

  test('getBool parses boolean values', async () => {
    fakeDbResponses['FEATURE'] = { value: 'true', dataType: 'bool' };
    expect(await svc.getBool('FEATURE')).toBe(true);
  });

  test('getCsv splits comma-separated', async () => {
    fakeDbResponses['LABELS'] = { value: 'a,b,c', dataType: 'csv' };
    expect(await svc.getCsv('LABELS')).toEqual(['a', 'b', 'c']);
  });

  test('caches within TTL', async () => {
    fakeDbResponses['K'] = { value: 'v', dataType: 'string' };
    await svc.get('K');
    await svc.get('K');
    expect(fakeRun).toHaveBeenCalledTimes(1);
  });

  test('invalidate forces re-read', async () => {
    fakeDbResponses['K'] = { value: 'v', dataType: 'string' };
    await svc.get('K');
    svc.invalidate('K');
    await svc.get('K');
    expect(fakeRun).toHaveBeenCalledTimes(2);
  });

  test('returns undefined for unknown', async () => {
    expect(await svc.get('NONE')).toBeUndefined();
  });

  test('getInt returns fallback when missing', async () => {
    expect(await svc.getInt('MISSING', 42)).toBe(42);
  });
});
```

- [ ] **Step 4.2: Run test, expect fail**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/settings-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement SettingsService**

```typescript
import type { ISettings } from './interfaces';

export interface SettingsRepo {
  runOne(key: string): Promise<{ value: string; dataType: string } | undefined>;
}

interface CacheEntry { value?: string; dataType?: string; expiresAt: number; }

export class SettingsService implements ISettings {
  private cache = new Map<string, CacheEntry>();

  constructor(private repo: SettingsRepo, private ttlMs = 5000) {}

  async get(key: string): Promise<string | undefined> {
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const row = await this.repo.runOne(key);
    this.cache.set(key, { value: row?.value, dataType: row?.dataType, expiresAt: now + this.ttlMs });
    return row?.value;
  }

  async getInt(key: string, fallback?: number): Promise<number> {
    const v = await this.get(key);
    if (v === undefined) {
      if (fallback === undefined) throw new Error(`Setting ${key} not set`);
      return fallback;
    }
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`Setting ${key} is not a valid int: ${v}`);
    return n;
  }

  async getBool(key: string, fallback = false): Promise<boolean> {
    const v = await this.get(key);
    if (v === undefined) return fallback;
    return v === 'true' || v === '1';
  }

  async getCsv(key: string): Promise<string[]> {
    const v = await this.get(key);
    if (!v) return [];
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }
}
```

- [ ] **Step 4.4: Run test, expect pass**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/settings-service.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 4.5: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/settings-service.ts docs/examples/abap-dump-monitor/test/unit/settings-service.test.ts
git commit -m "feat(examples/abap-dump-monitor): hot-reloadable SettingsService"
```

---

## Task 5: Bootstrap (env → Setting seed)

**Files:**
- Create: `docs/examples/abap-dump-monitor/srv/bootstrap.ts`

- [ ] **Step 5.1: Implement bootstrap**

```typescript
import cds from '@sap/cds';

const SEED: Array<{ key: string; envKey: string; def: string; dataType: string; description: string }> = [
  { key: 'POLL_INTERVAL_MS',         envKey: 'POLL_INTERVAL_MS',         def: '300000',                                  dataType: 'int',    description: 'Polling interval in ms (min 60000 enforced).' },
  { key: 'POLL_CONCURRENCY_MODE',    envKey: 'POLL_CONCURRENCY_MODE',    def: 'skip',                                    dataType: 'string', description: 'skip | parallel | queue' },
  { key: 'LLM_MODEL',                envKey: 'LLM_MODEL',                def: 'anthropic--claude-4.5-sonnet',            dataType: 'string', description: 'cloud-llm-hub model id.' },
  { key: 'LLM_TEMPERATURE',          envKey: 'LLM_TEMPERATURE',          def: '0.2',                                     dataType: 'string', description: 'LLM temperature.' },
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
```

- [ ] **Step 5.2: TS compile check**

Run: `cd docs/examples/abap-dump-monitor && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5.3: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/bootstrap.ts
git commit -m "feat(examples/abap-dump-monitor): seed Setting from env on first boot"
```

---

## Task 6: Dump source (cloud-llm-hub MCP client)

**Files:**
- Create: `docs/examples/abap-dump-monitor/srv/dump-source.ts`

This client wraps cloud-llm-hub's MCP transport. It uses Cloud SDK destination resolution for the URL/auth, then calls MCP `tools/call` with `RuntimeListFeeds(feed_type='dumps')` and `RuntimeGetDumpById`.

- [ ] **Step 6.1: Implement DumpSource**

```typescript
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { randomUUID } from 'node:crypto';
import type { IDumpSource, DumpListItem } from './interfaces';

interface McpResult { content?: Array<{ type: string; text?: string }>; isError?: boolean; }

const ADT_TS = (iso: string): string =>
  iso.replace(/[-:T]/g, '').replace(/\..*$/, '').replace('Z', '').slice(0, 14);

export class DumpSource implements IDumpSource {
  constructor(
    private destinationName: string,
    private sapDestination: string,
    private sessionIdRef: { id?: string } = {}
  ) {}

  async listSince(system: string, fromIso: string): Promise<DumpListItem[]> {
    const result = await this.callTool('RuntimeListFeeds', {
      feed_type: 'dumps',
      from: ADT_TS(fromIso),
      to: ADT_TS(new Date().toISOString())
    });
    const text = result.content?.find(c => c.type === 'text')?.text ?? '[]';
    const arr: any[] = JSON.parse(text);
    return arr.map(d => ({
      system,
      dumpId: String(d.id ?? d.dumpId ?? d.runtime_error_id),
      occurredAt: String(d.timestamp ?? d.occurredAt ?? d.time),
      abapUser: d.user,
      runtimeError: d.runtime_error,
      category: d.category,
      program: d.program
    }));
  }

  async fetch(_system: string, dumpId: string): Promise<string> {
    const result = await this.callTool('RuntimeGetDumpById', {
      dump_id: dumpId,
      response_mode: 'both'
    });
    return result.content?.find(c => c.type === 'text')?.text ?? '';
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'X-SAP-Destination': this.sapDestination
    };
    if (this.sessionIdRef.id) headers['Mcp-Session-Id'] = this.sessionIdRef.id;

    const body = {
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args }
    };

    const resp = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: 'POST', url: '/mcp/stream/http', headers, data: body, responseType: 'text' }
    );

    if (!this.sessionIdRef.id) {
      const sid = resp.headers?.['mcp-session-id'] ?? resp.headers?.['Mcp-Session-Id'];
      if (sid) this.sessionIdRef.id = String(sid);
    }

    const payload = typeof resp.data === 'string' ? this.parseSseOrJson(resp.data) : resp.data;
    if (payload.error) throw new Error(`MCP ${name} failed: ${JSON.stringify(payload.error)}`);
    return payload.result as McpResult;
  }

  private parseSseOrJson(text: string): any {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const dataLines = trimmed.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
    const last = dataLines[dataLines.length - 1] ?? '{}';
    return JSON.parse(last);
  }
}
```

- [ ] **Step 6.2: TS compile check**

Run: `cd docs/examples/abap-dump-monitor && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6.3: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/dump-source.ts
git commit -m "feat(examples/abap-dump-monitor): MCP client for RuntimeListFeeds + RuntimeGetDumpById"
```

---

## Task 7: Dump parser (TDD)

**Files:**
- Create: `docs/examples/abap-dump-monitor/test/fixtures/dump-payload.sample.txt`
- Test: `docs/examples/abap-dump-monitor/test/unit/dump-parser.test.ts`
- Create: `docs/examples/abap-dump-monitor/srv/dump-parser.ts`

**Note on fixture:** the actual fixture must be a real `RuntimeGetDumpById(response_mode='both')` payload captured from a dev system. The shape varies between ADT versions; the parser is structured around well-known section headers and is tolerant of missing sections. Capture during integration testing (Task 16) and replace the synthetic fixture if needed.

- [ ] **Step 7.1: Create synthetic fixture**

```
docs/examples/abap-dump-monitor/test/fixtures/dump-payload.sample.txt
```
Content (paste literally):
```
RUNTIME_ERROR    OBJECTS_OBJREF_NOT_ASSIGNED
EXCEPTION        CX_SY_REF_IS_INITIAL
DATE             2026-04-29 12:34:56
USER             DEVELOPER1
CLIENT           100
HOST             s4hana-dev-01
INSTANCE         S4H_00
PROGRAM          ZCL_DEMO==========================CP
INCLUDE          ZCL_DEMO==========================CM001
LINE             42
EVENT            METHOD GET_DATA OF ZCL_DEMO
TRANSACTION_ID   T0000001
SHORT_TEXT       Access via 'NULL' object reference not possible.

----- CALL STACK -----
1 METHOD GET_DATA  ZCL_DEMO==========================CP   ZCL_DEMO==========================CM001  42
2 FORM PROCESS     ZREPORT_MAIN                            ZREPORT_MAIN_F01                          27
3 EVENT START-OF-SELECTION ZREPORT_MAIN                    ZREPORT_MAIN                              10

----- SOURCE EXTRACT -----
PROGRAM ZCL_DEMO==========================CP
INCLUDE ZCL_DEMO==========================CM001
40    METHOD get_data.
41      DATA(lo_provider) = mo_provider.
>>>   42      lo_provider->fetch( ).
43    ENDMETHOD.

----- VARIABLES -----
LOCAL  LO_PROVIDER  REF TO ZCL_PROVIDER  <INITIAL>
SY     SY-SUBRC     I                    0
GLOBAL MO_PROVIDER  REF TO ZCL_PROVIDER  <INITIAL>
```

- [ ] **Step 7.2: Write failing test**

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDump } from '../../srv/dump-parser';

const PAYLOAD = readFileSync(join(__dirname, '../fixtures/dump-payload.sample.txt'), 'utf-8');

describe('parseDump', () => {
  const parsed = parseDump('DEV.100', 'D-001', PAYLOAD);

  test('extracts header runtime error', () => {
    expect(parsed.header.runtimeError).toBe('OBJECTS_OBJREF_NOT_ASSIGNED');
    expect(parsed.header.exceptionClass).toBe('CX_SY_REF_IS_INITIAL');
  });

  test('extracts program/include/line', () => {
    expect(parsed.header.program).toBe('ZCL_DEMO==========================CP');
    expect(parsed.header.include).toBe('ZCL_DEMO==========================CM001');
    expect(parsed.header.sourceLine).toBe(42);
  });

  test('extracts user and client', () => {
    expect(parsed.header.abapUser).toBe('DEVELOPER1');
    expect(parsed.header.client).toBe('100');
  });

  test('parses 3-frame call stack', () => {
    expect(parsed.callStack).toHaveLength(3);
    expect(parsed.callStack[0]).toMatchObject({ position: 1, eventType: 'METHOD', line: 42 });
  });

  test('extracts source code with marker', () => {
    expect(parsed.sourceExtract?.code).toContain('lo_provider->fetch');
    expect(parsed.sourceExtract?.lineFrom).toBe(40);
    expect(parsed.sourceExtract?.lineTo).toBe(43);
  });

  test('parses variable snapshots', () => {
    const local = parsed.variables.find(v => v.scope === 'local' && v.name === 'LO_PROVIDER');
    expect(local).toBeDefined();
    expect(local?.value).toBe('<INITIAL>');
  });

  test('deduplicated referenced objects include programs from stack', () => {
    const names = parsed.referencedObjects.map(o => o.objectName);
    expect(names).toContain('ZCL_DEMO==========================CP');
    expect(names).toContain('ZREPORT_MAIN');
  });

  test('preserves rawPayload', () => {
    expect(parsed.rawPayload).toBe(PAYLOAD);
  });
});
```

- [ ] **Step 7.3: Run test, expect fail**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/dump-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7.4: Implement parser**

```typescript
import type { ParsedDump, DumpHeader, CallFrame, ReferencedObject, VariableSnapshot, SourceExtract } from './interfaces';

const HEADER_KEYS: Record<string, keyof DumpHeader> = {
  RUNTIME_ERROR: 'runtimeError',
  EXCEPTION: 'exceptionClass',
  PROGRAM: 'program',
  INCLUDE: 'include',
  USER: 'abapUser',
  CLIENT: 'client',
  HOST: 'host',
  INSTANCE: 'instance',
  EVENT: 'event',
  TRANSACTION_ID: 'transactionId',
  SHORT_TEXT: 'shortText'
};

export function parseDump(system: string, dumpId: string, payload: string): ParsedDump {
  const header: DumpHeader = { system, dumpId };
  const callStack: CallFrame[] = [];
  const variables: VariableSnapshot[] = [];
  let sourceExtract: SourceExtract | undefined;

  const sections = splitSections(payload);

  for (const line of sections.headerLines) {
    const m = /^(\w+)\s{2,}(.+)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'DATE') header.occurredAt = parseDate(value);
    else if (key === 'LINE') header.sourceLine = Number.parseInt(value, 10);
    else if (HEADER_KEYS[key]) (header as any)[HEADER_KEYS[key]] = value.trim();
  }

  for (const line of sections.callStack) {
    const m = /^(\d+)\s+(\w+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)$/.exec(line.trim());
    if (!m) continue;
    callStack.push({
      position: Number.parseInt(m[1], 10),
      eventType: m[2],
      eventName: m[3],
      program: m[4],
      include: m[5],
      line: Number.parseInt(m[6], 10)
    });
  }

  if (sections.sourceExtract.length) {
    let program: string | undefined;
    let include: string | undefined;
    const codeLines: string[] = [];
    let lineFrom: number | undefined;
    let lineTo: number | undefined;
    for (const line of sections.sourceExtract) {
      const pm = /^PROGRAM\s+(.+)$/.exec(line);
      const im = /^INCLUDE\s+(.+)$/.exec(line);
      const cm = /^(?:>>>\s*)?(\d+)\s+(.*)$/.exec(line);
      if (pm) program = pm[1].trim();
      else if (im) include = im[1].trim();
      else if (cm) {
        const ln = Number.parseInt(cm[1], 10);
        if (lineFrom === undefined) lineFrom = ln;
        lineTo = ln;
        codeLines.push(line.replace(/^>>>\s*/, ''));
      }
    }
    sourceExtract = { program, include, lineFrom, lineTo, code: codeLines.join('\n') };
  }

  for (const line of sections.variables) {
    const m = /^(LOCAL|GLOBAL|SY)\s+(\S+)\s+(.+?)\s{2,}(.*)$/.exec(line.trim());
    if (!m) continue;
    variables.push({
      scope: m[1].toLowerCase() as VariableSnapshot['scope'],
      name: m[2],
      type: m[3].trim(),
      value: m[4].trim()
    });
  }

  const referencedObjects = dedupReferences(callStack, sourceExtract);

  return { header, rawPayload: payload, callStack, referencedObjects, variables, sourceExtract };
}

function splitSections(payload: string): {
  headerLines: string[];
  callStack: string[];
  sourceExtract: string[];
  variables: string[];
} {
  const headerLines: string[] = [];
  const callStack: string[] = [];
  const sourceExtract: string[] = [];
  const variables: string[] = [];
  let current: 'header' | 'stack' | 'source' | 'vars' = 'header';
  for (const raw of payload.split(/\r?\n/)) {
    if (/^---+\s*CALL STACK/i.test(raw))     { current = 'stack'; continue; }
    if (/^---+\s*SOURCE EXTRACT/i.test(raw)) { current = 'source'; continue; }
    if (/^---+\s*VARIABLES/i.test(raw))      { current = 'vars'; continue; }
    if (current === 'header') headerLines.push(raw);
    else if (current === 'stack') callStack.push(raw);
    else if (current === 'source') sourceExtract.push(raw);
    else variables.push(raw);
  }
  return { headerLines, callStack, sourceExtract, variables };
}

function parseDate(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/.exec(v.trim());
  return m ? `${m[1]}T${m[2]}Z` : v.trim();
}

function dedupReferences(stack: CallFrame[], src?: SourceExtract): ReferencedObject[] {
  const seen = new Map<string, ReferencedObject>();
  const add = (objectName: string | undefined, source: ReferencedObject['source']) => {
    if (!objectName) return;
    const key = `${objectName}:${source}`;
    if (seen.has(key)) return;
    seen.set(key, { objectName, objectType: classify(objectName), source });
  };
  for (const f of stack) { add(f.program, 'stack'); add(f.include, 'stack'); }
  if (src) { add(src.program, 'source-extract'); add(src.include, 'source-extract'); }
  return [...seen.values()];
}

function classify(name: string): string {
  if (/^ZCL_|^CL_/.test(name)) return 'CLAS/OC';
  if (/^ZIF_|^IF_/.test(name)) return 'INTF/OI';
  if (/^L?SAP|^Z?REPORT|^Z[A-Z]+_/.test(name)) return 'PROG/P';
  return 'UNKNOWN';
}
```

- [ ] **Step 7.5: Run tests, expect pass**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/dump-parser.test.ts`
Expected: PASS — all 8 tests.

- [ ] **Step 7.6: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/dump-parser.ts docs/examples/abap-dump-monitor/test/fixtures/dump-payload.sample.txt docs/examples/abap-dump-monitor/test/unit/dump-parser.test.ts
git commit -m "feat(examples/abap-dump-monitor): dump payload parser"
```

---

## Task 8: Analyzer

**Files:**
- Create: `docs/examples/abap-dump-monitor/srv/analyzer.ts`

- [ ] **Step 8.1: Implement Analyzer**

```typescript
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import type { IAnalyzer, ISettings, ParsedDump, AnalysisResult } from './interfaces';

export class Analyzer implements IAnalyzer {
  constructor(
    private destinationName: string,
    private sapDestination: string,
    private settings: ISettings
  ) {}

  async analyze(parsed: ParsedDump): Promise<AnalysisResult> {
    const model = (await this.settings.get('LLM_MODEL')) ?? 'anthropic--claude-4.5-sonnet';
    const temperature = Number.parseFloat((await this.settings.get('LLM_TEMPERATURE')) ?? '0.2');

    const userPrompt = buildPrompt(parsed);
    const body = {
      model,
      temperature,
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You are a senior ABAP engineer. Analyze the provided ABAP runtime error dump. ' +
            'Use available MCP tools (e.g. GetClass, GetProgram) on referenced objects when helpful. ' +
            'Respond in markdown with sections "## Diagnosis" and "## Recommendations". ' +
            'The Recommendations section MUST contain numbered, actionable steps.'
        },
        { role: 'user', content: userPrompt }
      ]
    };

    const resp = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'X-SAP-Destination': this.sapDestination
        },
        data: body,
        responseType: 'json'
      }
    );

    const raw = JSON.stringify(resp.data);
    const content: string = resp.data?.choices?.[0]?.message?.content ?? '';
    const recommendations = extractSection(content, 'Recommendations') ?? content;
    return { raw, recommendations };
  }
}

function buildPrompt(p: ParsedDump): string {
  const top5 = p.callStack.slice(0, 5).map(f => `${f.position}. ${f.eventType ?? ''} ${f.eventName ?? ''} @ ${f.program}/${f.include}:${f.line}`).join('\n');
  return [
    `# ABAP Dump`,
    `System: ${p.header.system}  Client: ${p.header.client ?? ''}  User: ${p.header.abapUser ?? ''}`,
    `Runtime error: ${p.header.runtimeError ?? ''}`,
    `Exception: ${p.header.exceptionClass ?? ''}`,
    `Location: ${p.header.program}/${p.header.include}:${p.header.sourceLine}`,
    `Short text: ${p.header.shortText ?? ''}`,
    ``,
    `## Top stack`,
    top5,
    ``,
    `## Source extract`,
    '```abap',
    p.sourceExtract?.code ?? '(none)',
    '```',
    ``,
    `## Variables`,
    p.variables.slice(0, 20).map(v => `- [${v.scope}] ${v.name} : ${v.type ?? ''} = ${v.value ?? ''}`).join('\n')
  ].join('\n');
}

function extractSection(md: string, heading: string): string | undefined {
  const re = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'mi');
  const m = re.exec(md);
  return m ? m[1].trim() : undefined;
}
```

- [ ] **Step 8.2: TS compile check**

Run: `cd docs/examples/abap-dump-monitor && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8.3: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/analyzer.ts
git commit -m "feat(examples/abap-dump-monitor): cloud-llm-hub analyzer"
```

---

## Task 9: Jira client (TDD with mocks)

**Files:**
- Test: `docs/examples/abap-dump-monitor/test/unit/jira-client.test.ts`
- Create: `docs/examples/abap-dump-monitor/srv/jira-client.ts`

The class accepts an `httpFn` injection to keep `executeHttpRequest` out of unit tests.

- [ ] **Step 9.1: Write failing test**

```typescript
import { JiraClient, type JiraHttpFn } from '../../srv/jira-client';

describe('JiraClient', () => {
  test('searchByLabel returns first issue when found', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({
      status: 200,
      data: { issues: [{ key: 'X-1', fields: { status: { statusCategory: { key: 'indeterminate' } } } }] }
    });
    const c = new JiraClient('JIRA', http);
    const r = await c.searchByLabel('DEV.100:D-001');
    expect(r?.key).toBe('X-1');
    expect(r?.statusCategoryKey).toBe('indeterminate');
  });

  test('searchByLabel returns undefined when empty', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 200, data: { issues: [] } });
    const c = new JiraClient('JIRA', http);
    expect(await c.searchByLabel('NONE')).toBeUndefined();
  });

  test('create posts and returns key', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 201, data: { key: 'X-9' } });
    const c = new JiraClient('JIRA', http);
    const key = await c.create({
      projectKey: 'X', summary: 's', description: 'd', issueType: 'Story',
      duedate: '2026-05-10', labels: ['a', 'b']
    });
    expect(key).toBe('X-9');
    const call = (http as jest.Mock).mock.calls[0][1];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/rest/api/2/issue');
    expect(call.data.fields.assignee).toBeUndefined();
  });

  test('create includes assignee when given', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 201, data: { key: 'X-10' } });
    const c = new JiraClient('JIRA', http);
    await c.create({
      projectKey: 'X', summary: 's', description: 'd', issueType: 'Story',
      duedate: '2026-05-10', labels: [], assignee: 'someone@x'
    });
    const call = (http as jest.Mock).mock.calls[0][1];
    expect(call.data.fields.assignee).toEqual({ name: 'someone@x' });
  });

  test('comment posts to /comment endpoint', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 201, data: {} });
    const c = new JiraClient('JIRA', http);
    await c.comment('X-1', 'hello');
    const call = (http as jest.Mock).mock.calls[0][1];
    expect(call.url).toBe('/rest/api/2/issue/X-1/comment');
    expect(call.data).toEqual({ body: 'hello' });
  });

  test('throws on non-2xx', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 400, data: { errorMessages: ['bad'] } });
    const c = new JiraClient('JIRA', http);
    await expect(c.create({ projectKey: 'X', summary: 's', description: 'd', issueType: 'Story', duedate: '2026-05-10', labels: [] })).rejects.toThrow(/Jira create failed/);
  });
});
```

- [ ] **Step 9.2: Run test, expect fail**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/jira-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 9.3: Implement JiraClient**

```typescript
import type { IJiraClient, JiraIssueRef, JiraCreateInput } from './interfaces';

export type JiraHttpFn = (
  destination: { destinationName: string },
  request: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    data?: unknown;
    responseType?: 'json';
  }
) => Promise<{ status: number; data: any }>;

export class JiraClient implements IJiraClient {
  constructor(private destinationName: string, private http: JiraHttpFn) {}

  async searchByLabel(label: string): Promise<JiraIssueRef | undefined> {
    const resp = await this.http(
      { destinationName: this.destinationName },
      {
        method: 'GET',
        url: '/rest/api/2/search',
        params: { jql: `labels = "${label}"`, fields: 'status', maxResults: '1' },
        responseType: 'json'
      }
    );
    this.assertOk(resp, 'search');
    const issue = resp.data?.issues?.[0];
    if (!issue) return undefined;
    return { key: issue.key, statusCategoryKey: issue.fields?.status?.statusCategory?.key ?? 'undefined' };
  }

  async getIssue(key: string): Promise<JiraIssueRef> {
    const resp = await this.http(
      { destinationName: this.destinationName },
      { method: 'GET', url: `/rest/api/2/issue/${encodeURIComponent(key)}`, params: { fields: 'status' }, responseType: 'json' }
    );
    this.assertOk(resp, `get ${key}`);
    return { key: resp.data.key, statusCategoryKey: resp.data.fields?.status?.statusCategory?.key ?? 'undefined' };
  }

  async create(input: JiraCreateInput): Promise<string> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      summary: input.summary,
      description: input.description,
      issuetype: { name: input.issueType },
      duedate: input.duedate,
      labels: input.labels
    };
    if (input.assignee) fields.assignee = { name: input.assignee };
    const resp = await this.http(
      { destinationName: this.destinationName },
      {
        method: 'POST',
        url: '/rest/api/2/issue',
        headers: { 'Content-Type': 'application/json' },
        data: { fields },
        responseType: 'json'
      }
    );
    this.assertOk(resp, 'create');
    return resp.data.key;
  }

  async comment(key: string, body: string): Promise<void> {
    const resp = await this.http(
      { destinationName: this.destinationName },
      {
        method: 'POST',
        url: `/rest/api/2/issue/${encodeURIComponent(key)}/comment`,
        headers: { 'Content-Type': 'application/json' },
        data: { body },
        responseType: 'json'
      }
    );
    this.assertOk(resp, `comment ${key}`);
  }

  private assertOk(resp: { status: number; data: any }, op: string): void {
    if (resp.status >= 200 && resp.status < 300) return;
    const detail = resp.data?.errorMessages?.join('; ') ?? JSON.stringify(resp.data);
    throw new Error(`Jira ${op} failed: ${resp.status} ${detail}`);
  }
}

export const defaultJiraHttpFn: JiraHttpFn = async (dest, req) => {
  const { executeHttpRequest } = await import('@sap-cloud-sdk/http-client');
  const r = await executeHttpRequest(dest, req as any);
  return { status: r.status, data: r.data };
};
```

- [ ] **Step 9.4: Run test, expect pass**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/jira-client.test.ts`
Expected: PASS — all 6 tests.

- [ ] **Step 9.5: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/jira-client.ts docs/examples/abap-dump-monitor/test/unit/jira-client.test.ts
git commit -m "feat(examples/abap-dump-monitor): Jira REST client"
```

---

## Task 10: Jira policy (TDD)

**Files:**
- Test: `docs/examples/abap-dump-monitor/test/unit/jira-policy.test.ts`
- Create: `docs/examples/abap-dump-monitor/srv/jira-policy.ts`

- [ ] **Step 10.1: Write failing test**

```typescript
import { computeSignature, dueDateForCount, matchAssignee } from '../../srv/jira-policy';

describe('jira-policy', () => {
  describe('computeSignature', () => {
    test('joins requested fields with pipe', () => {
      const sig = computeSignature(
        { system: 'DEV.100', dumpId: 'D1', runtimeError: 'X', program: 'P', include: 'I' } as any,
        ['system', 'runtimeError', 'program', 'include']
      );
      expect(sig).toBe('DEV.100|X|P|I');
    });

    test('blanks become empty segments', () => {
      const sig = computeSignature({ system: 'DEV', dumpId: 'D' } as any, ['system', 'runtimeError']);
      expect(sig).toBe('DEV|');
    });
  });

  describe('dueDateForCount', () => {
    const cfg = { first: 14, recurring: 7, frequent: 2, low: 2, high: 5 };
    const today = new Date('2026-04-29T00:00:00Z');
    test('count=1 → +14 days', () => expect(dueDateForCount(1, cfg, today)).toBe('2026-05-13'));
    test('count=2 → +7 days', () => expect(dueDateForCount(2, cfg, today)).toBe('2026-05-06'));
    test('count=4 → +7 days', () => expect(dueDateForCount(4, cfg, today)).toBe('2026-05-06'));
    test('count=5 → +2 days', () => expect(dueDateForCount(5, cfg, today)).toBe('2026-05-01'));
    test('count=10 → +2 days', () => expect(dueDateForCount(10, cfg, today)).toBe('2026-05-01'));
  });

  describe('matchAssignee', () => {
    const dump = { system: 'DEV.100', runtimeError: 'OBJECTS_OBJREF_NOT_ASSIGNED', program: 'ZTEST', category: 'cat1' };
    test('returns null when no rules match', () => {
      expect(matchAssignee(dump, [])).toBeUndefined();
    });
    test('matches by program prefix', () => {
      const rules = [{ priority: 10, programPattern: 'Z*', assigneeName: 'a@x', active: true } as any];
      expect(matchAssignee(dump, rules)).toBe('a@x');
    });
    test('lower priority wins', () => {
      const rules = [
        { priority: 10, programPattern: 'Z*', assigneeName: 'a@x', active: true } as any,
        { priority: 5,  programPattern: 'Z*', assigneeName: 'b@x', active: true } as any
      ];
      expect(matchAssignee(dump, rules)).toBe('b@x');
    });
    test('inactive rules ignored', () => {
      const rules = [{ priority: 1, programPattern: 'Z*', assigneeName: 'a@x', active: false } as any];
      expect(matchAssignee(dump, rules)).toBeUndefined();
    });
    test('all non-empty patterns must match', () => {
      const rules = [{
        priority: 10, system: 'OTHER', programPattern: 'Z*', assigneeName: 'a@x', active: true
      } as any];
      expect(matchAssignee(dump, rules)).toBeUndefined();
    });
  });
});
```

- [ ] **Step 10.2: Run test, expect fail**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/jira-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 10.3: Implement policy**

```typescript
export interface DumpForSignature {
  system?: string;
  dumpId?: string;
  runtimeError?: string;
  exceptionClass?: string;
  program?: string;
  include?: string;
  category?: string;
}

export function computeSignature(dump: DumpForSignature, fields: string[]): string {
  return fields.map(f => (dump as Record<string, unknown>)[f] ?? '').map(String).join('|');
}

export interface DueDateConfig {
  first: number; recurring: number; frequent: number; low: number; high: number;
}

export function dueDateForCount(count: number, cfg: DueDateConfig, today = new Date()): string {
  let days: number;
  if (count >= cfg.high) days = cfg.frequent;
  else if (count >= cfg.low) days = cfg.recurring;
  else days = cfg.first;
  const d = new Date(today.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface AssigneeRuleRow {
  priority: number;
  active: boolean;
  system?: string;
  runtimeErrorPattern?: string;
  programPattern?: string;
  categoryPattern?: string;
  assigneeName?: string;
}

export interface DumpForRouting {
  system?: string;
  runtimeError?: string;
  program?: string;
  category?: string;
}

export function matchAssignee(dump: DumpForRouting, rules: AssigneeRuleRow[]): string | undefined {
  const matches = rules
    .filter(r => r.active)
    .filter(r => !r.system || r.system === dump.system)
    .filter(r => !r.runtimeErrorPattern || matchesGlob(dump.runtimeError, r.runtimeErrorPattern))
    .filter(r => !r.programPattern || matchesGlob(dump.program, r.programPattern))
    .filter(r => !r.categoryPattern || matchesGlob(dump.category, r.categoryPattern))
    .sort((a, b) => a.priority - b.priority);
  const winner = matches[0];
  if (!winner) return undefined;
  return winner.assigneeName && winner.assigneeName.length > 0 ? winner.assigneeName : undefined;
}

function matchesGlob(value: string | undefined, pattern: string): boolean {
  if (value === undefined) return false;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(value);
}
```

- [ ] **Step 10.4: Run test, expect pass**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/jira-policy.test.ts`
Expected: PASS — all 11 tests.

- [ ] **Step 10.5: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/jira-policy.ts docs/examples/abap-dump-monitor/test/unit/jira-policy.test.ts
git commit -m "feat(examples/abap-dump-monitor): Jira policy (signature, due-date, routing)"
```

---

## Task 11: Poller (TDD orchestration)

**Files:**
- Test: `docs/examples/abap-dump-monitor/test/unit/poller.test.ts`
- Create: `docs/examples/abap-dump-monitor/srv/poller.ts`

The poller takes all dependencies as interfaces. Repository operations are abstracted behind a `DumpRepository` so tests don't need CAP. Production wiring (Task 12) implements this with `cds.connect.to('db')`.

- [ ] **Step 11.1: Write failing test**

```typescript
import { Poller, type DumpRepository } from '../../srv/poller';
import type { ISettings, IDumpSource, IAnalyzer, IJiraClient, ParsedDump } from '../../srv/interfaces';

const settings: ISettings = {
  get: jest.fn(async (k: string) => ({
    DUMP_SIGNATURE_FIELDS: 'system,runtimeError,program,include',
    JIRA_PROJECT_KEY: 'X',
    JIRA_ISSUE_TYPE: 'Story',
    JIRA_DEFAULT_ASSIGNEE: '',
    JIRA_LABELS: 'a,b'
  } as Record<string, string>)[k]),
  getInt: jest.fn(async (k: string) => ({
    JIRA_HISTORY_DAYS: 30,
    JIRA_DUE_DAYS_FIRST: 14,
    JIRA_DUE_DAYS_RECURRING: 7,
    JIRA_DUE_DAYS_FREQUENT: 2,
    JIRA_FREQ_THRESHOLD_LOW: 2,
    JIRA_FREQ_THRESHOLD_HIGH: 5,
    JIRA_MAX_ATTEMPTS: 3,
    ANALYSIS_MAX_ATTEMPTS: 3
  } as Record<string, number>)[k]),
  getBool: jest.fn(async () => false),
  getCsv: jest.fn(async (k: string) => (k === 'DUMP_SIGNATURE_FIELDS' ? ['system','runtimeError','program','include'] : k === 'JIRA_LABELS' ? ['a','b'] : [])),
  invalidate: jest.fn()
};

const parsed: ParsedDump = {
  header: { system: 'DEV.100', dumpId: 'D-1', runtimeError: 'RE', program: 'ZP', include: 'ZI', sourceLine: 1, occurredAt: '2026-04-29T00:00:00Z' },
  rawPayload: 'raw',
  callStack: [],
  referencedObjects: [],
  variables: []
};

const dumpSource: IDumpSource = {
  listSince: jest.fn().mockResolvedValue([{ system: 'DEV.100', dumpId: 'D-1', occurredAt: '2026-04-29T00:00:00Z' }]),
  fetch: jest.fn().mockResolvedValue('raw')
};

const analyzer: IAnalyzer = {
  analyze: jest.fn().mockResolvedValue({ raw: '{}', recommendations: 'do X' })
};

const jira: IJiraClient = {
  searchByLabel: jest.fn().mockResolvedValue(undefined),
  getIssue: jest.fn(),
  create: jest.fn().mockResolvedValue('X-1'),
  comment: jest.fn()
};

function makeRepo(): DumpRepository {
  const dumps: any[] = [];
  return {
    listSystems: jest.fn(async () => ['DEV.100']),
    maxOccurredAt: jest.fn(async () => undefined),
    findByDumpId: jest.fn(async (sys, id) => dumps.find(d => d.system === sys && d.dumpId === id)),
    insertParsed: jest.fn(async (p, parsed, signature) => {
      const row = { ID: String(dumps.length + 1), ...p, signature, analysisStatus: 'pending', jiraStatus: 'pending', analysisAttempts: 0, jiraAttempts: 0, skipJira: false };
      dumps.push(row);
      return row.ID;
    }),
    findPendingAnalysis: jest.fn(async () => dumps.filter(d => d.analysisStatus === 'pending')),
    updateAnalysis: jest.fn(async (id, patch) => { Object.assign(dumps.find(d => d.ID === id)!, patch); }),
    findPendingJira: jest.fn(async () => dumps.filter(d => d.analysisStatus === 'done' && d.jiraStatus === 'pending' && !d.skipJira)),
    updateJira: jest.fn(async (id, patch) => { Object.assign(dumps.find(d => d.ID === id)!, patch); }),
    countSignatureWithin: jest.fn(async () => 1),
    findRecentByJira: jest.fn(async () => undefined),
    listAssigneeRules: jest.fn(async () => []),
    parsePayload: jest.fn((sys, id, raw) => ({ ...parsed, header: { ...parsed.header, system: sys, dumpId: id }, rawPayload: raw }))
  };
}

describe('Poller.pollOnce', () => {
  test('full happy path: list → insert → analyze → create Jira', async () => {
    const repo = makeRepo();
    const p = new Poller({ settings, dumpSource, analyzer, jira, repo, log: () => {} });
    await p.pollOnce();
    expect(repo.insertParsed).toHaveBeenCalledTimes(1);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
    expect(jira.create).toHaveBeenCalledTimes(1);
    const createArg = (jira.create as jest.Mock).mock.calls[0][0];
    expect(createArg.summary).toContain('RE');
    expect(createArg.labels).toContain('DEV.100:D-1');
  });

  test('comments on existing open recurring issue instead of creating', async () => {
    const repo = makeRepo();
    (repo.findRecentByJira as jest.Mock).mockResolvedValue({ ID: 'old', jiraIssueKey: 'X-EXISTING' });
    (jira.getIssue as jest.Mock).mockResolvedValue({ key: 'X-EXISTING', statusCategoryKey: 'indeterminate' });
    const p = new Poller({ settings, dumpSource, analyzer, jira, repo, log: () => {} });
    await p.pollOnce();
    expect(jira.comment).toHaveBeenCalledWith('X-EXISTING', expect.any(String));
    expect(jira.create).not.toHaveBeenCalled();
  });

  test('skips Jira when label search finds existing issue', async () => {
    const repo = makeRepo();
    (jira.searchByLabel as jest.Mock).mockResolvedValueOnce({ key: 'X-DUP', statusCategoryKey: 'done' });
    const p = new Poller({ settings, dumpSource, analyzer, jira, repo, log: () => {} });
    await p.pollOnce();
    expect(jira.create).not.toHaveBeenCalled();
    expect(repo.updateJira).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ jiraStatus: 'skipped', jiraIssueKey: 'X-DUP' }));
  });
});
```

- [ ] **Step 11.2: Run test, expect fail**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/poller.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 11.3: Implement poller**

```typescript
import type { ISettings, IDumpSource, IAnalyzer, IJiraClient, ParsedDump, DumpListItem } from './interfaces';
import { computeSignature, dueDateForCount, matchAssignee, type AssigneeRuleRow } from './jira-policy';

export interface DumpRepository {
  listSystems(): Promise<string[]>;
  maxOccurredAt(system: string): Promise<string | undefined>;
  findByDumpId(system: string, dumpId: string): Promise<{ ID: string } | undefined>;
  insertParsed(item: DumpListItem, parsed: ParsedDump, signature: string): Promise<string>;
  findPendingAnalysis(maxAttempts: number): Promise<Array<{ ID: string; rawPayload: string; system: string; dumpId: string; analysisAttempts: number }>>;
  updateAnalysis(id: string, patch: Record<string, unknown>): Promise<void>;
  findPendingJira(maxAttempts: number): Promise<Array<{ ID: string; system: string; dumpId: string; signature: string; runtimeError?: string; program?: string; category?: string; recommendations?: string; jiraAttempts: number; shortText?: string; include?: string; sourceLine?: number; occurredAt?: string; abapUser?: string }>>;
  updateJira(id: string, patch: Record<string, unknown>): Promise<void>;
  countSignatureWithin(signature: string, sinceIso: string): Promise<number>;
  findRecentByJira(signature: string, sinceIso: string): Promise<{ ID: string; jiraIssueKey: string } | undefined>;
  listAssigneeRules(): Promise<AssigneeRuleRow[]>;
  parsePayload(system: string, dumpId: string, raw: string): ParsedDump;
}

export interface PollerDeps {
  settings: ISettings;
  dumpSource: IDumpSource;
  analyzer: IAnalyzer;
  jira: IJiraClient;
  repo: DumpRepository;
  log: (msg: string, err?: unknown) => void;
}

export class Poller {
  private running = false;

  constructor(private deps: PollerDeps) {}

  async pollOnce(): Promise<void> {
    if (this.running) {
      const mode = (await this.deps.settings.get('POLL_CONCURRENCY_MODE')) ?? 'skip';
      if (mode === 'skip') { this.deps.log('skip: previous tick still running'); return; }
    }
    this.running = true;
    try {
      await this.discoverNewDumps();
      await this.runAnalysisStep();
      await this.runJiraStep();
    } finally {
      this.running = false;
    }
  }

  private async discoverNewDumps(): Promise<void> {
    const sigFields = await this.deps.settings.getCsv('DUMP_SIGNATURE_FIELDS');
    for (const system of await this.deps.repo.listSystems()) {
      const since = await this.computeSince(system);
      let items: DumpListItem[];
      try { items = await this.deps.dumpSource.listSince(system, since); }
      catch (e) { this.deps.log(`list ${system} failed`, e); continue; }
      for (const it of items) {
        const existing = await this.deps.repo.findByDumpId(it.system, it.dumpId);
        if (existing) continue;
        try {
          const raw = await this.deps.dumpSource.fetch(it.system, it.dumpId);
          const parsed = this.deps.repo.parsePayload(it.system, it.dumpId, raw);
          const sig = computeSignature(parsed.header, sigFields);
          await this.deps.repo.insertParsed(it, parsed, sig);
        } catch (e) { this.deps.log(`fetch ${it.system}/${it.dumpId} failed`, e); }
      }
    }
  }

  private async computeSince(system: string): Promise<string> {
    const last = await this.deps.repo.maxOccurredAt(system);
    if (!last) return new Date(Date.now() - 24 * 3600_000).toISOString();
    return new Date(new Date(last).getTime() - 24 * 3600_000).toISOString();
  }

  private async runAnalysisStep(): Promise<void> {
    const cap = await this.deps.settings.getInt('ANALYSIS_MAX_ATTEMPTS', 3);
    const rows = await this.deps.repo.findPendingAnalysis(cap);
    for (const row of rows) {
      try {
        await this.deps.repo.updateAnalysis(row.ID, { analysisStatus: 'analyzing' });
        const parsed = this.deps.repo.parsePayload(row.system, row.dumpId, row.rawPayload);
        const r = await this.deps.analyzer.analyze(parsed);
        await this.deps.repo.updateAnalysis(row.ID, {
          analysisStatus: 'done', analysisResult: r.raw, recommendations: r.recommendations, analysisError: null
        });
      } catch (e: any) {
        await this.deps.repo.updateAnalysis(row.ID, {
          analysisStatus: 'failed', analysisError: String(e?.message ?? e), analysisAttempts: row.analysisAttempts + 1
        });
      }
    }
  }

  private async runJiraStep(): Promise<void> {
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
```

- [ ] **Step 11.4: Run test, expect pass**

Run: `cd docs/examples/abap-dump-monitor && npx jest test/unit/poller.test.ts`
Expected: PASS — all 3 tests.

- [ ] **Step 11.5: Run all unit tests**

Run: `cd docs/examples/abap-dump-monitor && npx jest`
Expected: PASS — all suites green.

- [ ] **Step 11.6: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/poller.ts docs/examples/abap-dump-monitor/test/unit/poller.test.ts
git commit -m "feat(examples/abap-dump-monitor): poller orchestration with state machine"
```

---

## Task 12: OData service + handlers + repository

**Files:**
- Create: `docs/examples/abap-dump-monitor/srv/monitor-service.cds`
- Create: `docs/examples/abap-dump-monitor/srv/monitor-service.ts`

- [ ] **Step 12.1: Create CDS service**

```cds
using example.abapdumpmonitor as core from '../db/schema';

service MonitorService @(path: '/odata/v4/admin', requires: 'Viewer') {

  @readonly
  entity MonitoredDump as projection on core.MonitoredDump
    actions {
      action retryAnalysis() returns String;
      action retryJira()     returns String;
    };

  entity Setting       @(restrict: [{ grant: '*', to: 'Admin' }]) as projection on core.Setting;
  entity AssigneeRule  @(restrict: [{ grant: '*', to: 'Admin' }]) as projection on core.AssigneeRule;

  @(requires: 'Admin')
  action pollNow() returns String;
}
```

- [ ] **Step 12.2: Implement handlers + repository + startup**

```typescript
import cds from '@sap/cds';
import { SettingsService } from './settings-service';
import { seedSettings } from './bootstrap';
import { DumpSource } from './dump-source';
import { Analyzer } from './analyzer';
import { JiraClient, defaultJiraHttpFn } from './jira-client';
import { Poller, type DumpRepository } from './poller';
import { parseDump } from './dump-parser';
import type { DumpListItem, ParsedDump } from './interfaces';

const log = cds.log('abap-dump-monitor');

class CdsDumpRepository implements DumpRepository {
  parsePayload(system: string, dumpId: string, raw: string): ParsedDump {
    return parseDump(system, dumpId, raw);
  }
  async listSystems(): Promise<string[]> {
    const sap = process.env.SAP_DESTINATION;
    return sap ? [sap] : [];
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

let pollerSingleton: Poller | undefined;
let pollerTimer: NodeJS.Timeout | undefined;

async function startPolling(settings: SettingsService, poller: Poller) {
  const tick = async () => {
    try { await poller.pollOnce(); } catch (e) { log.error('pollOnce', e); }
    finally {
      const ms = Math.max(60_000, await settings.getInt('POLL_INTERVAL_MS', 300_000));
      pollerTimer = setTimeout(tick, ms);
    }
  };
  pollerTimer = setTimeout(tick, 5_000);
}

export default cds.service.impl(async function () {
  const { Setting } = cds.entities('example.abapdumpmonitor');
  const db = await cds.connect.to('db');

  await seedSettings();

  const settings = new SettingsService({
    runOne: async (key: string) => {
      const r = await db.run(SELECT.one.from(Setting).where({ key }));
      return r ? { value: r.value, dataType: r.dataType } : undefined;
    }
  });

  this.after('UPDATE', Setting, (_, req) => {
    const key = (req.data as any).key ?? (req.params?.[0] as any)?.key;
    if (key) settings.invalidate(String(key));
  });

  const sapDest = process.env.SAP_DESTINATION ?? '';
  const hubDest = process.env.CLOUD_LLM_HUB_DESTINATION ?? 'CLOUD_LLM_HUB';
  const jiraDest = process.env.JIRA_DESTINATION ?? 'JIRA';

  const dumpSource = new DumpSource(hubDest, sapDest);
  const analyzer = new Analyzer(hubDest, sapDest, settings);
  const jira = new JiraClient(jiraDest, defaultJiraHttpFn);
  const repo = new CdsDumpRepository();

  pollerSingleton = new Poller({ settings, dumpSource, analyzer, jira, repo, log: (m, e) => e ? log.error(m, e) : log.info(m) });

  this.on('pollNow', async () => {
    if (!pollerSingleton) throw new Error('poller not initialized');
    await pollerSingleton.pollOnce();
    return 'ok';
  });

  this.on('retryAnalysis', 'MonitoredDump', async (req) => {
    const { ID } = req.params[0] as { ID: string };
    await UPDATE(cds.entities('example.abapdumpmonitor').MonitoredDump)
      .set({ analysisStatus: 'pending', analysisError: null, analysisAttempts: 0 }).where({ ID });
    return 'ok';
  });

  this.on('retryJira', 'MonitoredDump', async (req) => {
    const { ID } = req.params[0] as { ID: string };
    await UPDATE(cds.entities('example.abapdumpmonitor').MonitoredDump)
      .set({ jiraStatus: 'pending', jiraError: null, jiraAttempts: 0 }).where({ ID });
    return 'ok';
  });

  if (sapDest) await startPolling(settings, pollerSingleton);
  else log.warn('SAP_DESTINATION not set — polling disabled');
});

cds.on('shutdown', () => {
  if (pollerTimer) clearTimeout(pollerTimer);
});
```

- [ ] **Step 12.3: Build CAP project**

Run: `cd docs/examples/abap-dump-monitor && npx cds build --production`
Expected: build succeeds, `gen/srv/` and `gen/db/` produced.

- [ ] **Step 12.4: TS compile check (handlers reference cds runtime)**

Run: `cd docs/examples/abap-dump-monitor && npx tsc --noEmit`
Expected: no errors. (Note: CAP runtime APIs `SELECT`, `INSERT`, `UPDATE` are global at runtime; `@sap/cds` augments them. If TS reports them missing, add `import cds from '@sap/cds'` and use `cds.ql.SELECT` etc., or add a `/// <reference path="../node_modules/@sap/cds/apis/cqn.d.ts" />` at top.)

- [ ] **Step 12.5: Commit**

```bash
git add docs/examples/abap-dump-monitor/srv/monitor-service.cds docs/examples/abap-dump-monitor/srv/monitor-service.ts
git commit -m "feat(examples/abap-dump-monitor): OData service + repository + poller startup"
```

---

## Task 13: Security (xs-security.json)

**Files:**
- Create: `docs/examples/abap-dump-monitor/xs-security.json`

- [ ] **Step 13.1: Create xs-security.json**

```json
{
  "xsappname": "abap-dump-monitor",
  "tenant-mode": "dedicated",
  "scopes": [
    { "name": "$XSAPPNAME.Admin",  "description": "Edit Setting / AssigneeRule, trigger pollNow / retry actions" },
    { "name": "$XSAPPNAME.Viewer", "description": "Read MonitoredDump" }
  ],
  "role-templates": [
    { "name": "Admin",  "description": "Administrator", "scope-references": ["$XSAPPNAME.Admin", "$XSAPPNAME.Viewer"] },
    { "name": "Viewer", "description": "Read-only",     "scope-references": ["$XSAPPNAME.Viewer"] }
  ],
  "role-collections": [
    { "name": "AbapDumpMonitorAdmin",  "description": "abap-dump-monitor administrator", "role-template-references": ["$XSAPPNAME.Admin"] },
    { "name": "AbapDumpMonitorViewer", "description": "abap-dump-monitor viewer",        "role-template-references": ["$XSAPPNAME.Viewer"] }
  ]
}
```

- [ ] **Step 13.2: Commit**

```bash
git add docs/examples/abap-dump-monitor/xs-security.json
git commit -m "feat(examples/abap-dump-monitor): xsuaa role templates"
```

---

## Task 14: MTA + .mtaext.example

**Files:**
- Create: `docs/examples/abap-dump-monitor/mta.yaml`
- Create: `docs/examples/abap-dump-monitor/.mtaext.example`

- [ ] **Step 14.1: Create mta.yaml**

```yaml
_schema-version: 3.3.0
ID: abap-dump-monitor
version: 1.0.0
description: "abap-dump-monitor — scheduled-pull ABAP dump monitor via cloud-llm-hub + Jira"
parameters:
  enable-parallel-deployments: true
  CLOUD_LLM_HUB_URL: ""
  CLOUD_LLM_HUB_CLIENT_ID: ""
  CLOUD_LLM_HUB_CLIENT_SECRET: ""
  CLOUD_LLM_HUB_TOKEN_URL: ""
  JIRA_URL: "https://sap.example.com"
  JIRA_USER: ""
  JIRA_TOKEN: ""

modules:
  - name: abap-dump-monitor-srv
    type: nodejs
    path: gen/srv
    parameters:
      buildpack: nodejs_buildpack
      memory: 256M
    properties:
      SAP_DESTINATION: "S4HANA_DEV"
      CLOUD_LLM_HUB_DESTINATION: "CLOUD_LLM_HUB"
      JIRA_DESTINATION: "JIRA"
    build-parameters:
      builder: custom
      commands:
        - npm ci --omit=dev
    requires:
      - name: abap-dump-monitor-auth
      - name: abap-dump-monitor-db
      - name: abap-dump-monitor-destination

  - name: abap-dump-monitor-db-deployer
    type: hdb
    path: gen/db
    parameters:
      buildpack: nodejs_buildpack
    requires:
      - name: abap-dump-monitor-db

resources:
  - name: abap-dump-monitor-auth
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: ./xs-security.json

  - name: abap-dump-monitor-db
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared

  - name: abap-dump-monitor-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite
      config:
        init_data:
          instance:
            existing_destinations_policy: update
            destinations:
              - Name: CLOUD_LLM_HUB
                Type: HTTP
                URL: ${CLOUD_LLM_HUB_URL}
                ProxyType: Internet
                Authentication: OAuth2ClientCredentials
                clientId: ${CLOUD_LLM_HUB_CLIENT_ID}
                clientSecret: ${CLOUD_LLM_HUB_CLIENT_SECRET}
                tokenServiceURL: ${CLOUD_LLM_HUB_TOKEN_URL}
              - Name: JIRA
                Type: HTTP
                URL: ${JIRA_URL}
                ProxyType: Internet
                Authentication: BasicAuthentication
                User: ${JIRA_USER}
                Password: ${JIRA_TOKEN}
```

- [ ] **Step 14.2: Create .mtaext.example**

```yaml
_schema-version: 3.3.0
ID: abap-dump-monitor.config
extends: abap-dump-monitor

parameters:
  # cloud-llm-hub OAuth2ClientCredentials — fetch from `cloud-llm-hub-analyst-consumer` service key
  CLOUD_LLM_HUB_URL: "https://cloud-llm-hub-srv.cfapps.eu10.hana.ondemand.com"
  CLOUD_LLM_HUB_CLIENT_ID: "sb-..."
  CLOUD_LLM_HUB_CLIENT_SECRET: "..."
  CLOUD_LLM_HUB_TOKEN_URL: "https://<subaccount>.authentication.eu10.hana.ondemand.com/oauth/token"

  # Jira
  JIRA_URL: "https://sap.example.com"
  JIRA_USER: "your.email@acme.com"
  JIRA_TOKEN: "<your Jira API token>"
```

- [ ] **Step 14.3: Validate MTA structure**

Run: `cd docs/examples/abap-dump-monitor && npx cds build --production && npx mbt build -p=cf --mtar abap-dump-monitor_1.0.0.mtar 2>&1 | tail -20`
Expected: build succeeds (or fails clearly if mbt is not installed; the latter is acceptable — the structure is what matters and CI of cloud-llm-hub does not build sub-examples).

- [ ] **Step 14.4: Commit**

```bash
git add docs/examples/abap-dump-monitor/mta.yaml docs/examples/abap-dump-monitor/.mtaext.example
git commit -m "feat(examples/abap-dump-monitor): MTA + .mtaext template"
```

---

## Task 15: Documentation

**Files:**
- Create: `docs/examples/abap-dump-monitor/README.md`
- Create: `docs/examples/abap-dump-monitor/docs/OVERVIEW.md`
- Create: `docs/examples/abap-dump-monitor/docs/DEPLOYMENT.md`
- Create: `docs/examples/abap-dump-monitor/docs/CONSUMER-GUIDE.md`

- [ ] **Step 15.1: README.md**

```markdown
# abap-dump-monitor

Standalone CAP example service that:

1. Periodically polls FIDS (ABAP runtime errors) via cloud-llm-hub MCP (`RuntimeListFeeds(feed_type='dumps')`).
2. Persists each new dump to HANA Cloud with a structured composition tree (call stack, referenced objects, variables, source extract).
3. Asks cloud-llm-hub `/v1/chat/completions` to analyze the dump and stores the LLM response.
4. Creates a Jira ticket on success — or comments on an existing open ticket when the same signature recurs.

All operational policy (polling interval, due-date thresholds, Jira project, etc.) is **hot-reloadable** via OData `PATCH` against the `Setting` entity — no redeploy.

See:
- [docs/OVERVIEW.md](docs/OVERVIEW.md) — architecture
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — BTP / Jira / cloud-llm-hub setup
- [docs/CONSUMER-GUIDE.md](docs/CONSUMER-GUIDE.md) — how to operate the service

> Local `cds watch` is NOT supported because the service depends on BTP destinations + cloud-llm-hub MCP at runtime. Validate via deploy to a dev subaccount.
```

- [ ] **Step 15.2: docs/OVERVIEW.md**

Content (key shape):

```markdown
# Architecture

[Insert the high-level flow diagram from the spec.]

## Modules

| File | Role |
|---|---|
| `srv/poller.ts` | tick loop + state-machine driver |
| `srv/dump-source.ts` | cloud-llm-hub MCP client (list/get) |
| `srv/dump-parser.ts` | raw payload → structured tree |
| `srv/analyzer.ts` | cloud-llm-hub /v1/chat/completions |
| `srv/jira-client.ts` | Jira REST (BasicAuth) |
| `srv/jira-policy.ts` | signature, due-date, assignee match |
| `srv/settings-service.ts` | hot-reloadable config |
| `srv/monitor-service.ts` | OData admin + handlers + repository |

## State machine

`MonitoredDump.analysisStatus` : `pending → analyzing → done | failed`
`MonitoredDump.jiraStatus`     : `pending → created | commented | skipped | failed`

Failed states are sticky until reset via `retryAnalysis()` / `retryJira()` admin actions.
```

- [ ] **Step 15.3: docs/DEPLOYMENT.md**

```markdown
# Deployment

## 1. cloud-llm-hub consumer

The service must use the **analyst** consumer xsuaa, NOT the default reader.
Reader xsuaa silently excludes dump-related tools from the SmartAgent tool pool.

```bash
cf create-service-key cloud-llm-hub-analyst-consumer abap-dump-monitor-key
cf service-key cloud-llm-hub-analyst-consumer abap-dump-monitor-key
```

Copy `clientid`, `clientsecret`, `url` (without trailing path), and `xsuaa.url + /oauth/token` into `.mtaext` (see `.mtaext.example`).

## 2. Jira

- Create a Jira API token at https://sap.example.com → user → API tokens.
- Put email + token into `.mtaext` (`JIRA_USER` / `JIRA_TOKEN`).

## 3. Build & deploy

```bash
cd docs/examples/abap-dump-monitor
cp .mtaext.example .mtaext
# fill in placeholders

npx cds build --production
npx mbt build -p=cf --mtar abap-dump-monitor_1.0.0.mtar
cf deploy mta_archives/abap-dump-monitor_1.0.0.mtar -e .mtaext
```

## 4. Role assignment

Assign `AbapDumpMonitorAdmin` and/or `AbapDumpMonitorViewer` role collections in the BTP cockpit to your user.
```

- [ ] **Step 15.4: docs/CONSUMER-GUIDE.md**

```markdown
# Consumer Guide

## Change polling interval (hot)

```bash
TOKEN=$(...)  # XSUAA token for an Admin user
curl -X PATCH https://<app>/odata/v4/admin/Setting/key='POLL_INTERVAL_MS' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value":"60000"}'
```

Within 5 seconds (cache TTL) the next tick uses the new value.

## Trigger a poll on demand

```bash
curl -X POST https://<app>/odata/v4/admin/pollNow -H "Authorization: Bearer $TOKEN"
```

## Retry a failed row

```bash
curl -X POST https://<app>/odata/v4/admin/MonitoredDump(<ID>)/MonitorService.retryAnalysis \
  -H "Authorization: Bearer $TOKEN"
```

## Add a routing rule

```bash
curl -X POST https://<app>/odata/v4/admin/AssigneeRule \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"priority":10,"programPattern":"Z*","assigneeName":"sviatlana_isaichkina@acme.com","active":true}'
```

## Recognized Setting keys

[Insert table from the spec's "Configuration" section.]
```

- [ ] **Step 15.5: Commit**

```bash
git add docs/examples/abap-dump-monitor/README.md docs/examples/abap-dump-monitor/docs
git commit -m "docs(examples/abap-dump-monitor): overview, deployment, consumer guide"
```

---

## Task 16: Integration verification (manual, dev subaccount)

This task is not automated; it serves as an acceptance gate before merge.

- [ ] **Step 16.1: Deploy to dev subaccount**

Run the deploy steps from Task 15.3.

- [ ] **Step 16.2: Verify pollNow happy path**

```bash
curl -X POST https://<app>/odata/v4/admin/pollNow -H "Authorization: Bearer $TOKEN"
```

Expected: `200 ok`. Within ~30s, `MonitoredDump` rows appear; one of them transitions to `analysisStatus=done` and `jiraStatus=created` with a real `jiraIssueKey`.

- [ ] **Step 16.3: Verify recurring scenario**

Trigger another dump in the SAP system with the same `(runtimeError, program, include)`. Run `pollNow` again. Expected: the new row gets `jiraStatus=commented` with the same `jiraIssueKey`.

- [ ] **Step 16.4: Verify hot-reload**

`PATCH` `POLL_INTERVAL_MS` to `60000`. Watch logs (`cf logs abap-dump-monitor-srv --recent`) for the next tick at the new interval.

- [ ] **Step 16.5: Capture a real dump payload**

Save the raw payload from one `MonitoredDump.rawPayload` to `test/fixtures/dump-payload.real.txt` (redact sensitive content). If the synthetic parser tests don't cover the real shape, add fixture-based tests in a follow-up commit.

- [ ] **Step 16.6: Commit fixture / parser fixes if needed**

```bash
git add docs/examples/abap-dump-monitor/test/fixtures/dump-payload.real.txt docs/examples/abap-dump-monitor/srv/dump-parser.ts docs/examples/abap-dump-monitor/test/unit/dump-parser.test.ts
git commit -m "test(examples/abap-dump-monitor): real dump payload fixture + parser fixes"
```

- [ ] **Step 16.7: Delete plan + spec after merge**

Per CLAUDE.md "Plans and Specs": once the example is merged to `main`, delete:
- `docs/superpowers/specs/2026-04-29-abap-dump-monitor-design.md`
- `docs/superpowers/plans/2026-04-29-abap-dump-monitor.md`

```bash
git rm docs/superpowers/specs/2026-04-29-abap-dump-monitor-design.md docs/superpowers/plans/2026-04-29-abap-dump-monitor.md
git commit -m "chore: drop completed abap-dump-monitor plan and spec"
```

---

## Self-review notes

- **Spec coverage:** Polling, MCP routing, hot-reload, parser, analyzer, Jira recurrence + frequency due-date + assignee routing, retry caps, OData admin actions, security, sensitive-data note in CONSUMER-GUIDE — all mapped to tasks.
- **Type consistency:** `ISettings.get` returns `Promise<string | undefined>` everywhere; `IDumpSource`/`IAnalyzer`/`IJiraClient` shapes match between `interfaces.ts` and consumers.
- **Open caveat:** the `dump-parser` is structured around a synthetic header convention. Task 16.5 captures a real payload; if its shape diverges from the fixture (likely), the parser will need adjustments — that's why integration verification is a gated task before merge, not after.
- **Concurrency:** the MTA defines a single instance by default; running >1 instance in production requires the `jiraStatus='creating'` claim mentioned in the spec — out of scope for v1.

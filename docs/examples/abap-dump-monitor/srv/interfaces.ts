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
}

export interface VariableSnapshot {
  scope: string;
  frameNo?: number;
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

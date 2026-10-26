import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
import { USAGE_CSV_COLUMNS } from '@mcp-abap-adt/llm-usage';
import type {
  RequestValues,
  RetrievalValues,
  SessionValues,
} from './hub-records';
import type { ProcessValues } from './process-meter';
import type { StorageSnapshotValues } from './storage-values';

// Exhaustive maps: adding a typed measurement requires adding its CSV column.
const session: Record<keyof SessionValues, true> = {
  event: true,
  reason: true,
  endKnown: true,
  durationMs: true,
  turns: true,
  tasks: true,
  messagesDelivered: true,
  openai: true,
  anthropic: true,
  mcpAgent: true,
};
const request: Record<keyof RequestValues, true> = {
  protocol: true,
  tool: true,
  stream: true,
  admissionWaitMs: true,
  turnDurationMs: true,
  followDurationMs: true,
  endReason: true,
  responseEndAt: true,
  operationEndAt: true,
  messagesDelivered: true,
  bytesWritten: true,
};
const retrieval: Record<keyof RetrievalValues, true> = {
  collections: true,
  chunks: true,
  chars: true,
  injected: true,
};
const processColumns: Record<keyof ProcessValues, true> = {
  rssBytes: true,
  heapUsedBytes: true,
  externalBytes: true,
  cpuUserMs: true,
  cpuSystemMs: true,
  eventLoopDelayP99Ms: true,
  intervalMs: true,
  activeSessions: true,
  runningTasks: true,
  openSapConnections: true,
  admissionQueueLength: true,
};

const storage: Record<keyof StorageSnapshotValues, true> = {
  stateBytes: true,
  outboxBytes: true,
  historyBytes: true,
  stateBytesUnknown: true,
  outboxBytesUnknown: true,
  historyBytesUnknown: true,
  sessionCollectionDocuments: true,
  sessionCollectionTextBytes: true,
  sessionCollectionVectorBytes: true,
  sessionCollectionDocumentsUnknown: true,
  sessionCollectionTextBytesUnknown: true,
  sessionCollectionVectorBytesUnknown: true,
  userCollectionDocuments: true,
  userCollectionTextBytes: true,
  userCollectionVectorBytes: true,
  userCollectionDocumentsUnknown: true,
  userCollectionTextBytesUnknown: true,
  userCollectionVectorBytesUnknown: true,
};
const valueKeys = [
  ...new Set([
    ...Object.keys(session),
    ...Object.keys(request),
    ...Object.keys(retrieval),
    ...Object.keys(storage),
    ...Object.keys(processColumns),
    'storageSnapshotAt',
  ]),
];
export const HUB_CSV_COLUMNS: string[] = [
  ...USAGE_CSV_COLUMNS.filter(
    (column: string): boolean =>
      column !== 'values' && column !== 'loss_evidence',
  ),
  'context.component',
  ...valueKeys.map((key: string): string => `values.${key}`),
  'loss_evidence',
  'extra_json',
];
type Cell = string | number | boolean | undefined;
function quote(value: Cell): string {
  const safe =
    typeof value === 'string' && /^[=+\-@\t\r]/.test(value)
      ? `'${value}`
      : value;
  const text = String(safe ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}
export async function* exportHubCsv(
  records: AsyncIterable<UsageRecord>,
): AsyncIterable<string> {
  yield `${HUB_CSV_COLUMNS.join(',')}\n`;
  for await (const record of records) {
    const flat: Record<string, Cell> = {};
    const fields: Record<string, Cell | Record<string, Cell>> = { ...record };
    for (const [key, value] of Object.entries(fields)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      )
        flat[key] = value;
    }
    for (const [key, value] of Object.entries(record.context))
      flat[`context.${key}`] = value;
    const extra: Record<string, Cell> = {};
    if ('values' in record) {
      for (const [key, value] of Object.entries(record.values)) {
        const column = `values.${key}`;
        if (HUB_CSV_COLUMNS.includes(column)) flat[column] = value;
        else extra[key] = value;
      }
    }
    flat.loss_evidence = record.kind === 'x.usage.lost';
    flat.extra_json = Object.keys(extra).length ? JSON.stringify(extra) : '';
    yield `${HUB_CSV_COLUMNS.map((column: string): string => quote(flat[column])).join(',')}\n`;
  }
}

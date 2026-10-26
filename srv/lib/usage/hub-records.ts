import type { IUsageRecorder } from '@mcp-abap-adt/llm-agent';

export type SessionCloseReason =
  | 'explicit'
  | 'ttl'
  | 'evicted'
  | 'shutdown'
  | 'expired-offline';
export type Protocol = 'openai' | 'anthropic' | 'mcp-agent';
export type EndReason =
  | 'done'
  | 'waiting_user'
  | 'idle'
  | 'limit'
  | 'superseded'
  | 'disconnected'
  | 'error';
export interface SessionValues {
  event: 'open' | 'revive' | 'close';
  reason?: SessionCloseReason;
  endKnown?: boolean;
  durationMs?: number;
  turns?: number;
  tasks?: number;
  messagesDelivered?: number;
  openai?: number;
  anthropic?: number;
  mcpAgent?: number;
}
export interface RequestValues {
  protocol: Protocol;
  tool?: string;
  stream: boolean;
  admissionWaitMs: number;
  turnDurationMs: number;
  followDurationMs: number;
  endReason: EndReason;
  responseEndAt: number;
  operationEndAt: number;
  messagesDelivered: number;
  bytesWritten: number;
}
export interface RetrievalValues {
  collections: number;
  chunks: number;
  chars: number;
  injected: boolean;
}
export function sessionRecord(
  usage: IUsageRecorder,
  values: SessionValues,
  storage: Record<string, number | string | boolean> = {},
): void {
  usage.record({
    context: {},
    kind: 'x.hub.session',
    outcome: 'ok',
    values: { ...values, ...storage },
  });
}
export function requestRecord(
  usage: IUsageRecorder,
  values: RequestValues,
): void {
  usage.record({
    context: {},
    kind: 'x.hub.request',
    outcome: values.endReason === 'error' ? 'error' : 'ok',
    values: { ...values },
  });
}
export function retrievalRecord(
  usage: IUsageRecorder,
  values: RetrievalValues,
): void {
  usage.record({
    context: {},
    kind: 'x.hub.retrieval',
    outcome: 'ok',
    values: { ...values },
  });
}

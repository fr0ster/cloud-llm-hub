import { readPositiveIntFrom } from '../env-int';
import { loadSessionConfig } from '../session-config';

export const MEASURES = [
  'llm',
  'embedding',
  'tool',
  'task',
  'session',
  'request',
  'storage',
  'process',
] as const;
export type Measure = (typeof MEASURES)[number];
export type SinkName = 'hana' | 'pg' | 'sqlite' | 'jsonl' | 'memory';
export interface UsageConfig {
  enabled: boolean;
  sinks: SinkName[];
  measure: Measure[];
  sqlitePath: string;
  jsonlPath?: string;
  jsonlRotateBytes: number;
  memoryLimit: number;
  processIntervalMs: number;
  storageIntervalMs: number;
  retentionDays: number;
  userId: 'hash' | 'plain';
}
function isChoice<T extends readonly string[]>(
  raw: string,
  allowed: T,
): raw is T[number] {
  return allowed.some((value) => value === raw);
}
export function isMeasure(raw: string): raw is Measure {
  return isChoice(raw, MEASURES);
}
function choice<const T extends readonly string[]>(
  raw: string,
  allowed: T,
  name: string,
): T[number] {
  if (!isChoice(raw, allowed))
    throw new Error(`Invalid ${name}: expected ${allowed.join(', ')}`);
  return raw;
}
export function readUsageConfig(
  env: NodeJS.ProcessEnv = process.env,
  sessionBackend?: string,
): UsageConfig {
  const enabled =
    choice(
      env.LLM_AGENT_USAGE?.trim() || 'off',
      ['on', 'off'],
      'LLM_AGENT_USAGE',
    ) === 'on';
  const store = loadSessionConfig(env, sessionBackend).store;
  const sinks = (
    env.LLM_AGENT_USAGE_SINKS?.trim() ||
    (store === 'hana-vector' ? 'hana' : store === 'pg-vector' ? 'pg' : 'sqlite')
  )
    .split(',')
    .map((s) =>
      choice(
        s.trim(),
        ['hana', 'pg', 'sqlite', 'jsonl', 'memory'] as const,
        'LLM_AGENT_USAGE_SINKS',
      ),
    );
  const rawMeasure = env.LLM_AGENT_USAGE_MEASURE?.trim() || 'all';
  const measure =
    rawMeasure === 'all'
      ? [...MEASURES]
      : rawMeasure
          .split(',')
          .map((s) => choice(s.trim(), MEASURES, 'LLM_AGENT_USAGE_MEASURE'));
  const num = (name: string, fallback: number): number =>
    readPositiveIntFrom(env, name) ?? fallback;
  const jsonlPath = env.LLM_AGENT_USAGE_JSONL_PATH?.trim() || undefined;
  if (enabled && sinks.includes('jsonl') && !jsonlPath)
    throw new Error('LLM_AGENT_USAGE_JSONL_PATH is required for jsonl');
  return {
    enabled,
    sinks: [...new Set(sinks)],
    measure,
    sqlitePath: env.LLM_AGENT_USAGE_SQLITE_PATH?.trim() || 'usage.sqlite',
    jsonlPath,
    jsonlRotateBytes: num('LLM_AGENT_USAGE_JSONL_ROTATE_BYTES', 104857600),
    memoryLimit: num('LLM_AGENT_USAGE_MEMORY_LIMIT', 100000),
    processIntervalMs: num('LLM_AGENT_USAGE_PROCESS_INTERVAL_MS', 30000),
    storageIntervalMs: num('LLM_AGENT_USAGE_STORAGE_INTERVAL_MS', 600000),
    retentionDays: num('LLM_AGENT_USAGE_RETENTION_DAYS', 90),
    userId: choice(
      env.LLM_AGENT_USAGE_USER_ID?.trim() || 'hash',
      ['hash', 'plain'],
      'LLM_AGENT_USAGE_USER_ID',
    ),
  };
}

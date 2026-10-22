import cds from '@sap/cds';
import { setGlobalLogLevel } from '@sap-cloud-sdk/util';

type Level = 'error' | 'warn' | 'info' | 'debug';
function level(value: string, source: string): Level {
  if (!['error', 'warn', 'info', 'debug'].includes(value))
    throw new Error(
      `${source}: invalid log level "${value}"; expected error|warn|info|debug`,
    );
  return value as Level;
}

export function parseLoggingConfig(env: NodeJS.ProcessEnv = process.env) {
  const defaultLevel = level(
    env.LLM_AGENT_LOG_LEVEL ?? 'info',
    'LLM_AGENT_LOG_LEVEL',
  );
  const overrides: Record<string, Level> = Object.create(null);
  if (env.LLM_AGENT_LOG_LEVELS) {
    for (const entry of env.LLM_AGENT_LOG_LEVELS.split(',')) {
      const match = /^\s*([\w.-]+)\s*=\s*(\w+)\s*$/.exec(entry);
      if (!match)
        throw new Error(
          `LLM_AGENT_LOG_LEVELS: malformed entry "${entry}"; expected name=level`,
        );
      overrides[match[1]] = level(match[2], 'LLM_AGENT_LOG_LEVELS');
    }
  }
  return { defaultLevel, overrides };
}

export function applyLoggingConfig(env: NodeJS.ProcessEnv = process.env): void {
  const { defaultLevel, overrides } = parseLoggingConfig(env);
  // CAP 10 reads log.levels[id] for newly created loggers. Supply a fallback
  // through that supported configuration surface, including future logger names.
  cds.env.log.levels = new Proxy(
    { ...cds.env.log.levels, ...overrides },
    {
      get(_target, name: string) {
        return Object.hasOwn(overrides, name) ? overrides[name] : defaultLevel;
      },
    },
  );
  const loggers = (
    cds.log as typeof cds.log & { loggers: Record<string, unknown> }
  ).loggers;
  for (const name of Object.keys(loggers))
    cds.log(name, overrides[name] ?? defaultLevel);
  for (const [name, value] of Object.entries(overrides)) {
    if (name === 'sap-cloud-sdk') setGlobalLogLevel(value);
    else cds.log(name, value);
  }
}

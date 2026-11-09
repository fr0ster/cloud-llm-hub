import { BuildValidationError } from './build-validation-error';

/** Preserve the legacy fallback while allowing the provider's own default. */
export function configuredTemperature(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const name = env.LLM_AGENT_TEMPERATURE
    ? 'LLM_AGENT_TEMPERATURE'
    : 'SAP_CORE_AI_TEMPERATURE';
  const raw = env[name];
  if (!raw) return 0.7;
  const value = raw.trim();
  if (value === 'off') return undefined;
  const temperature = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(
    value,
  )
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(temperature))
    throw new BuildValidationError(
      `Invalid ${name}: expected a finite number or off, got ${JSON.stringify(raw)}`,
    );
  return temperature;
}

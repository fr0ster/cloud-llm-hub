import { BuildValidationError } from './build-validation-error';

/** Use the provider/model default unless a numeric override is configured. */
export function configuredTemperature(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const name = env.LLM_AGENT_TEMPERATURE
    ? 'LLM_AGENT_TEMPERATURE'
    : 'SAP_CORE_AI_TEMPERATURE';
  const raw = env[name];
  if (!raw) return undefined;
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

import type { ModelParams } from './role-model-settings';

export interface ParamCapability {
  name: keyof ModelParams;
  min?: number;
  max?: number;
  canDisable: boolean;
}
export interface ModelCapabilities {
  family:
    | 'anthropic'
    | 'openai'
    | 'openai-reasoning'
    | 'gemini'
    | 'mistral'
    | 'other';
  params: ParamCapability[];
  maxOutputTokens?: number;
}

export function modelCapabilities(
  model: string,
): ModelCapabilities | undefined {
  let family: ModelCapabilities['family'];
  if (model.startsWith('anthropic--')) family = 'anthropic';
  else if (/^(?:gpt-5(?:[.-]|$)|o[134](?:-|$))/.test(model))
    family = 'openai-reasoning';
  else if (model.startsWith('gpt-')) family = 'openai';
  else if (model.startsWith('gemini-')) family = 'gemini';
  else if (model.startsWith('mistral')) family = 'mistral';
  else return undefined;

  const params: ParamCapability[] = [];
  if (family !== 'openai-reasoning') {
    params.push(
      {
        name: 'temperature',
        min: 0,
        max: family === 'anthropic' ? 1 : 2,
        canDisable: false,
      },
      { name: 'topP', min: 0, max: 1, canDisable: false },
    );
  }
  // Only verified per-model maxima are exposed; no family-wide maximum is guessed.
  // https://www.anthropic.com/news/claude-opus-4-6
  const maxOutputTokens =
    model === 'anthropic--claude-4.6-opus' ? 128000 : undefined;
  params.push({
    name: 'maxOutputTokens',
    min: 1,
    canDisable: true,
    ...(maxOutputTokens === undefined ? {} : { max: maxOutputTokens }),
  });
  if (family === 'anthropic' || family === 'openai-reasoning')
    params.push({ name: 'reasoning', canDisable: true });
  return {
    family,
    params,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export function capabilitiesFor(
  allow: ReadonlySet<string>,
): Record<string, ModelCapabilities | null> {
  return Object.fromEntries(
    [...allow].map((model) => [model, modelCapabilities(model) ?? null]),
  );
}

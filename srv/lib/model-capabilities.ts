import { BuildValidationError } from './build-validation-error';
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

const maxOutputTokensByModel = new Map([
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-5.html
  ['anthropic--claude-4.5-sonnet', 64_000],
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html
  ['anthropic--claude-4.6-sonnet', 64_000],
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-6.html
  ['anthropic--claude-4.6-opus', 128_000],
]);

type FoundationChatFamily = 'anthropic' | 'openai';

/** SapAiCoreFoundationProvider routes Anthropic to Bedrock and otherwise uses OpenAI chat. */
export function foundationChatFamily(
  model: string,
): FoundationChatFamily | undefined {
  if (model.startsWith('anthropic--')) return 'anthropic';
  if (/^(?:gpt-|o\d)/.test(model)) return 'openai';
  return undefined;
}

export function requireFoundationChatFamily(
  model: string,
): FoundationChatFamily {
  const family = foundationChatFamily(model);
  if (!family)
    throw new BuildValidationError(
      `Unsupported chat model ${JSON.stringify(model)} for LLM_AGENT_PROVIDER=sap-aicore-foundation. Supported families are anthropic--* (Bedrock), gpt-*, and o<digit>* (OpenAI chat).`,
    );
  return family;
}

export function foundationMaxTokens(model: string): number | undefined {
  if (requireFoundationChatFamily(model) !== 'anthropic') return undefined;
  const maxTokens = modelCapabilities(model)?.maxOutputTokens;
  if (maxTokens === undefined)
    throw new BuildValidationError(
      `LLM_AGENT_PROVIDER=sap-aicore-foundation requires a documented maxOutputTokens capability for model "${model}" in srv/lib/model-capabilities.ts.`,
    );
  return maxTokens;
}

export function modelCapabilities(
  model: string,
): ModelCapabilities | undefined {
  let family: ModelCapabilities['family'];
  if (model.startsWith('anthropic--') || model.startsWith('claude-'))
    family = 'anthropic';
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
  const maxOutputTokens = maxOutputTokensByModel.get(model);
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

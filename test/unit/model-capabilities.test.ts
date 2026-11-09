import {
  capabilitiesFor,
  modelCapabilities,
} from '../../srv/lib/model-capabilities';

test('anthropic--claude-4.6-opus exposes anthropic parameters and an output maximum', () => {
  const caps = modelCapabilities('anthropic--claude-4.6-opus');
  expect(caps?.family).toBe('anthropic');
  expect(caps?.params.map((param) => param.name)).toEqual([
    'temperature',
    'topP',
    'maxOutputTokens',
    'reasoning',
  ]);
  expect(
    caps?.params.find((param) => param.name === 'maxOutputTokens')?.canDisable,
  ).toBe(true);
  expect(caps?.maxOutputTokens).toBeGreaterThan(0);
});

test.each(['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini'])(
  '%s has reasoning and no temperature',
  (model) => {
    const caps = modelCapabilities(model);
    expect(caps?.family).toBe('openai-reasoning');
    expect(caps?.params.some((param) => param.name === 'temperature')).toBe(
      false,
    );
    expect(caps?.params.some((param) => param.name === 'reasoning')).toBe(true);
  },
);

test.each([
  ['gpt-4o', 'openai'],
  ['gemini-2.5-pro', 'gemini'],
  ['mistral-large', 'mistral'],
])('recognizes %s', (model, family) => {
  expect(modelCapabilities(model)?.family).toBe(family);
});

test.each(['foreign', '', 'my-gpt-5', 'o10', 'o3foreign'])(
  'unknown model %s returns undefined',
  (model) => {
    expect(modelCapabilities(model)).toBeUndefined();
  },
);

test('capabilitiesFor maps every allowlisted model, unknown ones to null', () => {
  expect(capabilitiesFor(new Set(['gpt-4o', 'foreign']))).toEqual({
    'gpt-4o': modelCapabilities('gpt-4o'),
    foreign: null,
  });
});

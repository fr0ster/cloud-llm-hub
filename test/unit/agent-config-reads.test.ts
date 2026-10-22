import {
  clearAgentConfig,
  loadAgentConfig,
  parseDestinationMapping,
  parseSkillRagK,
} from '../../srv/agent-config';

// Settings that used to be read from process.env at their point of use. They
// are parsed once, here, and handed in (config is parsed only in agent-config).
describe('agent config: settings read at the point of use before', () => {
  it('parseSkillRagK: default 3, truncated, floored at 0', () => {
    expect(parseSkillRagK({})).toBe(3);
    expect(parseSkillRagK({ LLM_AGENT_SKILL_RAG_K: 'x' })).toBe(3);
    expect(parseSkillRagK({ LLM_AGENT_SKILL_RAG_K: '5.9' })).toBe(5);
    expect(parseSkillRagK({ LLM_AGENT_SKILL_RAG_K: '-2' })).toBe(0);
    expect(parseSkillRagK({ LLM_AGENT_SKILL_RAG_K: '0' })).toBe(0);
  });

  it('parseDestinationMapping: pairs, trimmed, malformed ones skipped', () => {
    expect(parseDestinationMapping({})).toEqual({});
    expect(
      parseDestinationMapping({
        DESTINATION_MAPPING: 'DEV.100 = DEST_A, QAS.600=DEST_B,broken,=x',
      }),
    ).toEqual({ 'DEV.100': 'DEST_A', 'QAS.600': 'DEST_B' });
  });

  describe('loadAgentConfig', () => {
    const saved = { ...process.env };
    beforeEach(() => {
      process.env = { ...saved };
      for (const k of [
        'LLM_AGENT_CLASSIFIER_MODEL',
        'LLM_AGENT_SKILL_RAG_K',
        'LLM_AGENT_ALLOW_LLM_ONLY_FALLBACK',
        'DESTINATION_MAPPING',
        'LLM_AGENT_RAG_TYPE',
        'LLM_AGENT_DESTINATION_SOURCE',
      ])
        delete process.env[k];
      process.env.LLM_AGENT_MODEL = 'main-model';
      clearAgentConfig();
    });
    afterAll(() => {
      process.env = saved;
      clearAgentConfig();
    });

    it('classifier model falls back to the main model', () => {
      expect(loadAgentConfig().llm.classifierModel).toBe('main-model');
      process.env.LLM_AGENT_CLASSIFIER_MODEL = 'helper-model';
      expect(loadAgentConfig().llm.classifierModel).toBe('helper-model');
    });

    it('carries the skill cap, the fallback switch and the mapping', () => {
      let c = loadAgentConfig();
      expect(c.agent.skillRagK).toBe(3);
      expect(c.agent.allowLlmOnlyFallback).toBe(false);
      expect(c.mcp.systemDestinations).toEqual({});

      process.env.LLM_AGENT_SKILL_RAG_K = '1';
      process.env.LLM_AGENT_ALLOW_LLM_ONLY_FALLBACK = 'true';
      process.env.DESTINATION_MAPPING = 'DEV.100=DEST_A';
      c = loadAgentConfig();
      expect(c.agent.skillRagK).toBe(1);
      expect(c.agent.allowLlmOnlyFallback).toBe(true);
      expect(c.mcp.systemDestinations).toEqual({ 'DEV.100': 'DEST_A' });
    });
  });
});

describe('chat coordinator configuration', () => {
  const saved = { ...process.env };
  const names = [
    'LLM_AGENT_CHAT_COORDINATOR',
    'LLM_AGENT_PLAN_MAX_STEPS',
    'LLM_AGENT_PLAN_MAX_REVISIONS',
    'LLM_AGENT_PLAN_MAX_DURATION_MS',
  ];
  beforeEach(() => {
    process.env = { ...saved };
    for (const name of names) delete process.env[name];
  });
  afterAll(() => {
    process.env = saved;
    clearAgentConfig();
  });
  it('chatCoordinator defaults to adaptive', () => {
    expect(loadAgentConfig().agent).toHaveProperty(
      'chatCoordinator',
      'adaptive',
    );
  });
  it('LLM_AGENT_CHAT_COORDINATOR=fixed is read', () => {
    process.env.LLM_AGENT_CHAT_COORDINATOR = 'fixed';
    expect(loadAgentConfig().agent).toHaveProperty('chatCoordinator', 'fixed');
  });
  it('invalid LLM_AGENT_CHAT_COORDINATOR throws', () => {
    process.env.LLM_AGENT_CHAT_COORDINATOR = 'wrong';
    expect(() => loadAgentConfig()).toThrow('LLM_AGENT_CHAT_COORDINATOR');
  });
  it('plan budget env vars are read and malformed values throw', () => {
    const vars = names.slice(1);
    for (const name of vars) process.env[name] = '7';
    expect(loadAgentConfig().agent).toHaveProperty('planBudget', {
      maxSteps: 7,
      maxRevisions: 7,
      maxDurationMs: 7,
    });
    for (const name of vars) {
      for (const bad of ['x', '0', '-1', '1.5']) {
        process.env[name] = bad;
        expect(() => loadAgentConfig()).toThrow(name);
      }
      process.env[name] = '7';
    }
  });
  it('unset plan budget leaves planBudget fields undefined', () => {
    expect(loadAgentConfig().agent).toHaveProperty('planBudget', {
      maxSteps: undefined,
      maxRevisions: undefined,
      maxDurationMs: undefined,
    });
  });
});

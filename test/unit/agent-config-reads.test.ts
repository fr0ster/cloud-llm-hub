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

import { getAvailableModels } from '../../srv/lib/ai-core-models';

// The model list reads the LLM settings it is handed, not process.env.
describe('getAvailableModels', () => {
  it('answers the configured model when a non-AI-Core provider has no API key', async () => {
    const saved = process.env.LLM_AGENT_MODEL;
    process.env.LLM_AGENT_MODEL = 'not-this-one';
    try {
      const models = await getAvailableModels({
        provider: 'openai',
        model: 'configured-model',
      });
      expect(models).toEqual([
        {
          id: 'configured-model',
          object: 'model',
          created: 0,
          owned_by: 'openai',
        },
      ]);
    } finally {
      if (saved === undefined) delete process.env.LLM_AGENT_MODEL;
      else process.env.LLM_AGENT_MODEL = saved;
    }
  });
});

jest.mock('../../srv/lib/btp-oauth', () => ({
  getServiceCredentials: () => ({ uri: 'https://ai-core.example' }),
  getToken: async () => 'token',
}));

import { getAvailableModels } from '../../srv/lib/ai-core-models';

// An orchestration-only AI Core tenant lists no per-model deployments.
describe('getAvailableModels on an orchestration-only tenant', () => {
  const savedFetch = global.fetch;
  afterEach(() => {
    global.fetch = savedFetch;
  });

  it('answers the configured model instead of an empty list', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        resources: [
          {
            id: 'd1',
            configurationName: 'defaultOrchestrationConfig',
            status: 'RUNNING',
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const models = await getAvailableModels({
      provider: 'sap-ai-sdk',
      model: 'anthropic--claude-4.5-sonnet',
    });

    expect(models).toEqual([
      {
        id: 'anthropic--claude-4.5-sonnet',
        object: 'model',
        created: 0,
        owned_by: 'sap-ai-core',
      },
    ]);
  });
});

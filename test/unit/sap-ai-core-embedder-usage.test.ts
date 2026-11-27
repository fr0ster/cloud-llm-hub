import type { IUsageRecorder } from '@mcp-abap-adt/llm-agent';
import { buildDestination } from '@mcp-abap-adt/sap-aicore-llm';
import {
  AzureOpenAiEmbeddingClient,
  AzureOpenAiEmbeddingResponse,
} from '@sap-ai-sdk/foundation-models';
import {
  OrchestrationEmbeddingClient,
  OrchestrationEmbeddingResponse,
} from '@sap-ai-sdk/orchestration';
import { SapAiCoreEmbedder } from '../../srv/lib/sap-ai-core-embedder';

jest.mock('@mcp-abap-adt/sap-aicore-llm', () => ({
  ...jest.requireActual<typeof import('@mcp-abap-adt/sap-aicore-llm')>(
    '@mcp-abap-adt/sap-aicore-llm',
  ),
  buildDestination: jest.fn(),
}));

const model = 'text-embedding-3-small';
const data = [{ embedding: [1, 2], index: 0, object: 'embedding' }];

function mockFoundationModels(usage?: {
  prompt_tokens: number;
  total_tokens?: number;
}) {
  jest.mocked(buildDestination).mockResolvedValue({
    url: 'https://aicore.invalid',
    authentication: 'NoAuthentication',
    headers: {},
  });
  jest.spyOn(AzureOpenAiEmbeddingClient.prototype, 'run').mockResolvedValue(
    new AzureOpenAiEmbeddingResponse({
      data: { data, usage },
      headers: {},
      status: 200,
      request: {},
    }),
  );
}

function mockOrchestration(usage?: {
  prompt_tokens: number;
  total_tokens?: number;
}) {
  jest.spyOn(OrchestrationEmbeddingClient.prototype, 'embed').mockResolvedValue(
    new OrchestrationEmbeddingResponse({
      data: { final_result: { data, usage } },
      headers: {},
      status: 200,
      request: {},
    }),
  );
}

afterEach(() => jest.restoreAllMocks());

describe.each([
  {
    name: 'foundation-models',
    scenario: 'foundation-models',
    mock: mockFoundationModels,
  },
  { name: 'orchestration', scenario: undefined, mock: mockOrchestration },
] as const)('$name usage', ({ scenario, mock }) => {
  test.each([false, true])(
    'returns provider counts with recorder=%s',
    async (recordUsage) => {
      mock({ prompt_tokens: 3, total_tokens: 5 });
      const record = jest.fn<void, Parameters<IUsageRecorder['record']>>();
      const recorder: IUsageRecorder = { record, with: () => recorder };
      const embedder = new SapAiCoreEmbedder({ model, scenario });

      await expect(
        embedder.embed(
          'ABAP source',
          recordUsage ? { usage: recorder } : undefined,
        ),
      ).resolves.toEqual({
        vector: [1, 2],
        usage: { promptTokens: 3, totalTokens: 5 },
      });
      if (recordUsage) {
        expect(record).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'embedding.call',
            outcome: 'ok',
            inputTokens: 3,
            tokensSource: 'provider',
          }),
        );
      }
    },
  );

  test('uses the input count when the provider omits the total', async () => {
    mock({ prompt_tokens: 0 });
    await expect(
      new SapAiCoreEmbedder({ model, scenario }).embed(''),
    ).resolves.toEqual({
      vector: [1, 2],
      usage: { promptTokens: 0, totalTokens: 0 },
    });
  });

  test('leaves usage absent when the provider omits it', async () => {
    mock();
    await expect(
      new SapAiCoreEmbedder({ model, scenario }).embed('ABAP source'),
    ).resolves.toEqual({
      vector: [1, 2],
    });
  });
});

import { LlmError, MODEL_CONTEXT_EXCEEDED } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { OpenAiEmbedder } from '@mcp-abap-adt/openai-embedder';
import cds from '@sap/cds';
import { getDestination } from '@sap-cloud-sdk/connectivity';
import { clearAgentConfig } from '../../srv/agent-config';
import * as manager from '../../srv/agent-manager';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import * as destinationResolver from '../../srv/connections/destinationResolver';
import * as destinations from '../../srv/lib/btp-destinations';
import * as llmFactory from '../../srv/lib/llm-factory';
import {
  longSessions,
  longSessionsIfReady,
  setLongSessionsForTest,
} from '../../srv/lib/long-session';
import * as requestConnection from '../../srv/lib/request-connection';
import { handleChatCompletions } from '../../srv/openai-handler';
import { liveSession } from './helpers/canonical-rag';
import { fakeReq, fakeRes } from './helpers/channel-harness';
import { initInMemoryProviders } from './helpers/providers';
import { typedRequest, typedResponse } from './helpers/response-model';

jest.mock('@sap-cloud-sdk/connectivity', () => ({
  ...jest.requireActual<typeof import('@sap-cloud-sdk/connectivity')>(
    '@sap-cloud-sdk/connectivity',
  ),
  getDestination: jest.fn(),
}));

beforeEach(() => {
  initInMemoryProviders();
  const context = new cds.EventContext({ event: 'chat' });
  context.user = new cds.User('alice');
  jest.spyOn(cds, 'context', 'get').mockReturnValue(context);
  jest.spyOn(manager, 'isAgentReady').mockReturnValue(true);
  jest.spyOn(destinations, 'getAvailableDestinations').mockResolvedValue([]);
  jest
    .spyOn(destinationResolver, 'resolveDestinationSapConfig')
    .mockResolvedValue({
      destinationName: 'DEST',
      sapConfig: { url: 'https://sap.invalid', authType: 'basic' },
    });
  jest
    .spyOn(requestConnection, 'establishRequestConnection')
    .mockResolvedValue({ handled: false });
  const unexpectedModelCall = async () => {
    throw new Error('Unexpected model call');
  };
  jest.spyOn(llmFactory, 'makeHubLlm').mockResolvedValue({
    chat: unexpectedModelCall,
    async *streamChat() {
      yield await unexpectedModelCall();
    },
  });
});

afterEach(async () => {
  await longSessionsIfReady()?.closeAll('shutdown');
  setLongSessionsForTest(undefined);
  manager.clearDestinationStatesForTest();
  jest.restoreAllMocks();
  clearAgentConfig();
});

async function request(
  handler: typeof handleChatCompletions,
  stream: boolean,
  early = false,
) {
  const res = fakeRes();
  const key = early ? liveSession('alice', 'init') : 'init';
  const req = typedRequest(
    fakeReq(
      {
        model: manager.getCurrentModel(),
        max_tokens: 100,
        stream,
        messages: [{ role: 'user', content: 'hello' }],
      },
      key,
      !early,
    ),
  );
  if (early)
    Object.assign(req, { longSession: longSessions().get('alice', key) });
  await handler(req, typedResponse(res));
  return res;
}

it.each([false, true])(
  'returns HTTP 400 for a new or cached destination build overflow (stream=%s)',
  async (stream) => {
    const build = jest.spyOn(SmartAgentBuilder.prototype, 'build');
    build.mockRejectedValueOnce(
      new Error('private wrapper', {
        cause: new LlmError('private model context', MODEL_CONTEXT_EXCEEDED),
      }),
    );

    const openai = await request(handleChatCompletions, stream);
    expect(openai.statusCode).toBe(400);
    expect(JSON.parse(openai.body)).toEqual({
      error: {
        message: 'Запит перевищує контекст моделі',
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    });
    if (stream) expect(openai.headers['X-SAP-Active-Destination']).toBe('DEST');
    expect(manager.getDestinationStates()).toEqual([
      expect.objectContaining({
        name: 'DEST',
        status: 'error',
        error: 'Запит перевищує контекст моделі',
      }),
    ]);

    const anthropic = await request(handleAnthropicMessages, stream);
    expect(anthropic.statusCode).toBe(400);
    expect(JSON.parse(anthropic.body)).toEqual({
      type: 'error',
      error: {
        code: MODEL_CONTEXT_EXCEEDED,
        message: 'Запит перевищує контекст моделі',
        type: 'invalid_request_error',
      },
    });
    expect(build).toHaveBeenCalledTimes(1);
  },
);

it('keeps ordinary destination build failures on the established HTTP 503 path', async () => {
  jest
    .spyOn(SmartAgentBuilder.prototype, 'build')
    .mockRejectedValueOnce(new Error('agent build failed'));

  const res = await request(handleChatCompletions, false);
  expect(res.statusCode).toBe(503);
  expect(JSON.parse(res.body)).toMatchObject({
    error: {
      type: 'destination_unreachable',
      code: 'destination_unreachable',
      message: 'Agent initialization failed.',
      destination: 'DEST',
      destination_status: 'error',
    },
  });
  const anthropic = await request(handleAnthropicMessages, false);
  expect(anthropic.statusCode).toBe(503);
  expect(JSON.parse(anthropic.body)).toEqual({
    type: 'error',
    error: {
      type: 'api_error',
      code: 'destination_unreachable',
      message: 'Agent initialization failed.',
    },
  });
});

it('keeps the resolver diagnostic in both 503 responses and destination state', async () => {
  jest.mocked(destinationResolver.resolveDestinationSapConfig).mockRestore();
  jest
    .mocked(getDestination)
    .mockResolvedValueOnce({ url: 'https://sap.invalid' });
  const message = 'Destination "DEST" is missing Authentication property.';

  for (const handler of [handleChatCompletions, handleAnthropicMessages]) {
    const res = await request(handler, false);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: { message } });
  }
  expect(manager.getDestinationStates()).toEqual([
    expect.objectContaining({ name: 'DEST', status: 'error', error: message }),
  ]);
});

it.each([false, true])(
  'keeps a build throttle on the initialization 503 path (stream=%s)',
  async (stream) => {
    const privateBody = 'PRIVATE_INIT_THROTTLE_BODY';
    const build = jest
      .spyOn(SmartAgentBuilder.prototype, 'build')
      .mockRejectedValueOnce(
        Object.assign(new LlmError(privateBody), {
          status: 429,
          throttled: true,
          retryAfterSeconds: 41.5,
        }),
      );
    for (const handler of [handleChatCompletions, handleAnthropicMessages]) {
      const res = await request(handler, stream);
      expect(res.statusCode).toBe(503);
      expect(res.headers['Retry-After']).toBe('42');
      expect(JSON.parse(res.body)).toMatchObject({
        error: {
          code: 'LLM_ERROR',
          message:
            'Agent initialization failed. The AI service is rate-limited right now. Please try again in about 42 seconds.',
        },
      });
      expect(res.body).not.toContain(privateBody);
    }
    expect(build).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(manager.getDestinationStates())).not.toContain(
      privateBody,
    );
  },
);

it.each([
  { stream: false, early: false },
  { stream: true, early: false },
  { stream: true, early: true },
])(
  'maps an embedder HTTP 401 for both APIs (stream=$stream, SSE open=$early)',
  async ({ stream, early }) => {
    if (early) {
      jest.replaceProperty(process, 'env', {
        ...process.env,
        LLM_AGENT_CHAT_COORDINATOR: 'dialogue',
      });
      clearAgentConfig();
    }
    const privateBody = 'PRIVATE_INIT_PROVIDER_BODY';
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(privateBody, { status: 401 }),
      );
    const embedder = new OpenAiEmbedder({
      model: 'test-embedder',
      credential: { kind: 'api-key', secret: async () => 'test-key' },
    });
    const build = jest
      .spyOn(SmartAgentBuilder.prototype, 'build')
      .mockImplementationOnce(async () => {
        await embedder.embed('build input');
        throw new Error('Expected embedder failure');
      });
    const managerLog = jest
      .spyOn(cds.log('agent-manager'), 'error')
      .mockImplementation(() => {});
    const openaiLog = jest
      .spyOn(cds.log('openai-handler'), 'error')
      .mockImplementation(() => {});
    const anthropicLog = jest
      .spyOn(cds.log('anthropic-handler'), 'error')
      .mockImplementation(() => {});

    for (const [handler, type] of [
      [handleChatCompletions, 'server_error'],
      [handleAnthropicMessages, 'api_error'],
    ] as const) {
      const res = await request(handler, stream, early);
      expect(res.statusCode).toBe(early ? 200 : 503);
      expect(res.body).not.toContain(privateBody);
      const errorLine = res.body
        .split('\n')
        .find((line) => line.startsWith('data: '));
      if (early) expect(res.body).toContain('event: error\n');
      expect(
        JSON.parse(errorLine?.slice('data: '.length) ?? res.body),
      ).toMatchObject({
        error: {
          type,
          code: 'EMBED_ERROR',
          message: 'Embedding request failed.',
        },
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(manager.getDestinationStates()).toEqual([
      expect.objectContaining({
        name: 'DEST',
        status: 'error',
        error: 'Embedding request failed.',
      }),
    ]);
    for (const log of [managerLog, openaiLog, anthropicLog]) {
      expect(log.mock.calls).toEqual([
        [
          'Destination initialization failed',
          { code: 'EMBED_ERROR', status: 401, destination: 'DEST' },
        ],
      ]);
    }
  },
);

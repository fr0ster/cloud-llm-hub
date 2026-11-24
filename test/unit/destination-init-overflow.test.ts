import { LlmError, MODEL_CONTEXT_EXCEEDED } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';
import * as manager from '../../srv/agent-manager';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import * as destinationResolver from '../../srv/connections/destinationResolver';
import * as destinations from '../../srv/lib/btp-destinations';
import * as llmFactory from '../../srv/lib/llm-factory';
import * as requestConnection from '../../srv/lib/request-connection';
import { handleChatCompletions } from '../../srv/openai-handler';
import { fakeReq, fakeRes } from './helpers/channel-harness';
import { initInMemoryProviders } from './helpers/providers';
import { typedRequest, typedResponse } from './helpers/response-model';

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

afterEach(() => {
  manager.clearDestinationStatesForTest();
  jest.restoreAllMocks();
});

async function request(handler: typeof handleChatCompletions, stream: boolean) {
  const res = fakeRes();
  const req = fakeReq({
    model: manager.getCurrentModel(),
    max_tokens: 100,
    stream,
    messages: [{ role: 'user', content: 'hello' }],
  });
  await handler(typedRequest(req), typedResponse(res));
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
      message: 'Destination "DEST" is error: agent build failed',
      destination: 'DEST',
      destination_status: 'error',
    },
  });
});

import {
  beginLlmRequest,
  type CallOptions,
  type ILlm,
  type LlmResponse,
  type Message,
  requestShape,
  startOperation,
} from '@mcp-abap-adt/llm-agent';

/** Fake transport around the real usage hooks, shared with the propagation test. */
export function fakePipelineLlm(
  answer: (messages: Message[], options?: CallOptions) => LlmResponse,
  beforeChat?: (
    messages: Message[],
    tools: Parameters<ILlm['chat']>[1],
    options?: CallOptions,
  ) => Promise<void>,
): ILlm {
  return {
    model: 'fake',
    async chat(
      messages: Message[],
      tools: Parameters<ILlm['chat']>[1],
      options?: CallOptions,
    ) {
      if (beforeChat) await beforeChat(messages, tools, options);
      const call = beginLlmRequest(options, startOperation(options), {
        ...requestShape(messages, tools),
        provider: 'fake',
        model: 'fake',
        stream: false,
        granularity: 'request',
        retriesVisible: true,
      });
      try {
        return { ok: true, value: answer(messages, options) };
      } finally {
        call.end({ outcome: 'ok' });
      }
    },
    async *streamChat(
      messages: Message[],
      tools: Parameters<ILlm['chat']>[1],
      options?: CallOptions,
    ) {
      const result = await this.chat(messages, tools, options);
      if (result.ok)
        yield {
          ok: true,
          value: {
            content: result.value.content,
            finishReason: result.value.finishReason,
            toolCalls: result.value.toolCalls,
          },
        };
    },
  };
}

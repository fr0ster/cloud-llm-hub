import type { FinalizerInput } from '@mcp-abap-adt/llm-agent';
import { NoticeFinalizer } from '../../srv/lib/notice-finalizer';
import { renderNotice } from '../../srv/lib/notify-policy';
import { RecordingRequestLogger } from '../../srv/lib/recording-request-logger';

function baseInput(overrides: Partial<FinalizerInput>): FinalizerInput {
  return {
    prompt: 'prompt',
    objective: 'objective',
    interpreterOutput: '',
    executionTrace: [],
    ...overrides,
  };
}

describe('renderNotice', () => {
  it('returns empty string for an ok verdict', () => {
    expect(renderNotice({ ok: true })).toBe('');
  });

  it('starts with the exact UNVERIFIED_WRITE: marker for a problem verdict', () => {
    const notice = renderNotice({
      ok: false,
      issues: [
        {
          kind: 'unverified-write',
          claimedOp: 'activated',
          expectedToolFamily: 'Activate*',
          observedTools: ['CreateDomain'],
        },
      ],
    });
    expect(notice.startsWith('UNVERIFIED_WRITE:')).toBe(true);
    expect(notice).toMatch(/activated/);
    expect(notice).toMatch(/Activate\*/);
    expect(notice).toMatch(/CreateDomain/);
  });
});

describe('NoticeFinalizer', () => {
  const benignLlm = {
    chat: jest.fn(async () => ({
      ok: true as const,
      value: {
        content:
          '{"possiblyFake": false, "confidence": "low", "reasons": "ok"}',
      },
    })),
    streamChat: async function* () {},
  };

  beforeEach(() => {
    benignLlm.chat.mockClear();
  });

  it('(a) emits a single UNVERIFIED_WRITE notice when the claim outruns the executed tools', async () => {
    const recLogger = new RecordingRequestLogger();
    recLogger.startRequest('t1');
    recLogger.logToolCall({
      requestId: 't1',
      toolName: 'CreateDomain',
      success: true,
      durationMs: 10,
      cached: false,
    });
    recLogger.logLlmCall({
      requestId: 't1',
      component: 'tool-loop',
      model: 'gpt',
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
      durationMs: 5,
    });

    const finalizer = new NoticeFinalizer(recLogger, benignLlm as never);
    const onPartial = jest.fn();
    const input = baseInput({
      interpreterOutput: 'The domain was created and activated successfully.',
      trace: { traceId: 't1' },
      onPartial,
    });

    const result = await finalizer.finalize(input);

    expect(onPartial).toHaveBeenCalledTimes(1);
    const chunk = onPartial.mock.calls[0][0];
    expect(chunk.kind).toBe('content');
    expect(chunk.delta.startsWith('UNVERIFIED_WRITE:')).toBe(true);
    expect(chunk.delta).toMatch(/activated/);
    expect(chunk.delta).toMatch(/Activate\*/);
    expect(result.output).toBe(input.interpreterOutput);
  });

  it('(b) does not emit a notice when both write ops are backed by executed tools', async () => {
    const recLogger = new RecordingRequestLogger();
    recLogger.startRequest('t1');
    recLogger.logToolCall({
      requestId: 't1',
      toolName: 'CreateDomain',
      success: true,
      durationMs: 10,
      cached: false,
    });
    recLogger.logToolCall({
      requestId: 't1',
      toolName: 'ActivateDomain',
      success: true,
      durationMs: 10,
      cached: false,
    });

    const finalizer = new NoticeFinalizer(recLogger, benignLlm as never);
    const onPartial = jest.fn();
    const input = baseInput({
      interpreterOutput: 'The domain was created and activated successfully.',
      trace: { traceId: 't1' },
      onPartial,
    });

    const result = await finalizer.finalize(input);

    expect(onPartial).not.toHaveBeenCalled();
    expect(result.output).toBe(input.interpreterOutput);
  });

  it('(c) fires the deterministic notice on high tokens/tool-calls WITHOUT invoking the LLM critic', async () => {
    const recLogger = new RecordingRequestLogger();
    recLogger.startRequest('t1');
    // Two tool calls (toolCallCount=2 > maxToolCalls default 1) — only a
    // create-family tool, no Activate*, so the deterministic verdict must
    // still fire on the "activated" claim.
    recLogger.logToolCall({
      requestId: 't1',
      toolName: 'CreateDomain',
      success: true,
      durationMs: 10,
      cached: false,
    });
    recLogger.logToolCall({
      requestId: 't1',
      toolName: 'ReadDomain',
      success: true,
      durationMs: 10,
      cached: false,
    });
    // High tokens (>= default minTokens 1500) so the gate is not suspicious.
    recLogger.logLlmCall({
      requestId: 't1',
      component: 'tool-loop',
      model: 'gpt',
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
      durationMs: 5,
    });

    const finalizer = new NoticeFinalizer(recLogger, benignLlm as never);
    const onPartial = jest.fn();
    const input = baseInput({
      interpreterOutput: 'The domain was created and activated successfully.',
      trace: { traceId: 't1' },
      onPartial,
    });

    const result = await finalizer.finalize(input);

    expect(onPartial).toHaveBeenCalledTimes(1);
    const chunk = onPartial.mock.calls[0][0];
    expect(chunk.delta.startsWith('UNVERIFIED_WRITE:')).toBe(true);
    expect(benignLlm.chat).not.toHaveBeenCalled();
    expect(result.output).toBe(input.interpreterOutput);
  });

  it('(d) never emits interpreterOutput via onPartial — notice-only, no duplication', async () => {
    const recLogger = new RecordingRequestLogger();
    recLogger.startRequest('t1');
    recLogger.logToolCall({
      requestId: 't1',
      toolName: 'CreateDomain',
      success: true,
      durationMs: 10,
      cached: false,
    });

    const finalizer = new NoticeFinalizer(recLogger, benignLlm as never);
    const onPartial = jest.fn();
    const input = baseInput({
      interpreterOutput: 'The domain was created and activated successfully.',
      trace: { traceId: 't1' },
      onPartial,
    });

    const result = await finalizer.finalize(input);

    for (const call of onPartial.mock.calls) {
      expect(call[0].delta).not.toContain(input.interpreterOutput);
    }
    expect(result.output).toBe(input.interpreterOutput);
  });
});

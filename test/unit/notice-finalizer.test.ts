import type { FinalizerInput, IMcpClient } from '@mcp-abap-adt/llm-agent';
import { NoticeFinalizer } from '../../srv/lib/notice-finalizer';
import { renderNotice } from '../../srv/lib/notify-policy';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';

function baseInput(overrides: Partial<FinalizerInput>): FinalizerInput {
  return {
    prompt: 'prompt',
    objective: 'objective',
    interpreterOutput: '',
    executionTrace: [],
    ...overrides,
  };
}

function fakeInner(): IMcpClient {
  return {
    listTools: jest.fn(),
    callTool: jest.fn(),
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
          reason:
            'claims "activated" but no tool result shows status:\'active\'',
        },
      ],
    });
    expect(notice.startsWith('UNVERIFIED_WRITE:')).toBe(true);
    expect(notice).toMatch(/activated/);
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

  it('(a) emits a single UNVERIFIED_WRITE notice when the claim outruns the tool RESULT (activate:false lie)', async () => {
    const recMcp = new RecordingMcpClient(fakeInner());
    jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([
      {
        call: { id: '', name: 'CreateDomain', arguments: {} },
        result: { content: '{"success":true,"status":"inactive"}' },
      },
    ]);

    const finalizer = new NoticeFinalizer(recMcp, benignLlm as never);
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
    expect(result.output).toBe(input.interpreterOutput);
  });

  it('(b) does not emit a notice when the tool RESULT shows status:active — CreateDomain(activate:true default) is the ex-false-positive, now clean', async () => {
    const recMcp = new RecordingMcpClient(fakeInner());
    jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([
      {
        call: { id: '', name: 'CreateDomain', arguments: {} },
        result: { content: '{"success":true,"status":"active"}' },
      },
    ]);

    const finalizer = new NoticeFinalizer(recMcp, benignLlm as never);
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

  it('(c) fires the deterministic notice with MANY tool calls (above the toolCallCount gate) WITHOUT invoking the LLM critic', async () => {
    const recMcp = new RecordingMcpClient(fakeInner());
    // toolCallCount=2 > maxToolCalls default 1 — only a create-family tool
    // (status:inactive), no Activate*/status:active — deterministic must
    // still fire on the "activated" claim, and the gate must not invoke the LLM.
    jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([
      {
        call: { id: '', name: 'CreateDomain', arguments: {} },
        result: { content: '{"success":true,"status":"inactive"}' },
      },
      {
        call: { id: '', name: 'ReadDomain', arguments: {} },
        result: { content: '{"success":true}' },
      },
    ]);

    const finalizer = new NoticeFinalizer(recMcp, benignLlm as never);
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
    const recMcp = new RecordingMcpClient(fakeInner());
    jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([
      {
        call: { id: '', name: 'CreateDomain', arguments: {} },
        result: { content: '{"success":true,"status":"active"}' },
      },
    ]);

    const finalizer = new NoticeFinalizer(recMcp, benignLlm as never);
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

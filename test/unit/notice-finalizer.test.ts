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

  // Under the DAG coordinator (llm-agent #166) the interpreter's onPartial goes
  // to the session log ONLY — the FINALIZER's onPartial is the single
  // client-facing content source (streaming AND the accumulated process()
  // result). So the finalizer MUST re-emit interpreterOutput as content first,
  // then any trailing notice.

  it('(a) emits the answer content FIRST, then a single trailing UNVERIFIED_WRITE notice when the claim outruns the tool RESULT', async () => {
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

    expect(onPartial).toHaveBeenCalledTimes(2);
    // [0] = the executor's answer (client-facing content)
    expect(onPartial.mock.calls[0][0].kind).toBe('content');
    expect(onPartial.mock.calls[0][0].delta).toBe(input.interpreterOutput);
    // [1] = the trailing honesty notice
    expect(onPartial.mock.calls[1][0].kind).toBe('content');
    expect(
      onPartial.mock.calls[1][0].delta.startsWith('UNVERIFIED_WRITE:'),
    ).toBe(true);
    expect(onPartial.mock.calls[1][0].delta).toMatch(/activated/);
    expect(result.output).toBe(input.interpreterOutput);
  });

  it('(b) emits ONLY the answer content (no notice) when the tool RESULT shows status:active — CreateDomain(activate:true) is clean', async () => {
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

    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial.mock.calls[0][0].kind).toBe('content');
    expect(onPartial.mock.calls[0][0].delta).toBe(input.interpreterOutput);
    expect(result.output).toBe(input.interpreterOutput);
  });

  it('(c) fires the deterministic trailing notice with MANY tool calls (above the toolCallCount gate) WITHOUT invoking the LLM critic — answer still comes first', async () => {
    const recMcp = new RecordingMcpClient(fakeInner());
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

    expect(onPartial).toHaveBeenCalledTimes(2);
    expect(onPartial.mock.calls[0][0].delta).toBe(input.interpreterOutput);
    expect(
      onPartial.mock.calls[1][0].delta.startsWith('UNVERIFIED_WRITE:'),
    ).toBe(true);
    expect(benignLlm.chat).not.toHaveBeenCalled();
    expect(result.output).toBe(input.interpreterOutput);
  });

  it('(d) re-emits interpreterOutput as the client-facing content (single source under DAG #166) — no answer is lost', async () => {
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

    await finalizer.finalize(input);

    const contentDeltas = onPartial.mock.calls
      .map((c) => c[0])
      .filter((chunk) => chunk.kind === 'content')
      .map((chunk) => chunk.delta);
    expect(contentDeltas).toContain(input.interpreterOutput);
  });

  it('(e) emits nothing when the executor produced no output and there is no contradiction (empty answer stays empty, no stray delta)', async () => {
    const recMcp = new RecordingMcpClient(fakeInner());
    jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([]);

    const finalizer = new NoticeFinalizer(recMcp, benignLlm as never);
    const onPartial = jest.fn();
    const input = baseInput({
      interpreterOutput: '',
      trace: { traceId: 't1' },
      onPartial,
    });

    const result = await finalizer.finalize(input);

    expect(onPartial).not.toHaveBeenCalled();
    expect(result.output).toBe('');
  });
});

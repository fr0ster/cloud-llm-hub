import type {
  FinalizerInput,
  ILlm,
  IMcpClient,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import type { WriteClaim } from '../../srv/lib/checker-verdict-schema';
import { NoticeFinalizer } from '../../srv/lib/notice-finalizer';
import { renderNotice } from '../../srv/lib/notify-policy';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { recordToolScore } from '../../srv/lib/review-scope';
import { runWithSessionId } from '../../srv/request-session';

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

  it('opts into live interpreter content streaming', () => {
    const finalizer = new NoticeFinalizer(new RecordingMcpClient(fakeInner()));
    expect(finalizer.streamsInterpreterContent).toBe(true);
  });

  it('emits only the trailing NOTICE when the full answer was streamed', async () => {
    const recMcp = new RecordingMcpClient(fakeInner());
    jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([
      {
        call: { id: '', name: 'CreateDomain', arguments: {} },
        result: { content: '{"success":true,"status":"inactive"}' },
      },
    ]);
    const finalizer = new NoticeFinalizer(recMcp);
    const onPartial = jest.fn();
    const input = baseInput({
      interpreterOutput: 'The domain was created and activated successfully.',
      interpreterContentStreamed: true,
      onPartial,
    });
    expect(await finalizer.finalize(input)).toEqual({
      output: input.interpreterOutput,
    });
    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(onPartial).toHaveBeenCalledWith({
      kind: 'content',
      delta: expect.stringMatching(/^UNVERIFIED_WRITE:/),
    });
  });

  it('warns about a failed SAP domain create even when a same-named RAG record was added', async () => {
    const recorder = new RecordingMcpClient(fakeInner());
    jest.spyOn(recorder, 'getToolRecords').mockReturnValue([
      {
        call: {
          id: 'rag',
          name: 'record_add',
          arguments: { collection: 'drafts', record: 'ZREQ' },
        },
        result: {
          content: { collection: 'drafts', record: 'ZREQ', created: true },
        },
      },
      {
        call: {
          id: 'sap',
          name: 'CreateDomain',
          arguments: { domain_name: 'ZREQ' },
        },
        result: { content: { success: false, error: 'Domain already exists' } },
      },
    ]);
    const onPartial = jest.fn();
    await new NoticeFinalizer(recorder).finalize(
      baseInput({ interpreterOutput: 'I created SAP domain ZREQ.', onPartial }),
    );
    expect(onPartial).toHaveBeenLastCalledWith({
      kind: 'content',
      delta: expect.stringMatching(
        /^UNVERIFIED_WRITE:.*CreateDomain returned error: Domain already exists/,
      ),
    });
  });

  it('(a) emits the answer content FIRST, then a single trailing UNVERIFIED_WRITE notice when the claim outruns the tool RESULT', async () => {
    const recMcp = new RecordingMcpClient(fakeInner());
    jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([
      {
        call: { id: '', name: 'CreateDomain', arguments: {} },
        result: { content: '{"success":true,"status":"inactive"}' },
      },
    ]);

    const finalizer = new NoticeFinalizer(recMcp);
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

    const finalizer = new NoticeFinalizer(recMcp);
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

  it('(c) fires the deterministic trailing notice with MANY tool calls — answer still comes first', async () => {
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

    const finalizer = new NoticeFinalizer(recMcp);
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

  it.each([false, undefined])(
    'emits the answer once when interpreterContentStreamed is %s',
    async (interpreterContentStreamed) => {
      const recMcp = new RecordingMcpClient(fakeInner());
      jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([
        {
          call: { id: '', name: 'CreateDomain', arguments: {} },
          result: { content: '{"success":true,"status":"active"}' },
        },
      ]);

      const finalizer = new NoticeFinalizer(recMcp);
      const onPartial = jest.fn();
      const input = baseInput({
        interpreterOutput: 'The domain was created and activated successfully.',
        interpreterContentStreamed,
        trace: { traceId: 't1' },
        onPartial,
      });

      await finalizer.finalize(input);

      const contentDeltas = onPartial.mock.calls
        .map((c) => c[0])
        .filter((chunk) => chunk.kind === 'content')
        .map((chunk) => chunk.delta);
      expect(contentDeltas).toEqual([input.interpreterOutput]);
    },
  );

  it('(e) emits nothing when the executor produced no output and there is no contradiction (empty answer stays empty, no stray delta)', async () => {
    const recMcp = new RecordingMcpClient(fakeInner());
    jest.spyOn(recMcp, 'getToolRecords').mockReturnValue([]);

    const finalizer = new NoticeFinalizer(recMcp);
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

test('NoticeFinalizer never invokes a critic, even for SAP answers without tools', async () => {
  const finalizer = new NoticeFinalizer(new RecordingMcpClient(fakeInner()));
  await runWithSessionId('sap', async () => {
    recordToolScore(1);
    const onPartial = jest.fn();
    await finalizer.finalize(
      baseInput({
        prompt: 'List ZOBJECT objects',
        interpreterOutput: 'Here they are.',
        onPartial,
      }),
    );
    expect(onPartial).toHaveBeenCalledTimes(1);
  });
});

describe('adaptive write review', () => {
  const scope = 'user';
  const sapClaim = {
    system: 'sap',
    operation: 'created',
    target: { type: 'domain', name: 'ZREQ' },
  } satisfies WriteClaim;
  const persist: ToolCallRecord = {
    call: {
      id: 'persist',
      name: 'rag_persist',
      arguments: {
        from: { scope: 'session', collection: 'drafts' },
        to: { scope, collection: 'a' },
      },
    },
    result: { content: { scope, collection: 'a', records: ['ZREQ'] } },
  };
  const read: ToolCallRecord = {
    call: {
      id: 'read',
      name: 'rag_read',
      arguments: { collection: { scope, collection: 'a' }, id: 'ZREQ' },
    },
    result: { content: { id: 'ZREQ', text: 'Detailed requirements' } },
  };
  const failedCreate: ToolCallRecord = {
    call: {
      id: 'sap',
      name: 'CreateDomain',
      arguments: { domain_name: 'ZREQ' },
    },
    result: {
      content: JSON.stringify({
        content: [
          { type: 'text', text: 'Tool diagnostics' },
          { type: 'text', text: '{"success":false}' },
        ],
      }),
    },
  };
  const ragClaim = {
    system: 'rag',
    operation: 'persisted',
    target: { scope, collection: 'a', record: 'ZREQ' },
    callId: 'persist',
  } satisfies WriteClaim;
  const collection = 'drafts__u_1234567890abcdef';

  async function review(
    recorder: RecordingMcpClient,
    claims: WriteClaim[] | undefined,
    interpreterOutput = 'Here is the result.',
  ) {
    const chat = jest.fn<ReturnType<ILlm['chat']>, Parameters<ILlm['chat']>>();
    chat.mockResolvedValue({
      ok: true,
      value: {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'verdict',
            name: 'submit_verdict',
            arguments: { verdict: 'pass', claims },
          },
        ],
      },
    });
    const finalizer = new NoticeFinalizer(recorder, {
      checker: async () => ({
        llm: { chat, streamChat: async function* () {} },
        systemPrompt: 'Checker profile',
      }),
      isSapWriteTool: (name) =>
        ['CreateDomain', 'CreateTransport', 'CreateTransportTask'].includes(
          name,
        ),
    });
    const onPartial = jest.fn();
    const result = await finalizer.finalize(
      baseInput({
        interpreterOutput,
        trace: { traceId: 'adaptive' },
        onPartial,
      }),
    );
    return { ...result, chat, onPartial };
  }

  it('sends the full journal and accepts a RAG persist citation followed by read-back', async () => {
    const recorder = new RecordingMcpClient(fakeInner());
    const journal = [persist, read];
    jest.spyOn(recorder, 'getToolJournal').mockReturnValue(journal);
    const response = 'I saved the record ZREQ to user/a and read it back.';
    const { chat, onPartial, output } = await review(
      recorder,
      [ragClaim],
      response,
    );
    expect(chat.mock.calls[0][0][1].content).toBe(
      JSON.stringify({ response, journal, sapObjectTypes: {} }),
    );
    expect(onPartial).toHaveBeenCalledTimes(1);
    expect(output).toBe(response);
  });

  it.each([
    [
      'failed SAP call',
      { ...sapClaim, callId: 'sap' },
      'CreateDomain did not succeed',
    ],
    [
      'wrong system',
      { ...sapClaim, callId: 'persist' },
      'rag_persist is not a SAP write',
    ],
    [
      'wrong collection',
      { ...ragClaim, target: { ...ragClaim.target, collection: 'b' } },
      'RAG persisted user/b/ZREQ',
    ],
    [
      'wrong scope',
      { ...ragClaim, target: { ...ragClaim.target, scope: 'session' } },
      'RAG persisted session/a/ZREQ',
    ],
    [
      'read-back citation',
      { ...ragClaim, callId: 'read' },
      'rag_read is not a RAG write',
    ],
    ['uncited write', sapClaim, 'no write call cited'],
    [
      'missing call',
      { ...sapClaim, callId: 'missing' },
      'call missing is absent',
    ],
  ] satisfies [string, WriteClaim, string][])(
    'warns about a %s',
    async (_name, claim, reason) => {
      const recorder = new RecordingMcpClient(fakeInner());
      jest
        .spyOn(recorder, 'getToolJournal')
        .mockReturnValue([failedCreate, persist, read]);
      const { onPartial, output } = await review(recorder, [claim]);
      expect(output).toContain('UNVERIFIED_WRITE:');
      expect(output).toContain(reason);
      expect(onPartial).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['collection_delete', 'deleted', {}, { collection, deleted: true }],
    [
      'collection_set_enabled',
      'enabled',
      { enabled: true },
      { id: collection, enabled: true },
    ],
    [
      'collection_set_enabled',
      'disabled',
      { enabled: false },
      { id: collection, enabled: false },
    ],
  ] satisfies [
    string,
    WriteClaim['operation'],
    ToolCallRecord['call']['arguments'],
    ToolCallRecord['result']['content'],
  ][])(
    'accepts %s (%s) for the logical collection',
    async (name, operation, args, content) => {
      const recorder = new RecordingMcpClient(fakeInner());
      jest.spyOn(recorder, 'getToolJournal').mockReturnValue([
        {
          call: {
            id: 'collection',
            name,
            arguments: { collection: 'drafts', ...args },
          },
          result: { content },
        },
      ]);
      const { output } = await review(recorder, [
        {
          system: 'rag',
          operation,
          target: { scope, collection: 'drafts' },
          callId: 'collection',
        },
      ]);
      expect(output).not.toContain('UNVERIFIED_WRITE:');
    },
  );

  it('verifies only the record IDs returned by a RAG upload toggle', async () => {
    const recorder = new RecordingMcpClient(fakeInner());
    jest.spyOn(recorder, 'getToolJournal').mockReturnValue([
      {
        call: {
          id: 'upload',
          name: 'record_set_enabled',
          arguments: { collection: 'drafts', source: 'file', enabled: false },
        },
        result: {
          content: {
            collection,
            recordIds: ['a', 'b'],
            updated: 2,
            enabled: false,
          },
        },
      },
    ]);
    const claim = {
      system: 'rag',
      operation: 'disabled',
      target: { scope, collection: 'drafts', record: 'a' },
      callId: 'upload',
    } satisfies WriteClaim;
    expect((await review(recorder, [claim])).output).not.toContain(
      'UNVERIFIED_WRITE:',
    );
    const wrongRecord = { ...claim, target: { ...claim.target, record: 'c' } };
    expect((await review(recorder, [wrongRecord])).output).toContain(
      'RAG disabled user/drafts/c',
    );
  });

  it('checks the SAP target and operation against a successful cited write', async () => {
    const recorder = new RecordingMcpClient(fakeInner());
    jest.spyOn(recorder, 'getToolJournal').mockReturnValue([
      {
        call: failedCreate.call,
        result: { content: 'SUCCESS' },
      },
    ]);
    const cited = { ...sapClaim, callId: 'sap' };
    expect((await review(recorder, [cited])).output).not.toContain(
      'UNVERIFIED_WRITE:',
    );
    const { output } = await review(recorder, [
      { ...cited, operation: 'activated' },
      { ...cited, target: { type: 'domain', name: 'OTHER' } },
      { ...cited, target: { type: 'class', name: 'ZREQ' } },
    ]);
    expect(output).toContain('SAP activated domain ZREQ');
    expect(output).toContain('SAP created domain OTHER');
    expect(output).toContain('SAP created class ZREQ');
  });

  it.each([
    {
      tool: 'CreateTransportTask',
      args: { transport_number: 'DEVK900001', target_user: 'DEVELOPER' },
      content: {
        success: true,
        request: 'DEVK900001',
        task_number: 'DEVK900002',
      },
      created: 'DEVK900002',
      other: 'DEVK900001',
    },
    {
      tool: 'CreateTransport',
      args: { description: 'New transport' },
      content: {
        success: true,
        transport_number: 'DEVK900001',
        task_number: 'DEVK900002',
      },
      created: 'DEVK900001',
      other: 'DEVK900002',
    },
  ])(
    'verifies the result target of $tool',
    async ({ tool, args, content, created, other }) => {
      const recorder = new RecordingMcpClient(fakeInner());
      jest.spyOn(recorder, 'getToolJournal').mockReturnValue([
        {
          call: { id: 'transport-call', name: tool, arguments: args },
          result: { content },
        },
      ]);
      const claim = {
        system: 'sap',
        operation: 'created',
        target: { type: 'transport', name: created },
        callId: 'transport-call',
      } satisfies WriteClaim;
      expect((await review(recorder, [claim])).output).not.toContain(
        'UNVERIFIED_WRITE:',
      );
      const { output } = await review(recorder, [
        { ...claim, target: { ...claim.target, name: other } },
      ]);
      expect(output).toContain(`SAP created transport ${other}`);
      expect(output).toContain(
        `${tool} does not prove the operation and target`,
      );
    },
  );

  it('requires a returned task number to verify a transport task creation', async () => {
    const recorder = new RecordingMcpClient(fakeInner());
    jest.spyOn(recorder, 'getToolJournal').mockReturnValue([
      {
        call: {
          id: 'task',
          name: 'CreateTransportTask',
          arguments: {
            transport_number: 'DEVK900001',
            target_user: 'DEVELOPER',
          },
        },
        result: {
          content: { success: true, request: 'DEVK900001', task_number: null },
        },
      },
    ]);
    const { output } = await review(recorder, [
      {
        system: 'sap',
        operation: 'created',
        target: { type: 'transport', name: 'DEVK900001' },
        callId: 'task',
      },
    ]);
    expect(output).toContain('UNVERIFIED_WRITE:');
    expect(output).toContain(
      'CreateTransportTask does not prove the operation and target',
    );
  });

  it('uses recorder call IDs and keeps pre-cap results in the journal sent to the checker', async () => {
    const content = 'read result '.repeat(30);
    const inner: IMcpClient = {
      listTools: jest.fn(),
      callTool: async () => ({ ok: true, value: { content } }),
    };
    const recorder = new RecordingMcpClient(inner, undefined, 10);
    const trace = { traceId: 'adaptive' };
    await recorder.callTool('ReadDomain', { domain_name: 'ZREQ' }, { trace });
    await recorder.callTool('ReadDomain', { domain_name: 'OTHER' }, { trace });
    const records = recorder.getToolRecords(trace.traceId);
    expect(records[0].result.isError).toBe(true);
    expect(records[0].call.id).toBeTruthy();
    expect(records[0].call.id).not.toBe(records[1].call.id);
    const journal = records.map(({ call }) => ({ call, result: { content } }));
    const { chat } = await review(recorder, []);
    expect(chat.mock.calls[0][0][1].content).toContain(JSON.stringify(journal));
  });

  it('reports an unusable checker verdict', async () => {
    const { output } = await review(
      new RecordingMcpClient(fakeInner()),
      undefined,
    );
    expect(output).toContain('checker did not submit a usable write verdict');
  });
});

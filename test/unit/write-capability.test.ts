import type { ILlm, IMcpClient } from '@mcp-abap-adt/llm-agent';
import { renderNotice } from '../../srv/lib/notify-policy';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { evaluateDeterministic } from '../../srv/lib/reviewer-core';

import { runWithSessionId } from '../../srv/request-session';

const inner: IMcpClient = {
  listTools: async () => ({
    ok: true,
    value: [{ name: 'CreateClass', description: '', inputSchema: {} }],
  }),
  callTool: async () => ({ ok: true, value: { content: 'SUCCESS' } }),
};
const llm: ILlm = {
  chat: async () => ({
    ok: true,
    value: { content: '', finishReason: 'stop' },
  }),
  streamChat: async function* () {},
};

test('discovery is not an offer; read-only historical prose has no claim notice', async () => {
  const recorder = new RecordingMcpClient(inner);
  const options = { trace: { traceId: 'read' } };
  await recorder.listTools(options);
  await recorder
    .trackOfferedTools(llm)
    .chat(
      [],
      [{ name: 'GetClass', description: '', inputSchema: {} }],
      options,
    );
  expect(recorder.hadWriteCapability('read')).toBe(false);
  expect(
    renderNotice(
      evaluateDeterministic(
        'I_COUNTRY was created using the older define view syntax.',
        [],
        recorder.hadWriteCapability('read'),
      ),
    ),
  ).toBe('');
});

test('offered writes are shared across worker views and isolated by turn and recorder', async () => {
  const recorder = new RecordingMcpClient(inner);
  const worker = recorder.includeClients([inner]);
  await worker
    .trackOfferedTools(llm)
    .chat([], [{ name: 'CreateClass', description: '', inputSchema: {} }], {
      trace: { traceId: 'write' },
    });
  expect(recorder.getToolRecords('write')).toEqual([]);
  expect(
    renderNotice(
      evaluateDeterministic(
        'I created ZCL_X.',
        [],
        recorder.hadWriteCapability('write'),
      ),
    ),
  ).toContain('claims "created" but no successful Create* tool ran');
  expect(recorder.hadWriteCapability('next')).toBe(false);
  expect(new RecordingMcpClient(inner).hadWriteCapability('write')).toBe(false);
  recorder.dropRequest('write');
  expect(worker.hadWriteCapability('write')).toBe(false);
});

test('stream offers and attempted writes also establish capability', async () => {
  const recorder = new RecordingMcpClient(inner);
  for await (const chunk of recorder
    .trackOfferedTools(llm)
    .streamChat(
      [],
      [{ name: 'UpdateClass', description: '', inputSchema: {} }],
      { trace: { traceId: 'stream' } },
    )) {
    expect(chunk).toBeDefined();
  }
  expect(recorder.hadWriteCapability('stream')).toBe(true);
  await recorder.callTool('CreateClass', {}, { trace: { traceId: 'attempt' } });
  expect(recorder.hadWriteCapability('attempt')).toBe(true);
  recorder.reset();
  expect(recorder.hadWriteCapability('stream')).toBe(false);
  expect(recorder.hadWriteCapability('attempt')).toBe(false);
});

test.each(['late worker', 'background event', 'nested execute_step'])(
  '%s capability survives trace cleanup until the coordinator review',
  async (path) => {
    const recorder = new RecordingMcpClient(inner);
    recorder.openSession('alice', 'dialogue');
    const worker =
      path === 'nested execute_step'
        ? new RecordingMcpClient(inner, undefined, undefined, false)
        : recorder.includeClients([inner]);
    await recorder.withSession('alice', 'dialogue', () =>
      runWithSessionId(
        'dialogue',
        async () => {
          await worker
            .trackOfferedTools(llm)
            .chat(
              [],
              [{ name: 'CreateClass', description: '', inputSchema: {} }],
              path === 'background event'
                ? undefined
                : { trace: { traceId: path } },
            );
        },
        [],
        'alice',
      ),
    );
    worker.dropRequest(path);
    expect(recorder.hadWriteCapability(path)).toBe(false);
    const review = () =>
      renderNotice(
        evaluateDeterministic(
          'I created ZCL_X.',
          [],
          recorder.hadSessionWriteCapability('alice', 'dialogue'),
        ),
      );
    expect(review()).toContain('claims "created"');
    // A review while workers still run leaves the accumulator intact.
    expect(review()).toContain('claims "created"');
    recorder.consumeSessionWriteCapability('alice', 'dialogue');
    expect(recorder.hadSessionWriteCapability('alice', 'dialogue')).toBe(false);
  },
);

test('session capability isolates owners and sessions and clears on close', async () => {
  const recorder = new RecordingMcpClient(inner);
  recorder.openSession('alice', 'write');
  recorder.openSession('alice', 'read');
  recorder.openSession('bob', 'write');
  await runWithSessionId(
    'write',
    () =>
      recorder.withSession('alice', 'write', () =>
        recorder.callTool('CreateClass', {}),
      ),
    [],
    'alice',
  );
  expect(recorder.hadSessionWriteCapability('alice', 'write')).toBe(true);
  for (const [owner, session] of [
    ['alice', 'read'],
    ['bob', 'write'],
  ]) {
    expect(recorder.hadSessionWriteCapability(owner, session)).toBe(false);
    expect(
      renderNotice(
        evaluateDeterministic(
          'X was created using the older syntax.',
          [],
          recorder.hadSessionWriteCapability(owner, session),
        ),
      ),
    ).toBe('');
  }
  recorder.closeSession('alice', 'write');
  await runWithSessionId(
    'write',
    () =>
      recorder.withSession('alice', 'write', () =>
        recorder.callTool('CreateClass', {}),
      ),
    [],
    'alice',
  );
  expect(recorder.hadSessionWriteCapability('alice', 'write')).toBe(false);
});

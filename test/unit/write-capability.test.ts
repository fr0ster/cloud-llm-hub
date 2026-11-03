import type { ILlm, IMcpClient } from '@mcp-abap-adt/llm-agent';
import { renderNotice } from '../../srv/lib/notify-policy';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { evaluateDeterministic } from '../../srv/lib/reviewer-core';

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

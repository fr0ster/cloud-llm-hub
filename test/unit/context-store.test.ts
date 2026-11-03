import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  captureLlm,
  runWithContextCapture,
} from '../../srv/lib/context-capture';
import {
  drainContext,
  redactContext,
  resetContextStore,
} from '../../srv/lib/context-store';

let dir: string;
const env = { ...process.env };
const text = 'complete content '.repeat(200);
const messages: Message[] = [
  { role: 'user', content: text },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'a',
        type: 'function',
        function: { name: 'tool', arguments: '{}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'a', content: text },
];
const tools = [{ name: 'tool', description: text, inputSchema: {} }];
const call = { id: 'a', name: 'tool', arguments: { complete: text } };
const llm: ILlm = {
  model: 'test',
  async chat() {
    return {
      ok: true,
      value: {
        content: text,
        toolCalls: [call],
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
    };
  },
  async *streamChat() {
    yield { ok: true, value: { content: text.slice(0, 100) } };
    yield { ok: true, value: { content: text.slice(100), toolCalls: [call] } };
  },
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'context-'));
  process.env.LLM_AGENT_CONTEXT_CAPTURE_FILE = join(dir, 'context.sqlite');
});
afterEach(async () => {
  await drainContext();
  resetContextStore();
  process.env = { ...env };
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});
function rows() {
  const db = new DatabaseSync(join(dir, 'context.sqlite'));
  try {
    return db.prepare('SELECT * FROM context_calls ORDER BY rowid').all();
  } finally {
    db.close();
  }
}
test('full captures complete requests and chat/stream responses with isolated sessions', async () => {
  const captured = captureLlm(llm, 'chat', 'full', {
    temperature: 0.2,
    maxTokens: 100,
  });
  await Promise.all(
    ['one', 'two'].map((sessionKey) =>
      runWithContextCapture({ component: 'executor', sessionKey }, () =>
        captured.chat(messages, tools, { trace: { traceId: 'trace' } }),
      ),
    ),
  );
  for await (const _chunk of captured.streamChat(messages, tools)) {
    /* consume */
  }
  await drainContext();
  const data = rows();
  expect(data).toHaveLength(3);
  expect(data[0].session).not.toBe(data[1].session);
  expect(data[2].session).toBeNull();
  for (const row of data) {
    expect(JSON.parse(String(row.messages))).toEqual(messages);
    expect(JSON.parse(String(row.tools))).toEqual(tools);
    expect(JSON.parse(String(row.response))).toEqual({
      content: text,
      toolCalls: [call],
    });
    expect(JSON.parse(String(row.options))).toEqual({
      temperature: 0.2,
      maxTokens: 100,
    });
  }
  expect(data[0]).toMatchObject({
    trace: 'trace',
    input_tokens: 10,
    output_tokens: 20,
    ok: 1,
  });
});
test('off creates no file', async () => {
  await captureLlm(llm, 'chat', 'off').chat(messages);
  const { existsSync } = await import('node:fs');
  expect(existsSync(join(dir, 'context.sqlite'))).toBe(false);
});
test.each([
  'password=abc',
  'passwd: abc',
  'authorization: Bearer abc',
  'bearer abc',
  'client_secret=abc',
  'clientsecret: abc',
  'x-sap-password: abc',
  'x-sap-client: abc',
  'sap-password=abc',
  '"password": "abc"',
])('redacts %s', (value) => {
  expect(redactContext(value)).not.toContain('abc');
  expect(redactContext(value)).toContain('\u00abredacted\u00bb');
});
test('write failures preserve results and warn once', async () => {
  process.env.LLM_AGENT_CONTEXT_CAPTURE_FILE = dir;
  const warn = jest
    .spyOn(cds.log('context-capture'), 'warn')
    .mockImplementation(() => {});
  for (let i = 0; i < 2; i++) {
    await expect(
      captureLlm(llm, 'chat', 'full').chat(messages),
    ).resolves.toMatchObject({ ok: true });
    await drainContext();
  }
  expect(warn).toHaveBeenCalledTimes(1);
});
test('size cap preserves existing data and warns once', async () => {
  writeFileSync(join(dir, 'context.sqlite'), Buffer.alloc(1024));
  process.env.LLM_AGENT_CONTEXT_CAPTURE_MAX_MB = '0.0001';
  const warn = jest
    .spyOn(cds.log('context-capture'), 'warn')
    .mockImplementation(() => {});
  for (let i = 0; i < 2; i++) {
    await captureLlm(llm, 'chat', 'full').chat(messages);
    await drainContext();
  }
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('Context capture: MAX_MB_REACHED');
});

test('stream tool deltas assemble and JSON credentials are redacted on both sides', async () => {
  const streaming: ILlm = {
    ...llm,
    async *streamChat() {
      yield {
        ok: true,
        value: {
          content: 'password=secret',
          toolCalls: [
            { index: 0, id: 'x', name: 'tool', arguments: '{"password":' },
          ],
        },
      };
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: [{ index: 0, arguments: '"secret"}' }],
        },
      };
    },
  };
  for await (const _chunk of captureLlm(streaming, 'chat', 'full').streamChat([
    { role: 'user', content: '{"client_secret":"secret"}' },
  ])) {
    /* consume */
  }
  await drainContext();
  const row = rows()[0];
  expect(String(row.messages)).not.toContain('"secret"');
  expect(String(row.response)).not.toContain('secret');
  expect(JSON.parse(String(row.response))).toMatchObject({
    toolCalls: [{ id: 'x', name: 'tool' }],
  });
});

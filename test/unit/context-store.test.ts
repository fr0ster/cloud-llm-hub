import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  contextJson,
  contextStoreStatus,
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
  await resetContextStore();
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
  expect(contextStoreStatus().active).toBe(false);
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

test('nested JSON strings redact escaped passwords, keys and credential values', () => {
  const nested = JSON.stringify({
    password: 'prefix"suffix',
    Authorization: 'Basic hidden',
    values: ['Bearer hidden', 'Basic hidden', 'password=hidden&safe=visible'],
  });
  const result = contextJson({
    content: JSON.stringify({ tool: nested }),
    secret: 'hidden',
    token: 'hidden',
    api_key: 'hidden',
  });
  expect(result).not.toContain('hidden');
  expect(result).not.toContain('suffix');
  expect(result).toContain('safe=visible');
  const ordinary = { content: 'ordinary text', list: [1, true, null] };
  expect(contextJson(ordinary)).toBe(JSON.stringify(ordinary));
  expect(redactContext('password=abc%22suffix&safe=visible')).not.toContain(
    'suffix',
  );
});

test('quoted text redacts the entire password through escaped delimiters', () => {
  const value = String.raw`password="prefix\"suffix" safe=visible`;
  expect(redactContext(value)).toBe(
    'password=\u00abredacted\u00bb safe=visible',
  );
});

const credentialKeys = [
  'password',
  'passwd',
  'pwd',
  'mySecretValue',
  'client_secret',
  'client-secret',
  'access_token',
  'refresh_token',
  'id_token',
  'session_token',
  'x-csrf-token',
  'Authorization',
  'Cookie',
  'Set-Cookie',
  'api-key',
  'api_key',
  'private-key',
  'private_key',
  'sap-password',
  'x-sap-login',
];
test.each(credentialKeys)(
  'redacts credential key %s in objects, JSON strings and text',
  (key) => {
    const credentials = {
      [key.toUpperCase()]: 'sensitive-value',
      client_id: 'visible',
    };
    const expected = {
      [key.toUpperCase()]: '\u00abredacted\u00bb',
      client_id: 'visible',
    };
    expect(contextJson({ nested: [credentials] })).toBe(
      JSON.stringify({ nested: [expected] }),
    );
    expect(
      contextJson({ content: JSON.stringify({ nested: credentials }) }),
    ).toBe(JSON.stringify({ content: JSON.stringify({ nested: expected }) }));
    for (const text of [
      `${key}=sensitive-value&safe=visible`,
      `payload: {"${key}": "sensitive-value"}`,
      `${key.toUpperCase()}: sensitive-value; extra-cookie=hidden`,
    ]) {
      const result = redactContext(text);
      expect(result).not.toContain('sensitive-value');
      expect(result).toContain('\u00abredacted\u00bb');
    }
  },
);
test('numeric token usage remains intact in objects, JSON strings and plain text', () => {
  const usage = {
    tokens: 9,
    input_tokens: 2,
    output_tokens: 3,
    total_tokens: 5,
  };
  expect(contextJson({ usage })).toBe(JSON.stringify({ usage }));
  expect(contextJson({ content: JSON.stringify(usage) })).toBe(
    JSON.stringify({ content: JSON.stringify(usage) }),
  );
  const text =
    'usage: {"input_tokens": 2, "output_tokens": 3, "total_tokens": 5}';
  expect(redactContext(text)).toBe(text);
});
test('nested OAuth request and response JSON is redacted in persisted capture', async () => {
  const payload = {
    nested: {
      access_token: 'oauth-access-value',
      refresh_token: 'oauth-refresh-value',
    },
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  };
  const oauthLlm: ILlm = {
    ...llm,
    async chat() {
      return {
        ok: true,
        value: {
          content: JSON.stringify(payload),
          finishReason: 'stop',
          toolCalls: [{ id: 'oauth', name: 'tool', arguments: payload }],
        },
      };
    },
  };
  await captureLlm(oauthLlm, 'chat', 'full').chat([
    { role: 'user', content: JSON.stringify(payload) },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'oauth',
          type: 'function',
          function: { name: 'tool', arguments: JSON.stringify(payload) },
        },
      ],
    },
  ]);
  await drainContext();
  const row = rows()[0];
  for (const field of [row.messages, row.response]) {
    expect(String(field)).not.toContain('oauth-access-value');
    expect(String(field)).not.toContain('oauth-refresh-value');
    expect(String(field)).toContain('redacted');
    expect(String(field)).toContain('input_tokens');
  }
});

test('bounded worker queue counts drops and warns once per burst', async () => {
  const warn = jest
    .spyOn(cds.log('context-capture'), 'warn')
    .mockImplementation(() => {});
  const captured = captureLlm(llm, 'chat', 'full');
  await Promise.all(Array.from({ length: 70 }, () => captured.chat(messages)));
  expect(contextStoreStatus()).toMatchObject({ pending: 64, dropped: 6 });
  expect(warn).toHaveBeenCalledTimes(1);
  await drainContext();
  expect(rows()).toHaveLength(64);
  await Promise.all(Array.from({ length: 66 }, () => captured.chat(messages)));
  expect(contextStoreStatus().dropped).toBe(8);
  expect(warn).toHaveBeenCalledTimes(2);
  await drainContext();
});

test('worker failure disables capture without changing subsequent LLM results', async () => {
  process.env.LLM_AGENT_CONTEXT_CAPTURE_FILE = dir;
  jest.spyOn(cds.log('context-capture'), 'warn').mockImplementation(() => {});
  const captured = captureLlm(llm, 'chat', 'full');
  await expect(captured.chat(messages)).resolves.toMatchObject({ ok: true });
  await drainContext();
  expect(contextStoreStatus()).toMatchObject({ disabled: true, active: false });
  await expect(captured.chat(messages)).resolves.toMatchObject({ ok: true });
  expect(contextStoreStatus().active).toBe(false);
});

test.each([
  'password=123456&safe=visible',

  '?password=123abc&safe=visible',

  'payload: {"password":123456}',

  'Password: 123456',

  '{"password":123456}',
])('redacts complete numeric and alphanumeric credentials: %s', (value) => {
  expect(redactContext(value)).not.toMatch(/123456|123abc/);

  expect(redactContext(value)).toContain('redacted');
});

test.each(['Cookie', 'Set-Cookie'])(
  'redacts every %s value inline and on header lines',
  (header) => {
    for (const prefix of ['', 'request headers: ']) {
      expect(
        redactContext(`${prefix}${header}: sid=secret; refresh=secret2`),
      ).toBe(
        `${prefix}${header}: sid=\u00abredacted\u00bb; refresh=\u00abredacted\u00bb`,
      );
    }
  },
);

test.each([
  'PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
  'ENCRYPTED PRIVATE KEY',
])(
  'redacts full multiline PEM %s blocks including nested JSON strings',
  (label) => {
    const pem = `-----BEGIN ${label}-----\nprivatebody1\nprivatebody2\n-----END ${label}-----`;

    expect(redactContext(`before\n${pem}\nafter`)).toBe(
      'before\n\u00abredacted\u00bb\nafter',
    );

    expect(contextJson({ content: JSON.stringify({ pem }) })).not.toContain(
      'privatebody',
    );
  },
);

test.each([
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cached_tokens',
  'promptTokens',
  'completion_tokens',
  'tokens',
])('preserves numeric usage by key: %s', (key) => {
  const usage = { [key]: 123456 };

  expect(contextJson(usage)).toBe(JSON.stringify(usage));

  for (const value of [
    `${key}=123456`,
    `${key}: 123456`,
    `usage: {"${key}":123456}`,
  ])
    expect(redactContext(value)).toBe(value);
});

test('SQLite cap drops oversized rows, retains existing data and stops writes', async () => {
  process.env.LLM_AGENT_CONTEXT_CAPTURE_MAX_MB = '0.0625';

  const warn = jest
    .spyOn(cds.log('context-capture'), 'warn')
    .mockImplementation(() => {});

  const captured = captureLlm(llm, 'chat', 'full');

  await captured.chat(messages);

  await drainContext();

  const before = rows();

  expect(before).toHaveLength(1);

  await captured.chat([{ role: 'user', content: 'x'.repeat(128 * 1024) }]);

  await drainContext();

  await captured.chat(messages);

  await drainContext();

  expect(rows()).toEqual(before);

  expect(statSync(join(dir, 'context.sqlite')).size).toBeLessThanOrEqual(65536);

  expect(contextStoreStatus()).toMatchObject({
    pending: 0,
    dropped: 2,
    disabled: false,
  });

  expect(warn).toHaveBeenCalledTimes(1);

  expect(warn).toHaveBeenCalledWith('Context capture: MAX_MB_REACHED');
});

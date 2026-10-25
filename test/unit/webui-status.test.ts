import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
test('standalone status parser keeps latest states and escapes labels', () => {
  const source = html.slice(
    html.indexOf('        function stepSymbol('),
    html.indexOf('        // Dialogue events'),
  );
  const api = runInNewContext(
    source + ';({parseStepStatus, renderStepTrail})',
    {
      escapeHtml: (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    },
  );
  const steps = new Map();
  for (const line of [
    ': status broken',
    ': heartbeat',
    ': status {"stepId":"<a>","state":"started"}',
    ': status {"stepId":"<a>","state":"done"}',
    ': status {"stepId":"b","state":"done","verdict":"fail"}',
  ]) {
    const status = api.parseStepStatus(line);
    if (status) steps.set(status.stepId, status);
  }
  expect(steps.size).toBe(2);
  expect(api.renderStepTrail(steps)).toContain('&lt;a&gt; ✓ · b ✗');
});

test.each([
  ['started', undefined, '\u2026'],
  ['done', undefined, '\u2713'],
  ['failed', undefined, '\u2717'],
  ['done', 'fail', '\u2717'],
  ['done', 'partial', '~'],
])('status icon %s %s', (state, verdict, symbol) => {
  const source = html.slice(
    html.indexOf('        function stepSymbol('),
    html.indexOf('        // Dialogue events'),
  );
  const api = runInNewContext(source + ';({stepSymbol})');
  expect(api.stepSymbol({ state, verdict })).toBe(symbol);
});

test('chat reader parses fragmented CRLF status comments and retains trail with answer', async () => {
  const helper = html.slice(
    html.indexOf('        function stepSymbol('),
    html.indexOf('        // Dialogue events'),
  );
  const start = html.indexOf(
    '                const reader = response.body.getReader();',
  );
  const pump = html.slice(
    start,
    html.indexOf('                stopTimer();', start),
  );
  const wire =
    ': status {"stepId":"<step>","kind":"execute","state":"started"}\r\n\r\n: status broken\r\n\r\n: status {"stepId":"<step>","kind":"execute","state":"done"}\r\n\r\ndata: {"choices":[{"delta":{"content":"answer"}}]}\r\n\r\n';
  const chunks = [wire.slice(0, 19), wire.slice(19, 80), wire.slice(80)];
  const node = { innerHTML: '' };
  let answer = '';
  const setStatus = jest.fn();
  await runInNewContext(
    helper +
      ';(async () => { let phase, assistantContent = "", usage; const stepStates = new Map(), externalToolCalls = [], toolCalls = [], toolCallNames = new Set();' +
      pump +
      '})()',
    {
      TextDecoder,
      response: {
        body: {
          getReader: () => ({
            releaseLock: jest.fn(),
            read: async () =>
              chunks.length
                ? { value: new TextEncoder().encode(chunks.shift()) }
                : { done: true },
          }),
        },
      },
      releaseTurn: () => {},
      thinkingId: 'answer',
      setStatus,
      escapeHtml: (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      document: { getElementById: () => node },
      chatWindow: {},
      createFileParser: () => ({
        process: (text: string) => {
          answer += text;
        },
        render: () => ({ html: answer }),
      }),
    },
  );
  expect(setStatus).toHaveBeenLastCalledWith(
    'STEP <STEP> \u00b7 EXECUTE \u00b7 DONE',
    'status-connecting',
  );
  expect(node.innerHTML).toContain('&lt;step&gt; \u2713');
  expect(node.innerHTML).toContain('AGENT:</b> answer');
  expect(node.innerHTML.indexOf('&lt;step&gt;')).toBeLessThan(
    node.innerHTML.indexOf('answer'),
  );
});

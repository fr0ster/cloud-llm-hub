import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function harness() {
  const nodes: any[] = [];
  const list = { innerHTML: '' };
  const plan = { hidden: true, open: false };
  const planText = { innerHTML: '' };
  const planStatus = { textContent: '' };
  const active = { hidden: true, innerHTML: '' };
  const intervals: Array<() => void> = [];
  const timers: Array<{ fn: () => Promise<void>; delay: number }> = [];
  const fetch = jest.fn();
  const context = {
    fetch,
    hubFetch: fetch,
    hubSignedOut: false,
    AbortController,
    TextDecoder,
    setTimeout: (fn: () => Promise<void>, delay: number) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout: jest.fn(),
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: (id: number | null) => {
      if (id) intervals[id - 1] = () => {};
    },
    sessionHeaders: () => ({ 'x-clh-session': 'key' }),
    conversationHistory: [],
    escapeHtml: (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    document: {
      getElementById: (id: string) =>
        ({
          'dialogue-plan': plan,
          'dialogue-plan-text': planText,
          'dialogue-plan-status': planStatus,
          'dialogue-active': active,
        })[id] ?? list,
      createElement: () => ({}),
    },
    chatWindow: {
      appendChild: (node: any) => nodes.push(node),
      scrollTop: 0,
      scrollHeight: 10,
    },
  };
  const source = html.slice(
    html.indexOf('        function stepSymbol('),
    html.indexOf('        // Input history'),
  );
  const markdown = html.slice(
    html.indexOf('        function markdownToHtml('),
    html.indexOf('        // Check model availability'),
  );
  const api = runInNewContext(
    markdown +
      source +
      ';({subscribeDialogueEvents, startDialogueEvents, stopDialogueEvents, markdownToHtml, signOut: () => { hubSignedOut = true; }})',
    context,
  );
  return {
    ...context,
    ...api,
    nodes,
    list,
    timers,
    plan,
    planText,
    planStatus,
    active,
    intervals,
  };
}
function stream(text: string) {
  let first = true;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (!first) return { done: true };
          first = false;
          return { value: new TextEncoder().encode(text), done: false };
        },
        releaseLock: jest.fn(),
        cancel: async () => {},
      }),
    },
  };
}
test('markdown tables render aligned headers, escaped cells and inline markdown', () => {
  const ui = harness();
  const result = ui.markdownToHtml(
    '| Result | Count | Note |\n| :--- | ---: | :---: |\n| **stored** | `2` | <script>x</script> |\n\nAfter',
  );
  expect(result).toContain(
    '<table class="markdown-table"><thead><tr><th style="text-align:left">Result</th>',
  );
  expect(result).toContain('<th style="text-align:right">Count</th>');
  expect(result).toContain('<th style="text-align:center">Note</th>');
  expect(result).toContain(
    '<td style="text-align:left"><strong>stored</strong></td>',
  );
  expect(result).toContain('<td style="text-align:right"><code>2</code></td>');
  expect(result).toContain('&lt;script&gt;x&lt;/script&gt;');
  expect(result).not.toContain('<script>');
  expect(
    ui.markdownToHtml('```text\n| A | B |\n| --- | --- |\n```'),
  ).not.toContain('<table');
});
test.each([
  'javascript:alert%281%29',
  'JaVaScRiPt:alert%281%29',
  '  javascript:alert%281%29',
  'java\nscript:alert%281%29',
  'java\t\u0000script:alert%281%29',
  'jav&#x61;script:alert%281%29',
  'jav&#97;script&colon;alert%281%29',
  'java&NewLine;script:alert%281%29',
  '%6aavascript%3aalert%281%29',
  '%256aavascript%253aalert%281%29',
  'jav&amp;#x61;script:alert%281%29',
  'data:text/html,bad',
  'vbscript:bad',
  'ftp://example.com',
  'example.com',
])('markdown rejects unsafe link destination %j', (destination) => {
  expect(harness().markdownToHtml(`[run](${destination})`)).toBe('run');
});

test.each([
  'http://example.com',
  'https://example.com/?a=1&b=2',
  'HTTPS://example.com',
  'mailto:user@example.com',
  '/plans/1',
  '#plan',
])(
  'markdown allows link destination %j with safe new-tab attributes',
  (destination) => {
    const ui = harness();
    const result = ui.markdownToHtml(`[open](${destination})`);
    expect(result).toContain(`<a href="${ui.escapeHtml(destination)}"`);
    expect(result).toContain('target="_blank" rel="noopener noreferrer"');
    expect(result).toContain('>open</a>');
  },
);

test('plan text and planner messages reject unsafe markdown links', async () => {
  const ui = harness();
  const text = '[run](javascript:alert%281%29)';
  ui.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/ack')
      ? { ok: true }
      : stream(
          `event: plan\ndata: ${JSON.stringify({ text })}\n\nid: unsafe\ndata: ${JSON.stringify({ text })}\n\n`,
        ),
  );
  const subscription = ui.subscribeDialogueEvents('key');
  await flush();
  expect(ui.planText.innerHTML).toBe('run');
  expect(ui.nodes[0].innerHTML).toContain('run');
  expect(ui.nodes[0].innerHTML).not.toContain('<a ');
  subscription.stop();
});

test('standalone renders before ack, dedupes replay, sends cursor and handles task snapshots/updates safely', async () => {
  const ui = harness();
  const message =
    'id: m1\r\nevent: message\r\ndata: {"text":"<script>hi</script>"}\r\n\r\n';
  ui.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/ack')) {
      expect(ui.nodes).toHaveLength(1);
      return { ok: true };
    }
    return stream(
      message +
        'event: tasks\ndata: [{"id":"<old>","goal":"gone","state":"done"}]\n\nevent: tasks\ndata: [{"id":"<t>","goal":"<goal>","state":"started"}]\n\nevent: task\ndata: {"id":"<t>","state":"done"}\n\n',
    );
  });
  const subscription = ui.subscribeDialogueEvents('key');
  await flush();
  expect(ui.nodes).toHaveLength(1);
  expect(ui.nodes[0].innerHTML).toContain('&lt;script&gt;');
  expect(ui.nodes[0].innerHTML).toContain('AGENT:');
  expect(ui.list.innerHTML).toContain('✓ &lt;t&gt;: &lt;goal&gt;');
  expect(ui.list.innerHTML).not.toContain('gone');
  expect(
    ui.fetch.mock.calls.find(([url]: [string]) => url.endsWith('/ack'))?.[1],
  ).toMatchObject({
    body: JSON.stringify({ id: 'm1' }),
    headers: { 'x-clh-session': 'key' },
  });
  expect(ui.timers[0].delay).toBe(1000);
  await ui.timers[0].fn();
  await flush();
  expect(ui.nodes).toHaveLength(1);
  expect(
    ui.fetch.mock.calls.filter(([url]: [string]) =>
      url.endsWith('/events'),
    )[1][1].headers['Last-Event-ID'],
  ).toBe('m1');
  subscription.stop();
});
test('409 stops retries; network failures back off to 30 seconds', async () => {
  const ui = harness();
  ui.fetch.mockResolvedValue({ status: 409 });
  ui.subscribeDialogueEvents('key');
  await flush();
  expect(ui.timers).toHaveLength(0);
  ui.fetch.mockRejectedValue(new Error('offline'));
  const subscription = ui.subscribeDialogueEvents('new');
  await flush();
  for (let i = 0; i < 6; i++) await ui.timers[i].fn();
  expect(ui.timers.map((t: { delay: number }) => t.delay)).toEqual([
    1000, 2000, 4000, 8000, 16000, 30000, 30000,
  ]);
  subscription.stop();
  await ui.timers[6].fn();
  expect(ui.timers).toHaveLength(7);
});
test('new session cancels pending reader and ignores late data; clear removes tasks', async () => {
  const ui = harness();
  let resolveRead!: (value: any) => void;
  const cancel = jest.fn(async () => {});
  ui.fetch
    .mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((resolve) => {
              resolveRead = resolve;
            }),
          cancel,
          releaseLock: jest.fn(),
        }),
      },
    })
    .mockResolvedValue({ status: 409 });
  ui.startDialogueEvents('old');
  await flush();
  ui.startDialogueEvents('new');
  await flush();
  expect(cancel).toHaveBeenCalled();
  resolveRead({
    value: new TextEncoder().encode('data: {"id":"late","text":"late"}\n\n'),
    done: false,
  });
  await flush();
  expect(ui.nodes).toHaveLength(0);
  ui.list.innerHTML = 'tasks';
  ui.stopDialogueEvents();
  expect(ui.list.innerHTML).toBe('');
});

test('planner markdown uses the streamed answer renderer and escapes HTML', async () => {
  const ui = harness();
  const text = '**bold**\n## Heading\n- item\n---\n<img src=x onerror="bad()">';
  ui.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/ack')
      ? { ok: true }
      : stream(`id: formatted\ndata: ${JSON.stringify({ text })}\n\n`),
  );
  const subscription = ui.subscribeDialogueEvents('key');
  await flush();
  expect(ui.nodes[0].innerHTML).toContain('<strong>bold</strong>');
  expect(ui.nodes[0].innerHTML).toContain('font-size:15px');
  expect(ui.nodes[0].innerHTML).toContain('&bull; item');
  expect(ui.nodes[0].innerHTML).toContain('<hr>');
  expect(ui.nodes[0].innerHTML).toContain('&lt;img');
  expect(ui.nodes[0].innerHTML).not.toContain('<img');
  subscription.stop();
});

test('tasks have a single line class and an escaped full goal title', async () => {
  const ui = harness();
  ui.fetch.mockResolvedValue(
    stream(
      `event: tasks\ndata: ${JSON.stringify([{ id: 't', goal: 'long <goal> "quoted"', state: 'done' }])}\n\n`,
    ),
  );
  const subscription = ui.subscribeDialogueEvents('key');
  await flush();
  expect(ui.list.innerHTML).toContain('class="dialogue-task"');
  expect(ui.list.innerHTML).toContain(
    'title="long &lt;goal&gt; &quot;quoted&quot;"',
  );
  expect(html).toMatch(
    /\.dialogue-task\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis/s,
  );
  subscription.stop();
});

test('plan panel renders escaped markdown, updates live, preserves collapse and clears on reset', async () => {
  const ui = harness();
  const frame = (text: string, status: string) =>
    `event: plan\ndata: ${JSON.stringify({ text, status })}\n\n`;
  ui.fetch
    .mockResolvedValueOnce(
      stream(frame('**First**\n<script>bad()</script>', 'active')),
    )
    .mockResolvedValueOnce(stream(frame('Second', 'waiting_user')))
    .mockResolvedValue({ status: 409 });
  ui.startDialogueEvents('key');
  await flush();
  expect(ui.plan.hidden).toBe(false);
  expect(ui.plan.open).toBe(true);
  expect(ui.planText.innerHTML).toContain('<strong>First</strong>');
  expect(ui.planText.innerHTML).toContain('&lt;script&gt;');
  expect(ui.planText.innerHTML).not.toContain('<script>');
  expect(ui.planStatus.textContent).toBe('active');
  ui.plan.open = false;
  await ui.timers[0].fn();
  await flush();
  expect(ui.planText.innerHTML).toBe('Second');
  expect(ui.planStatus.textContent).toBe('waiting for you');
  expect(ui.plan.open).toBe(false);
  ui.startDialogueEvents('new');
  expect(ui.plan.hidden).toBe(true);
  expect(ui.planText.innerHTML).toBe('');
  expect(ui.planStatus.textContent).toBe('');
  ui.stopDialogueEvents();
});

test('structured plan shows states, attempts and escaped goals across live updates', async () => {
  const ui = harness();
  const states = [
    'running',
    'checking',
    'done',
    'failed',
    'skipped',
    'blocked',
    'pending',
  ];
  const steps = states.map((state, i) => ({
    id: String(i),
    state,
    goal: '<script>goal</script>',
    dependsOn: ['0'],
    workTaskId: '<work>',
    check: { taskId: '<check>' },
  }));
  steps.push({ ...steps[0], id: 'ready', state: 'pending', dependsOn: ['2'] });
  const frame = (status: string) =>
    `event: plan\ndata: ${JSON.stringify({ steps, status })}\n\n`;
  ui.fetch
    .mockResolvedValueOnce(stream(frame('active')))
    .mockResolvedValueOnce(stream(frame('done')));
  ui.startDialogueEvents('key');
  await flush();
  for (const state of [...states, 'ready'])
    expect(ui.planText.innerHTML).toContain(`>${state}</span>`);
  expect(ui.planText.innerHTML).toContain('&lt;script&gt;goal&lt;/script&gt;');
  expect(ui.planText.innerHTML).toContain('work: &lt;work&gt;');
  expect(ui.planText.innerHTML).toContain('check: &lt;check&gt;');
  expect(ui.planText.innerHTML).not.toContain('<script>');
  ui.plan.open = false;
  await ui.timers[0].fn();
  await flush();
  expect(ui.planStatus.textContent).toBe('done');
  expect(ui.plan.open).toBe(false);
  ui.stopDialogueEvents();
});

test('long plans start collapsed and done status is visible', async () => {
  const ui = harness();
  ui.fetch.mockResolvedValue(
    stream(
      `event: plan\ndata: ${JSON.stringify({ text: Array(9).fill('line').join('\n'), status: 'done' })}\n\n`,
    ),
  );
  ui.startDialogueEvents('key');
  await flush();
  expect(ui.plan.open).toBe(false);
  expect(ui.planStatus.textContent).toBe('done');
  ui.stopDialogueEvents();
  expect(ui.plan.hidden).toBe(true);
});

test('signed-out event responses stop the reconnect loop', async () => {
  const ui = harness();
  ui.fetch.mockImplementation(async () => {
    ui.signOut();
    throw new Error('Sign in again');
  });
  ui.subscribeDialogueEvents('key');
  await flush();
  expect(ui.fetch).toHaveBeenCalledTimes(1);
  expect(ui.timers).toHaveLength(0);
});
test('only queued and running subagents show above the input with elapsed time', async () => {
  const ui = harness();
  const now = Date.now();
  const tasks = [
    { id: 'T1', worker: 'executor', goal: 'old', state: 'done' },
    {
      id: 'T2',
      worker: 'executor',
      goal: 'read <dump>',
      state: 'running',
      startedAt: now - 65_000,
    },
    { id: 'T3', worker: 'checker', goal: 'check', state: 'queued' },
  ];
  ui.fetch.mockResolvedValue(
    stream(`event: tasks\ndata: ${JSON.stringify(tasks)}\n\n`),
  );
  const subscription = ui.subscribeDialogueEvents('key');
  await flush();
  expect(ui.active.hidden).toBe(false);
  expect(ui.active.innerHTML).toContain('main agent · 2 active');
  expect(ui.active.innerHTML).toContain('├ T2 executor: read &lt;dump&gt;');
  expect(ui.active.innerHTML).toMatch(/1:0[5-9]/);
  expect(ui.active.innerHTML).toContain('└ T3 checker: check');
  expect(ui.active.innerHTML).toContain('· queued');
  expect(ui.active.innerHTML).not.toContain('old');
  expect(ui.list.innerHTML).toContain('T1: old');
  expect(ui.intervals).toHaveLength(1);
  subscription.stop();
  ui.stopDialogueEvents();
  expect(ui.active.hidden).toBe(true);
  expect(ui.active.innerHTML).toBe('');
});
test('the active list hides when every subagent finishes', async () => {
  const ui = harness();
  const running = { id: 'T1', worker: 'executor', goal: 'g', state: 'running' };
  ui.fetch.mockResolvedValue(
    stream(
      `event: tasks\ndata: ${JSON.stringify([running])}\n\nevent: task\ndata: ${JSON.stringify({ id: 'T1', state: 'done' })}\n\n`,
    ),
  );
  const subscription = ui.subscribeDialogueEvents('key');
  await flush();
  expect(ui.active.hidden).toBe(true);
  expect(ui.active.innerHTML).toBe('');
  subscription.stop();
});
test('PLAN and TASKS panels share the collapse rule; active agents sit above the input', () => {
  expect(html).toContain(
    "showDialoguePanel(document.getElementById('dialogue-plan'),",
  );
  expect(html).toContain(
    "showDialoguePanel(document.getElementById('dialogue-tasks-panel'),",
  );
  expect(html.indexOf('id="dialogue-tasks-panel"')).toBeLessThan(
    html.indexOf('id="dialogue-active"'),
  );
  expect(html.indexOf('id="dialogue-active"')).toBeLessThan(
    html.indexOf('class="input-area"'),
  );
});

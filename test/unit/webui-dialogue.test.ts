import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function harness() {
  const nodes: any[] = [];
  const list = { innerHTML: '' };
  const timers: Array<{ fn: () => Promise<void>; delay: number }> = [];
  const fetch = jest.fn();
  const context = {
    fetch,
    AbortController,
    TextDecoder,
    setTimeout: (fn: () => Promise<void>, delay: number) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout: jest.fn(),
    sessionHeaders: () => ({ 'x-clh-session': 'key' }),
    conversationHistory: [],
    escapeHtml: (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    document: { getElementById: () => list, createElement: () => ({}) },
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
      ';({subscribeDialogueEvents, startDialogueEvents, stopDialogueEvents})',
    context,
  );
  return { ...context, ...api, nodes, list, timers };
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

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
test.each(['discovering', 'none'])(
  'WebUI renders %s destination state',
  (state) => {
    const source = html.slice(
      html.indexOf('        function destinationWaitingText('),
      html.indexOf('        function enterLlmOnlyMode('),
    );
    const text = runInNewContext(
      source + `;destinationWaitingText('${state}')`,
    );
    expect(text.status).toBe(
      state === 'discovering' ? 'DISCOVERING DESTINATIONS…' : 'NO DESTINATIONS',
    );
    expect(text.message).toContain(
      state === 'discovering'
        ? 'Looking for SAP destinations…'
        : 'No SAP destinations are configured',
    );
  },
);

test('chat elapsed time includes synchronous transcript rendering before the request', () => {
  let now = 0;
  const statuses: string[] = [];
  const chatWindow = {
    get innerHTML() {
      return '';
    },
    set innerHTML(_value: string) {
      now += 10000;
    },
    insertAdjacentHTML() {
      now += 10000;
    },
    scrollTop: 0,
    scrollHeight: 0,
  };
  const source = html.slice(
    html.indexOf('        async function sendMessage()'),
    html.indexOf('            try {\n                const ragTools'),
  );
  runInNewContext(
    source + '\nstopTimer(); setStatus(elapsed()); }; sendMessage();',
    {
      chatSendSequence: 0,
      ready: true,
      hubSignedOut: false,
      userInput: { value: 'hello' },
      getSelectedDestination: () => 'DEV',
      inputHistory: [],
      historyIndex: 0,
      historyDraft: '',
      chatWindow,
      escapeHtml: (s: string) => s,
      lockInput: () => {},
      conversationHistory: [],
      Date: { now: () => now },
      setStatus: (s: string) => statuses.push(s),
      setInterval: () => 1,
      clearInterval: () => {},
    },
  );
  expect(statuses.at(-1)).toBe('20');
});

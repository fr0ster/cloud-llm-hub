import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
const start = html.indexOf('// Session settings are fetched each time;');
const script = html.slice(
  start,
  html.indexOf('async function openRagPanel()', start),
);

class Element {
  value = 'auto';
  checked = false;
  disabled = false;
  hidden = false;
  innerHTML = '';
  textContent = '';
  listeners: Record<string, () => void> = {};
  addEventListener(event: string, callback: () => void) {
    this.listeners[event] = callback;
  }
}

test.each([undefined, 4321])(
  'empty unchecked limits save null; off prefills base %s',
  async (baseValue) => {
    const nodes = new Map<string, Element>();
    const node = (id: string) => {
      let element = nodes.get(id);
      if (!element) {
        element = new Element();
        nodes.set(id, element);
      }
      return element;
    };
    const number = node('llm-limit-historyTokenBudget');
    number.value = '';
    const off = node('llm-off-historyTokenBudget');
    off.checked = true;
    const snapshot = {
      canEdit: true,
      settings: {},
      capabilities: {},
      effective: Object.fromEntries(
        ['coordinator', 'planner', 'executor', 'checker'].map((role) => [
          role,
          { source: 'default' },
        ]),
      ),
      limits: { historyTokenBudget: 'off' },
      effectiveLimits: {
        historyTokenBudget: { value: 'off', source: 'user', baseValue },
      },
    };
    const send = jest.fn(async (_url: string, _options: { body: string }) => ({
      ok: true,
      json: async () => snapshot,
    }));
    const save: Promise<void> = runInNewContext(
      `${script};
    llmSessionKey = sessionKey;
    renderLlmSettings(snapshot);
    off.checked = false;
    off.listeners.change();
    afterUncheck(number.value);
    number.value = '';
    number.listeners.input();
    saveLlmSettings();`,
      {
        document: { getElementById: node, querySelectorAll: () => [] },
        structuredClone,
        escapeHtml: (text: string) => text,
        sessionKey: 'one',
        sessionHeaders: () => ({}),
        snapshot,
        off,
        number,
        afterUncheck: (value: string) =>
          expect(value).toBe(baseValue === undefined ? '' : String(baseValue)),
        hubFetch: send,
      },
    );
    await save;
    expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({
      limits: { historyTokenBudget: null },
      executor: 'auto',
    });
    expect(node('llm-fields').innerHTML).toContain(' \u00b7 source:');
    expect(node('llm-fields').innerHTML).not.toContain(' ? source:');
  },
);

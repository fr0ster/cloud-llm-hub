import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');
type Listener = (event: { key: string }) => void;
class Select {
  value = '';
  disabled = false;
  options: { value: string; selected: boolean }[] = [];
  listeners: Record<string, Listener> = {};
  rebuilds = 0;
  set innerHTML(_html: string) {
    this.options = [];
    this.rebuilds++;
  }
  appendChild(option: { value: string; selected: boolean }) {
    this.options.push(option);
    if (option.selected || this.options.length === 1) this.value = option.value;
  }
  addEventListener(name: string, callback: Listener) {
    this.listeners[name] = callback;
  }
}
function harness() {
  let now = 0;
  const model = new Select();
  const classifier = new Select();
  const dest = new Select();
  const gate = new Select();
  const label = { innerText: 'main' };
  const overlay = { style: { display: 'none' } };
  const intervals = new Map<number, () => Promise<void>>();
  const listeners: Record<string, () => void> = {};
  const state = {
    ready: true,
    hubSignedOut: false,
    llmOnlyMode: false,
    gateDestinations: [] as { name: string; status: string }[],
    modelSelect: model,
    classifierSelect: classifier,
    destSelect: dest,
    Date: { now: () => now },
    document: {
      hidden: false,
      getElementById: (id: string) =>
        id === 'gate-dest' ? gate : id === 'planner-model' ? label : overlay,
      createElement: () => ({ value: '', textContent: '', selected: false }),
      addEventListener: (name: string, callback: () => void) => {
        listeners[name] = callback;
      },
    },
    hubFetch: jest.fn(async () => ({ json: async () => payload })),
    renderDestinations: (destinations: { name: string; status: string }[]) => {
      state.gateDestinations = destinations;
    },
    leaveLlmOnlyMode: () => {
      state.llmOnlyMode = false;
    },
    updateDestinationDiscovery: jest.fn(),
    setInterval: (callback: () => Promise<void>) => {
      intervals.set(1, callback);
      return 1;
    },
    clearInterval: (id: number) => {
      intervals.delete(id);
    },
  };
  const payload = {
    data: [{ id: 'main' }, { id: 'chosen' }],
    _active_model: 'main',
    _meta: { planner_model: 'swapped', classifier_model: 'main' },
    _destinations: [] as { name: string; status: string }[],
  };
  const source = html.slice(
    html.indexOf('        // Lazy hub state refresh'),
    html.indexOf('        // Destination diagnostic'),
  );
  const population = html.slice(
    html.indexOf('        function populateAuxSelect('),
    html.indexOf('        function populateAuxSelect(') +
      html
        .slice(html.indexOf('        function populateAuxSelect('))
        .indexOf('\n        }') +
      10,
  );
  const api: {
    refresh: () => Promise<void>;
    sync: () => void;
    turn: () => void;
  } = runInNewContext(
    source +
      population +
      `\nfunction releaseTurn() {\n${html.slice(html.indexOf('                if (released) return;', html.indexOf('async function sendMessage()')), html.indexOf('\n            }', html.indexOf('                if (released) return;', html.indexOf('async function sendMessage()'))))}\n}\nlet released = false; const sendToken = ''; function unlockInput() {}\n({refresh: refreshHubState, sync: syncHubStatePolling, turn: releaseTurn})`,
    state,
  );
  return {
    state,
    api,
    model,
    classifier,
    dest,
    gate,
    label,
    overlay,
    intervals,
    listeners,
    payload,
    advance: () => {
      now += 2001;
    },
  };
}

test('chat turn completion refreshes PLANNER after a hot-swap', async () => {
  const h = harness();
  h.api.turn();
  expect(h.state.hubFetch).toHaveBeenCalledTimes(1);
  await h.api.refresh();
  expect(h.state.hubFetch).toHaveBeenCalledTimes(1);
  expect(h.label.innerText).toBe('swapped');
});

test('normal ready state has no polling; dropdown triggers share requests and cooldown', async () => {
  const h = harness();
  h.api.sync();
  expect(h.intervals.size).toBe(0);
  for (const select of [h.model, h.classifier, h.gate]) {
    select.listeners.mousedown({ key: '' });
    select.listeners.focus({ key: '' });
    select.listeners.keydown({ key: 'ArrowDown' });
  }
  await h.api.refresh();
  await h.api.refresh();
  expect(h.state.hubFetch).toHaveBeenCalledTimes(1);
  h.advance();
  await h.api.refresh();
  expect(h.state.hubFetch).toHaveBeenCalledTimes(2);
});

test('refresh adds models and preserves offered user selections', async () => {
  const h = harness();
  h.model.value = 'chosen';
  h.classifier.value = 'chosen';
  h.payload.data.push({ id: 'new' });
  await h.api.refresh();
  expect(h.model.options.map((o) => o.value)).toContain('new');
  expect(h.model.value).toBe('chosen');
  expect(h.classifier.value).toBe('chosen');
  h.advance();
  h.payload.data = [{ id: 'main' }];
  await h.api.refresh();
  expect(h.model.value).toBe('main');
  expect(h.classifier.value).toBe('main');
});

test('an unchanged model list is not rebuilt, so an open dropdown stays open', async () => {
  const h = harness();
  await h.api.refresh();
  expect(h.model.rebuilds).toBe(1);
  h.model.value = 'chosen';
  h.advance();
  await h.api.refresh();
  expect(h.model.rebuilds).toBe(1);
  expect(h.model.value).toBe('chosen');
});

test('a configured model the list does not offer is still shown and selected', async () => {
  const h = harness();
  h.payload._meta.classifier_model = 'unlisted';
  await h.api.refresh();
  expect(h.classifier.options.map((o) => o.value)).toEqual([
    'unlisted',
    'main',
    'chosen',
  ]);
  expect(h.classifier.value).toBe('unlisted');
});

test('the gate does not poll for destinations that will not become ready', () => {
  const h = harness();
  h.overlay.style.display = 'flex';
  h.state.gateDestinations = [{ name: 'DEV', status: 'unreachable' }];
  h.api.sync();
  expect(h.intervals.size).toBe(0);
});

test('polling stops once the hub signs the user out', async () => {
  const h = harness();
  h.state.llmOnlyMode = true;
  h.api.sync();
  expect(h.intervals.size).toBe(1);
  h.state.hubSignedOut = true;
  await h.intervals.get(1)?.();
  expect(h.state.hubFetch).not.toHaveBeenCalled();
  expect(h.intervals.size).toBe(0);
});

test('LLM-only polling stops after destinations appear', async () => {
  const h = harness();
  h.state.llmOnlyMode = true;
  h.api.sync();
  expect(h.intervals.size).toBe(1);
  h.payload._destinations = [{ name: 'DEV', status: 'ready' }];
  await h.intervals.get(1)?.();
  expect(h.state.llmOnlyMode).toBe(false);
  expect(h.intervals.size).toBe(0);
});

test('gate polling stops when ready or closed; hidden pages never poll', async () => {
  const h = harness();
  h.overlay.style.display = 'flex';
  h.state.gateDestinations = [{ name: 'DEV', status: 'pending' }];
  h.api.sync();
  expect(h.intervals.size).toBe(1);
  h.state.document.hidden = true;
  h.listeners.visibilitychange();
  expect(h.intervals.size).toBe(0);
  h.state.document.hidden = false;
  h.payload._destinations = [{ name: 'DEV', status: 'ready' }];
  h.listeners.visibilitychange();
  await h.api.refresh();
  expect(h.intervals.size).toBe(0);
  h.state.gateDestinations[0].status = 'pending';
  h.api.sync();
  expect(h.intervals.size).toBe(1);
  h.overlay.style.display = 'none';
  h.api.sync();
  expect(h.intervals.size).toBe(0);
});

test('an unchanged gate destination list is not rebuilt; a status change is', () => {
  const gate = new Select();
  const gateSource = html.slice(
    html.indexOf('        function populateGateDestinations()'),
    html.indexOf('        function destinationUsesConfiguredAuth('),
  );
  const context = {
    gateDestinations: [{ name: 'DEV', status: 'vectorizing' }],
    updateGateAuthentication: () => {},
    document: {
      getElementById: () => gate,
      createElement: () => ({
        value: '',
        textContent: '',
        selected: false,
        disabled: false,
      }),
    },
  };
  const populate: () => void = runInNewContext(
    `${gateSource}\npopulateGateDestinations;`,
    context,
  );
  populate();
  populate();
  expect(gate.rebuilds).toBe(1);
  context.gateDestinations = [{ name: 'DEV', status: 'ready' }];
  populate();
  expect(gate.rebuilds).toBe(2);
});

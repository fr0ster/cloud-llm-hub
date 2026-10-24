import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync('app/chat/webapp/index.html', 'utf8');

test('the background models poll refreshes the PLANNER label after a hot-swap', async () => {
  const source = html.slice(
    html.indexOf('        // Periodically refresh destination statuses'),
    html.indexOf('        // Destination diagnostic'),
  );
  const label = { innerText: 'main-model' };
  let poll: (() => Promise<void>) | undefined;
  runInNewContext(source, {
    ready: true,
    llmOnlyMode: false,
    hubFetch: async () => ({
      json: async () => ({
        _meta: { planner_model: '<swapped-model>' },
        _destinations: [],
      }),
    }),
    renderDestinations: () => {},
    updateDestinationDiscovery: () => {},
    leaveLlmOnlyMode: () => {},
    document: {
      getElementById: (id: string) => (id === 'planner-model' ? label : {}),
    },
    setInterval: (fn: () => Promise<void>) => {
      poll = fn;
      return 1;
    },
  });
  await poll?.();
  expect(label.innerText).toBe('<swapped-model>');
});

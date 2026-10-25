import type { DialogueSignals } from '@mcp-abap-adt/llm-agent';
import { createSignalBus } from '@mcp-abap-adt/llm-signals';
import { closeDialogue, dialogueFor } from '../../srv/lib/dialogue-sessions';
import {
  dialogueSignals,
  setDialogueSignalsForTest,
} from '../../srv/lib/dialogue-signals';

jest.mock('../../srv/agent-manager', () => ({
  releasePlannerAgent: jest.fn(),
  buildPlannerAgent: jest.fn(async () => ({
    process: async () => ({ ok: true, value: { content: 'Hello' } }),
  })),
  getSmartAgent: jest.fn(async () => ({
    workers: new Map(),
    recMcp: { getToolRecords: () => [], dropRequest: jest.fn() },
    criticLlm: {},
  })),
}));

const key = 'signals-test';

beforeEach(() => {
  setDialogueSignalsForTest(createSignalBus<DialogueSignals>());
});

afterEach(async () => {
  await closeDialogue('alice', key, 'ttl');
  setDialogueSignalsForTest(undefined);
});

test('a dialogue session publishes to the hub bus', async () => {
  const handle = await dialogueFor('alice', key, 'TEST');
  await handle.session.send('Hello');
  expect(
    dialogueSignals().last('dialogue.turn.settled', key)?.payload,
  ).toMatchObject({ outcome: 'ok' });
});

test('closing retires the source', async () => {
  const handle = await dialogueFor('alice', key, 'TEST');
  await handle.session.send('Hello');
  expect(dialogueSignals().lastAll(key).length).toBeGreaterThan(0);
  await closeDialogue('alice', key, 'explicit');
  expect(dialogueSignals().lastAll(key)).toEqual([]);
});

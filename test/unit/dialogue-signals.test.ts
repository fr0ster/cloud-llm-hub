import {
  createDialogueTaskContext,
  type DialogueSignals,
  finishDialogueTask,
  type ISignalSubscriber,
} from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '@mcp-abap-adt/llm-agent-libs';
import { createSignalBus } from '@mcp-abap-adt/llm-signals';
import { closeDialogue, dialogueFor } from '../../srv/lib/dialogue-sessions';
import {
  dialogueSignals,
  setDialogueSignalsForTest,
} from '../../srv/lib/dialogue-signals';

jest.mock('../../srv/agent-manager', () => ({
  getSystemToolTrust: () => () => undefined,
  isEmbeddedSystemTool: () => false,
  getTrustResolver: () =>
    jest
      .requireActual<typeof import('./helpers/agent-profiles')>(
        './helpers/agent-profiles',
      )
      .fixtureTrustResolver(),
  createAgentProfileSource: () => ({
    list: async () => ({ ok: true, value: [] }),
    getPrompts: async () => ({
      ok: true,
      value: { planner: '', workerBase: '' },
    }),
  }),
  releasePlannerAgent: jest.fn(),
  buildPlannerAgent: jest.fn(async () => ({
    process: async () => ({ ok: true, value: { content: 'Hello' } }),
  })),
  getSmartAgent: jest.fn(async () => ({
    profileRunner: {
      preparePlanner: async () => ({
        ok: true,
        value: {
          process: async () => ({ ok: true, value: { content: 'Hello' } }),
        },
      }),
    },
    workers: new Map(),
    recMcp: {
      hadWriteCapability: () => false,
      openSession(): void {},
      hadSessionWriteCapability: () => false,
      writeGeneration: () => 0,
      markReviewed(): void {},
      closeSession(): void {},
      withSession: <T>(_userId: string, _sessionId: string, run: () => T): T =>
        run(),
      getToolRecords: () => [],
      dropRequest: jest.fn(),
    } satisfies Pick<
      import('../../srv/lib/recording-mcp-client').RecordingMcpClient,
      | 'hadWriteCapability'
      | 'getToolRecords'
      | 'dropRequest'
      | 'openSession'
      | 'hadSessionWriteCapability'
      | 'writeGeneration'
      | 'markReviewed'
      | 'closeSession'
      | 'withSession'
    >,
    criticLlm: {},
  })),
}));

const key = 'signals-test';
const source = JSON.stringify(['alice', key]);

beforeEach(() => {
  setDialogueSignalsForTest(createSignalBus<DialogueSignals>());
});

afterEach(async () => {
  await closeDialogue('alice', key, 'ttl');
  await closeDialogue('bob', key, 'ttl');
  setDialogueSignalsForTest(undefined);
});

test('a dialogue session publishes to the hub bus', async () => {
  const open = jest.spyOn(DialogueSession, 'open');
  const handle = await (async () => {
    try {
      const result = await dialogueFor('alice', key, 'TEST');
      // The library uses this id for planner recall and usage attribution.
      expect(open.mock.calls.at(-1)?.[0].id).toBe(key);
      return result;
    } finally {
      open.mockRestore();
    }
  })();
  await handle.session.send('Hello');
  expect(
    dialogueSignals().last('dialogue.turn.settled', source)?.payload,
  ).toMatchObject({ outcome: 'ok' });
});

test('library finish reads stay in the owning session slot and rewrite the source', async () => {
  const open = jest.spyOn(DialogueSession, 'open');
  try {
    await dialogueFor('alice', key, 'TEST');
    const emitter = open.mock.calls.at(-1)?.[0].signals;
    if (!emitter || !('last' in emitter) || typeof emitter.last !== 'function')
      throw new Error('Session signals must support retained reads');
    // Check the production wrapper with the exact subscriber signature.
    const last = emitter.last as ISignalSubscriber<DialogueSignals>['last'];
    const bus = dialogueSignals();
    const otherSource = JSON.stringify(['bob', key]);
    const otherSession = JSON.stringify(['alice', 'other-session']);
    const payload = {
      taskId: 'checker',
      runId: 'run',
      output: 'other verdict',
    };
    bus.emit('dialogue.task.finish', payload, otherSource, 'run');
    bus.emit('dialogue.task.finish', payload, otherSession, 'run');
    for (const requestedSource of [key, otherSource, otherSession])
      expect(
        last('dialogue.task.finish', requestedSource, 'run'),
      ).toBeUndefined();
    const task = createDialogueTaskContext(
      { ...emitter, last },
      key,
      'checker',
    );
    finishDialogueTask(task, '{"verdict":"pass"}', 'submit_verdict');
    expect(last('dialogue.task.finish', key, task.runId)).toMatchObject({
      source: key,
      key: task.runId,
      payload: { output: '{"verdict":"pass"}' },
    });
    expect(task.readFinish()?.output).toBe('{"verdict":"pass"}');
    expect(bus.last('dialogue.task.finish', source, task.runId)?.source).toBe(
      source,
    );
    expect(
      bus.last('dialogue.task.finish', otherSource, task.runId),
    ).toBeUndefined();
  } finally {
    open.mockRestore();
  }
});

test('closing retires the source', async () => {
  const handle = await dialogueFor('alice', key, 'TEST');
  await handle.session.send('Hello');
  expect(dialogueSignals().lastAll(source).length).toBeGreaterThan(0);
  await closeDialogue('alice', key, 'explicit');
  expect(dialogueSignals().lastAll(source)).toEqual([]);
});

test('closing one user does not retire another user with the same logical key', async () => {
  const alice = await dialogueFor('alice', key, 'TEST');
  const bob = await dialogueFor('bob', key, 'TEST');
  await alice.session.send('Hello');
  await bob.session.send('Hello');
  const bobSource = JSON.stringify(['bob', key]);
  expect(dialogueSignals().lastAll(bobSource).length).toBeGreaterThan(0);
  await closeDialogue('alice', key, 'explicit');
  expect(dialogueSignals().lastAll(source)).toEqual([]);
  expect(dialogueSignals().lastAll(bobSource).length).toBeGreaterThan(0);
  await bob.session.send('Still here');
  expect(
    dialogueSignals().last('dialogue.turn.settled', bobSource)?.payload,
  ).toMatchObject({ outcome: 'ok' });
});

import type { ILlm, ISubAgentInput } from '@mcp-abap-adt/llm-agent';
import { sessionCollectionId } from '../../srv/collection-ids';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import {
  checkerRagResultProvenance,
  readCheckerSource,
} from '../../srv/lib/checker-source';
import {
  createCheckerWorker,
  withCheckerBrief,
} from '../../srv/lib/checker-verdict';
import {
  type CheckerClaim,
  type CheckerVerdict,
  verdictSchema,
} from '../../srv/lib/checker-verdict-schema';
import { runWithDialogueRagTools } from '../../srv/lib/dialogue-rag-scope';
import { systemToolTrust } from '../../srv/lib/system-tool-trust';
import { createTaskResultStore } from '../../srv/lib/task-result-store';
import type { JournalEntry } from '../../srv/lib/tool-journal';
import { parseTrustDefaults } from '../../srv/lib/trust';
import {
  resolverFor,
  runWithTrustResolver,
  TrustResolver,
} from '../../srv/lib/trust-resolver';
import { CollectionRegistry } from '../../srv/rag-collections';
import { runWithProfileTools } from '../../srv/request-session';
import { bindTestCaller } from './helpers/bind-test-caller';

const entry: JournalEntry = {
  call: {
    id: 'create',
    name: 'CreateTransportTask',
    arguments: { transport_number: 'PARENT' },
  },
  result: { content: { success: true, task_number: 'TASK' } },
  answered: true,
  system: 'sap',
  write: true,
};
const write: CheckerClaim = {
  claim: 'I created transport task TASK.',
  system: 'sap',
  target: { type: 'transport', name: 'TASK' },
  evidence: { callId: entry.call.id },
};
const source: CheckerClaim = {
  claim: 'The record says the batch has finished.',
  system: 'source',
  target: { scope: 'session', collection: 'task-results' },
  evidence: { recordId: 'report', quote: 'batch has finished' },
};
const input: ISubAgentInput = {
  task: 'Library-added context must stay out of the checker.',
  caller: { userId: 'test-user', sessionId: 'test-session', isAdmin: false },
  sessionId: 'test-session',
};

beforeAll(() => bindTestCaller(input.caller));

function finding(
  claim: CheckerClaim,
  status: CheckerVerdict['findings'][number]['status'],
) {
  return {
    claim: claim.claim,
    status,
    evidence: claim.evidence,
    reason: 'Assessment of the cited evidence.',
  };
}
function checker(
  verdict: CheckerVerdict,
  recordText = 'The batch has finished.',
  registry?: CollectionRegistry,
) {
  const llm: ILlm = {
    chat: jest.fn(async () => ({
      ok: true as const,
      value: {
        content: '',
        finishReason: 'tool_calls' as const,
        toolCalls: [
          { id: 'verdict', name: 'submit_verdict', arguments: verdict },
        ],
      },
    })),
    async *streamChat() {},
  };
  const read = jest.fn<
    ReturnType<Parameters<typeof createCheckerWorker>[4]>,
    Parameters<Parameters<typeof createCheckerWorker>[4]>
  >(
    registry
      ? (caller, target, id) => readCheckerSource(registry, caller, target, id)
      : async () => ({ text: recordText }),
  );
  const worker = createCheckerWorker(
    'checker',
    '',
    'Check only cited evidence.',
    llm,
    read,
    (caller, entry, target) => {
      if (!registry) return undefined;
      return 'scope' in target
        ? checkerRagResultProvenance(registry, caller, target)
        : systemToolTrust(
            (name) => name === 'CreateTransportTask',
            resolverFor(registry),
          )(entry.call.name);
    },
  );
  return { worker, llm, read };
}

const note: CheckerClaim = {
  ...source,
  target: { scope: 'session', collection: 'notes' },
};
const checkerOnly = new AgentToolPermissions(['submit_verdict']);
const withRead = new AgentToolPermissions(['submit_verdict', 'rag_read']);

async function notes(caller = input.caller) {
  const registry = new CollectionRegistry();
  const id = sessionCollectionId('notes', caller.userId, caller.sessionId);
  await registry.getOrCreateCollection({
    id,
    logicalId: 'notes',
    displayName: 'Notes',
    description: '',
    scope: 'session',
    owner: caller.userId,
    sessionId: caller.sessionId,
  });
  await registry.addDocument(id, {
    id: 'report',
    text: 'The batch has finished.',
    metadata: {},
  });
  return { registry, id };
}

test.each(['profile', 'parent profile'])(
  'enforces rag_read for ordinary source records with a restrictive %s',
  async (restricted) => {
    const { registry } = await notes();
    const getDocument = jest.spyOn(registry, 'getDocument');
    const { worker, llm } = checker(
      { verdict: 'pass', findings: [finding(note, 'confirmed')] },
      undefined,
      registry,
    );
    const run = () =>
      runWithDialogueRagTools(() =>
        worker.run({ ...input, task: JSON.stringify([note]) }),
      );
    const result = await runWithProfileTools(checkerOnly, () =>
      restricted === 'profile' ? run() : runWithProfileTools(withRead, run),
    );
    expect(result.output).toBe('unusable verdict: missing or invalid findings');
    expect(getDocument).not.toHaveBeenCalled();
    expect(jest.mocked(llm.chat).mock.calls[0][0][1].content).not.toContain(
      'The batch has finished.',
    );
  },
);

test('keeps the own task-results exception within dialogue workers and the caller session', async () => {
  const registry = new CollectionRegistry();
  const { userId, sessionId } = input.caller;
  const store = createTaskResultStore(registry, {
    userId,
    sessionKey: sessionId,
  });
  const stored = await store.put({
    id: 'report',
    worker: 'executor',
    goal: 'Check the batch',
    result: 'report',
    outcome: 'done',
    summary: 'Batch report',
    output: 'The batch has finished.',
  });
  expect(stored.ok).toBe(true);
  const read = (caller = input.caller) =>
    readCheckerSource(registry, caller, source.target, 'report');
  await runWithProfileTools(checkerOnly, async () => {
    expect(await read()).toBeUndefined();
    await runWithDialogueRagTools(async () => {
      expect(await read()).toMatchObject({ text: 'The batch has finished.' });
      expect(
        await read({ ...input.caller, sessionId: 'other-session' }),
      ).toBeUndefined();
      expect(
        await read({ ...input.caller, userId: 'someone-else' }),
      ).toBeUndefined();
    });
  });
});

test('enforces the user ACL even with rag_read allowed by the profile', async () => {
  const { registry, id } = await notes({
    ...input.caller,
    userId: 'someone-else',
    sessionId: 'foreign-session',
  });
  const getCollection = registry.getCollection.bind(registry);
  const foreign = await getCollection(id);
  // Model an address that resolves to another owner's collection.
  jest.spyOn(registry, 'getCollection').mockResolvedValue(foreign);
  const getDocument = jest.spyOn(registry, 'getDocument');
  await expect(
    runWithProfileTools(withRead, () =>
      readCheckerSource(registry, input.caller, note.target, 'report'),
    ),
  ).resolves.toBeUndefined();
  expect(getDocument).not.toHaveBeenCalled();
});

test.each([
  { expected: 1.5 },
  { collection: 2.5, expected: 2.5 },
  { collection: 2.5, record: 3.5, expected: 3.5 },
])(
  'frames source, RAG and SAP journal evidence with effective trust: $expected',
  async ({ collection, record, expected }) => {
    const { registry, id } = await notes();
    if (collection !== undefined)
      await registry.updateCollection(id, { trust: collection });
    if (record !== undefined)
      await registry.setRecordTrust(id, 'report', record, input.caller.userId);
    const ragEntry: JournalEntry = {
      ...entry,
      call: {
        id: 'rag-add',
        name: 'record_add',
        arguments: { collection: note.target, record: 'report' },
      },
      result: {
        content: {
          collection: 'session/notes',
          record: 'report',
          created: true,
        },
      },
      system: 'rag',
    };
    const ragClaim: CheckerClaim = {
      claim: 'Added a note.',
      system: 'rag',
      target: { ...note.target, record: 'report' },
      evidence: { callId: ragEntry.call.id },
    };
    const claims = [note, ragClaim, write];
    const { worker, llm } = checker(
      {
        verdict: 'pass',
        findings: claims.map((claim) => finding(claim, 'confirmed')),
      },
      undefined,
      registry,
    );
    const resolver = new TrustResolver(
      registry,
      undefined,
      parseTrustDefaults(undefined),
    ).forProfile({ trust: { session: 1.5, target: 4.5 } });
    const result = await runWithTrustResolver(resolver, () =>
      runWithProfileTools(withRead, () =>
        withCheckerBrief(
          {
            claims: JSON.stringify(claims),
            journal: new Map([
              [entry.call.id, entry],
              [ragEntry.call.id, ragEntry],
            ]),
          },
          () => worker.run(input),
        ),
      ),
    );
    expect(JSON.parse(result.output)).toMatchObject({ verdict: 'pass' });
    const prompt = jest.mocked(llm.chat).mock.calls[0][0][1].content;
    expect(JSON.parse(prompt ?? '')).toMatchObject([
      {
        cited: {
          content: 'The batch has finished.',
          provenance: `[source: session:Notes/report; trust ${expected}]`,
        },
      },
      {
        cited: {
          provenance: `[source: session:Notes/report; trust ${expected}]`,
        },
      },
      {
        cited: {
          provenance: '[source: target:CreateTransportTask; trust 4.5]',
        },
      },
    ]);
  },
);

test('confirms a typed write and an exact source quote from only the cited records', async () => {
  const verdict: CheckerVerdict = {
    verdict: 'pass',
    findings: [finding(write, 'confirmed'), finding(source, 'confirmed')],
  };
  const { worker, llm, read } = checker(verdict);
  const result = await withCheckerBrief(
    {
      claims: JSON.stringify([write, source]),
      journal: new Map([
        [entry.call.id, entry],
        [
          'other',
          {
            ...entry,
            result: { content: 'UNRELATED_PRIVATE_RESULT' },
          },
        ],
      ]),
    },
    () => worker.run(input),
  );
  expect(verdictSchema.parse(JSON.parse(result.output))).toEqual(verdict);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(input.caller, source.target, 'report');
  const [messages, tools] = jest.mocked(llm.chat).mock.calls[0];
  expect(messages[1].content).toContain('TASK');
  expect(messages[1].content).not.toContain('UNRELATED_PRIVATE_RESULT');
  expect(messages[1].content).not.toContain(input.task);
  expect(tools?.map(({ name }) => name)).toEqual(['submit_verdict']);
});

test('preserves the verified item count in the verdict output for a batch check', async () => {
  const batchItem: CheckerClaim = {
    ...source,
    claim: 'Batch item A was processed.',
    evidence: { recordId: 'report', quote: 'Batch item A was processed.' },
  };
  const verdict: CheckerVerdict = {
    verdict: 'pass',
    count: 1,
    findings: [finding(batchItem, 'confirmed')],
  };
  const { worker } = checker(verdict, 'Batch item A was processed.');
  const result = await worker.run({
    ...input,
    task: JSON.stringify([batchItem]),
  });
  expect(verdictSchema.parse(JSON.parse(result.output))).toEqual(verdict);
});

test.each([
  { cited: { ...entry, answered: false }, claim: write, reason: 'unconfirmed' },
  {
    cited: {
      ...entry,
      call: {
        ...entry.call,
        name: 'AddTransportObject',
        arguments: { transport_number: 'TASK' },
      },
      result: { content: { accepted: true, added: 'unknown' } },
    },
    claim: { ...write, claim: 'Attached an object to TASK.' },
    reason: 'unconfirmed',
  },
  { cited: { ...entry, write: false }, claim: write, reason: 'a read' },
  {
    cited: { ...entry, system: 'rag' as const },
    claim: write,
    reason: 'different system',
  },
  {
    cited: entry,
    claim: { ...write, target: { type: 'transport', name: 'PARENT' } },
    reason: 'claimed target',
  },
  {
    cited: entry,
    claim: { ...write, evidence: {} },
    reason: 'missing a journal call id',
  },
  { cited: entry, claim: source, reason: 'quote is absent' },
])(
  'returns unsupported when the evidence has an issue: $reason',
  async ({ cited, claim, reason }) => {
    const verdict: CheckerVerdict = {
      verdict: 'fail',
      findings: [finding(claim, 'unsupported')],
    };
    const { worker, llm } = checker(verdict, 'The batch is still running.');
    const result = await withCheckerBrief(
      {
        claims: JSON.stringify([claim]),
        journal: new Map([[entry.call.id, cited]]),
      },
      () => worker.run(input),
    );
    expect(JSON.parse(result.output)).toMatchObject({
      verdict: 'fail',
      findings: [
        { ...verdict.findings[0], reason: expect.stringContaining(reason) },
      ],
    });
    expect(result.summary).toContain(claim.claim);
    expect(jest.mocked(llm.chat).mock.calls[0][0][1].content).toContain(reason);
  },
);

test('accepts a refutation of a claimed write cited to a failed call', async () => {
  const verdict: CheckerVerdict = {
    verdict: 'fail',
    findings: [finding(write, 'refuted')],
  };
  const { worker } = checker(verdict);
  const result = await withCheckerBrief(
    {
      claims: JSON.stringify([write]),
      journal: new Map([
        [
          entry.call.id,
          {
            ...entry,
            result: { content: { task_number: 'TASK', success: false } },
          },
        ],
      ]),
    },
    () => worker.run(input),
  );
  expect(JSON.parse(result.output)).toEqual(verdict);
  expect(result.summary).toContain('refuted (create)');
});

test.each([
  { verdict: 'pass', findings: [finding(write, 'unsupported')] },
  {
    verdict: 'pass',
    findings: [finding({ ...write, claim: 'Fabricated.' }, 'confirmed')],
  },
  {
    verdict: 'pass',
    findings: [
      finding({ ...write, evidence: { callId: 'fabricated' } }, 'confirmed'),
    ],
  },
  { verdict: 'pass', findings: [] },
] satisfies CheckerVerdict[])(
  'reports invalid verdicts as unusable: %j',
  async (verdict) => {
    const { worker, llm } = checker(verdict);
    const result = await withCheckerBrief(
      {
        claims: JSON.stringify([write]),
        journal: new Map([[entry.call.id, entry]]),
      },
      () => worker.run(input),
    );
    expect(result.output).toBe('unusable verdict: missing or invalid findings');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  },
);

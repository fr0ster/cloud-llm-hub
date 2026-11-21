import type { ILlm, ISubAgentInput } from '@mcp-abap-adt/llm-agent';
import {
  createCheckerWorker,
  withCheckerBrief,
} from '../../srv/lib/checker-verdict';
import {
  type CheckerClaim,
  type CheckerVerdict,
  verdictSchema,
} from '../../srv/lib/checker-verdict-schema';
import type { JournalEntry } from '../../srv/lib/tool-journal';

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
  const read = jest.fn(async () => recordText);
  const worker = createCheckerWorker(
    'checker',
    '',
    'Check only cited evidence.',
    llm,
    read,
  );
  return { worker, llm, read };
}

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

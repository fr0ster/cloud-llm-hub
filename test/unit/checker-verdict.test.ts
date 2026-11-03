import { readFileSync } from 'node:fs';
import type { DialogueState, ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import {
  bindCheckerVerdict as bind,
  type CheckerInputs,
  checkerInputs,
} from '../../srv/lib/checker-verdict';

const context = {
  checkedOutputs: ['The object is active.'],
  checkedToolResults: [],
  dependencyOutputs: ['inactive'],
  briefContext: '',
  briefGoal: '',
  records: [],
} satisfies CheckerInputs;
const bindCheckerVerdict = (
  output: string,
  inputs: CheckerInputs,
  brief: string,
  records: ToolCallRecord[],
) => bind(output, { ...inputs, briefGoal: brief, records });
const fail = (quote = 'The object is active.', evidence = 'inactive') =>
  JSON.stringify({
    verdict: 'fail',
    claims: [
      { quote, evidence, reason: 'Task t1 evidence contradicts active status' },
    ],
  });

test('fail binds exact quote and evidence with normalized whitespace', () => {
  const output = fail('The  object\nis active.');
  expect(bindCheckerVerdict(output, context, '', [])).toBe(output);
});
test('absent checked-result quote is unusable', () => {
  expect(bindCheckerVerdict(fail('Invented claim'), context, '', [])).toBe(
    'unusable verdict: quote_absent',
  );
});
test('fabricated evidence is unusable', () => {
  expect(
    bindCheckerVerdict(fail(undefined, 'result: deleted'), context, '', []),
  ).toBe('unusable verdict: evidence_absent');
});
test.each([
  'The object is active.',
  'result to check: step work',
  'tools used by task t1',
  'ReadObject | ok',
])(
  'checked output and generated framing cannot supply evidence: %s',
  (evidence) => {
    expect(bindCheckerVerdict(fail(undefined, evidence), context, '', [])).toBe(
      'unusable verdict: evidence_absent',
    );
  },
);
test('dependency results supply evidence without their headings', () => {
  const dependency = { ...context, dependencyOutputs: ['Object is inactive'] };
  const output = fail(undefined, 'Object is inactive');
  expect(bindCheckerVerdict(output, dependency, '', [])).toBe(output);
  expect(
    bindCheckerVerdict(
      fail(undefined, 'result of step source'),
      dependency,
      '',
      [],
    ),
  ).toBe('unusable verdict: evidence_absent');
});
test('checker tool results and brief source inputs supply evidence', () => {
  const output = fail(undefined, 'Object is inactive');
  expect(bindCheckerVerdict(output, context, 'Object is inactive', [])).toBe(
    output,
  );
  for (const content of [
    'Object is inactive',
    [{ type: 'text' as const, text: 'Object is inactive' }],
  ]) {
    expect(
      bindCheckerVerdict(output, context, '', [
        {
          call: { id: 'read', name: 'ReadObject', arguments: {} },
          result: { content },
        },
      ]),
    ).toBe(output);
  }
});
test.each([
  'Object is "inactive"',
  'Object is\n"inactive"\nPending activation',
])('accepts quoted and multiline evidence from MCP text: %s', (text) => {
  const output = fail(undefined, text);
  for (const content of [text, [{ type: 'text', text }]]) {
    expect(
      bindCheckerVerdict(output, { ...context, dependencyOutputs: [] }, '', [
        {
          call: { id: 'read', name: 'ReadObject', arguments: {} },
          result: { content },
        },
      ]),
    ).toBe(output);
  }
});

test.each(['FAIL', '{"verdict":"fail"}', '{"verdict":"fail","claims":[]}'])(
  'unbound failure %s is unusable',
  (output) => {
    expect(bindCheckerVerdict(output, context, '', [])).toMatch(
      /^unusable verdict:/,
    );
  },
);
test('none provided explicitly binds an unsupported claim', () => {
  const output = fail(undefined, 'none provided');
  expect(bindCheckerVerdict(output, context, '', [])).toBe(output);
});
test.each(['PASS', '{"verdict":"pass","count":2,"note":"ok"}'])(
  'pass compatibility: %s',
  (output) => expect(bindCheckerVerdict(output, context, '', [])).toBe(output),
);
test('a quote from the brief alone cannot bind', () => {
  expect(
    bindCheckerVerdict(fail('Other claim'), context, 'Other claim', []),
  ).toBe('unusable verdict: quote_absent');
});
test('coordinator profile prescribes no check rules and stays within budget', () => {
  const profile = readFileSync('srv/agent-profiles/coordinator.md', 'utf8');
  expect(profile.length).toBeLessThanOrEqual(4300);
  for (const rule of [
    'run a planned check',
    'skip a planned check',
    'add an unplanned check',
    'Checks are decisions',
  ])
    expect(profile).not.toContain(rule);
  expect(profile).toContain('plan_revise');
});

test('non-verdict output remains undecided', () => {
  expect(bindCheckerVerdict('Cannot verify yet', context, '', [])).toBe(
    'unusable verdict: invalid_envelope',
  );
});

test('discarded verdict logs contain only reason codes and counts', () => {
  const warn = jest
    .spyOn(cds.log('checker-verdict'), 'warn')
    .mockImplementation(() => {});
  try {
    bindCheckerVerdict(
      fail('PRIVATE_CLAIM', 'PRIVATE_EVIDENCE'),
      context,
      '',
      [],
    );
    expect(warn).toHaveBeenCalledWith('discarded checker verdict', {
      reason: 'quote_absent',
      claims: 1,
      validClaims: 0,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /PRIVATE_CLAIM|PRIVATE_EVIDENCE/,
    );
  } finally {
    warn.mockRestore();
  }
});
test('every failure claim must bind, including claims after a valid one', () => {
  const output = JSON.stringify({
    verdict: 'fail',
    claims: [
      {
        quote: 'The object is active.',
        evidence: 'inactive',
        reason: 'Task t1 contradicts this',
      },
      {
        quote: 'Fabricated quote',
        evidence: 'none provided',
        reason: 'Unsupported',
      },
    ],
  });
  expect(bindCheckerVerdict(output, context, '', [])).toBe(
    'unusable verdict: quote_absent',
  );
});

test.each([
  { verdict: 'pass', count: '2' },
  { verdict: 'pass', count: null },
  { verdict: 'pass', note: 2 },
  { verdict: 'pass', note: null },
  { verdict: 'other' },
  { verdict: 'fail' },
  { verdict: 'PASS' },
  { verdict: 'fail', count: '2', claims: [] },
  { verdict: 'fail', note: false, claims: [] },
  {
    verdict: 'fail',
    claims: [
      { quote: 'The object is active.', evidence: 'inactive', reason: 2 },
    ],
  },
])('rejects invalid downstream envelope: %j', (envelope) => {
  expect(bindCheckerVerdict(JSON.stringify(envelope), context, '', [])).toBe(
    'unusable verdict: invalid_envelope',
  );
});

test('accepts complete valid fail envelope', () => {
  const output = JSON.stringify({
    ...JSON.parse(fail()),
    count: 1,
    note: 'checked',
  });
  expect(bindCheckerVerdict(output, context, '', [])).toBe(output);
});

const snapshot = (report: string): DialogueState => ({
  conversation: [],
  pending: [],
  savedAt: 0,
  tasks: [
    {
      id: 't0',
      worker: 'reader',
      goal: 'Read',
      state: 'done',
      createdAt: 0,
      output: 'Object is inactive',
    },
    {
      id: 't1',
      worker: 'writer',
      goal: 'Report',
      state: 'done',
      createdAt: 0,
      output: report,
    },
    {
      id: 't2',
      worker: 'checker',
      goal: 'Check report',
      state: 'running',
      createdAt: 0,
    },
  ],
  plan: {
    version: 1,
    status: 'active',
    steps: [
      {
        id: 'source',
        goal: 'Read',
        state: 'done',
        taskIds: ['t0'],
        successfulWorkTaskId: 't0',
      },
      {
        id: 'work',
        goal: 'Report',
        state: 'done',
        taskIds: ['t1'],
        successfulWorkTaskId: 't1',
        dependsOn: ['source'],
      },
      {
        id: 'check',
        goal: 'Check report',
        state: 'running',
        taskIds: ['t2'],
        workTaskId: 't2',
        dependsOn: ['work'],
        checkedTaskIds: { work: 't1' },
      },
    ],
  },
});

test('report headings cannot turn checked content into independent evidence', () => {
  const state = snapshot(
    'The object is active.\n\n[Details]\nObject is inactive',
  );
  state.conversation = [];
  state.tasks = state.tasks.filter((task) => task.id !== 't0');
  expect(
    bind(
      fail(undefined, 'Object is inactive'),
      checkerInputs(state, 't2', 'Check report', []),
    ),
  ).toBe('unusable verdict: evidence_absent');
});

test('another dependency output supplies independent evidence', () => {
  const state = snapshot('The object is active.');
  state.conversation = [];
  const inputs = checkerInputs(state, 't2', 'Check report', []);
  expect(inputs.checkedOutputs).toEqual(['The object is active.']);
  expect(inputs.dependencyOutputs).toEqual(['Object is inactive']);
  const output = fail(undefined, 'Object is inactive');
  expect(bind(output, inputs)).toBe(output);
});

test.each(['Object is inactive', 'Object is\n"inactive"'])(
  'checked task trace results supply independent evidence: %s',
  (resultExcerpt) => {
    const state = snapshot('The object is active.\nReport-only evidence');
    state.tasks = state.tasks.filter((task) => task.id !== 't0');
    const checked = state.tasks.find((task) => task.id === 't1');
    if (!checked) throw new Error('Missing checked task');
    checked.toolTrace = {
      entries: [
        {
          sequence: 1,
          toolName: 'ReadObject',
          arguments: 'Argument-only evidence',
          resultExcerpt,
          outcome: 'ok',
        },
      ],
      omittedCount: 0,
      complete: true,
    };
    state.tasks.push({
      ...checked,
      id: 'unrelated',
      toolTrace: {
        ...checked.toolTrace,
        entries: [
          {
            ...checked.toolTrace.entries[0],
            resultExcerpt: 'Unrelated trace evidence',
          },
        ],
      },
    });
    const inputs = checkerInputs(state, 't2', 'Check report', []);
    expect(inputs.checkedToolResults).toEqual([resultExcerpt]);
    const output = fail(undefined, resultExcerpt);
    expect(bind(output, inputs)).toBe(output);
    for (const evidence of [
      'Report-only evidence',
      'The object is active.',
      'Argument-only evidence',
      'ReadObject',
      'Unrelated trace evidence',
    ]) {
      expect(bind(fail(undefined, evidence), inputs)).toBe(
        'unusable verdict: evidence_absent',
      );
    }
    delete checked.toolTrace;
    expect(bind(output, checkerInputs(state, 't2', 'Check report', []))).toBe(
      'unusable verdict: evidence_absent',
    );
  },
);

test('structured coordinator brief context supplies evidence', () => {
  const state = snapshot('The object is active.');
  state.tasks = state.tasks.filter((task) => task.id !== 't0');
  const inputs = checkerInputs(
    state,
    't2',
    'Check report',
    [],
    'Brief source: Object is inactive',
  );
  expect(inputs.briefContext).toBe('Brief source: Object is inactive');
  const output = fail(undefined, 'Object is inactive');
  expect(bind(output, inputs)).toBe(output);
});

import { readFileSync } from 'node:fs';
import cds from '@sap/cds';
import { bindCheckerVerdict } from '../../srv/lib/checker-verdict';

const context =
  '[result to check: step work (task t1)]\nThe object is active.\n[tools used by task t1]\n1. ReadObject | ok\n   result: inactive';
const fail = (quote = 'The object is active.', evidence = 'result: inactive') =>
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
    'unusable verdict: invalid_verdict',
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
        evidence: 'result: inactive',
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

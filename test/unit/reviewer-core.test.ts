import { evaluateDeterministic } from '../../srv/lib/reviewer-core';

describe('evaluateDeterministic', () => {
  it('flags an unverified activate when create ran but activate did not (ZDEMO_D_MATNR)', () => {
    const content =
      'Domain ZDEMO_D_MATNR was created and has been successfully activated.';
    const verdict = evaluateDeterministic(content, [
      'CreateDomain',
      'ReadDomain',
    ]);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.issues).toHaveLength(1);
    expect(verdict.issues[0]).toEqual({
      kind: 'unverified-write',
      claimedOp: 'activated',
      expectedToolFamily: 'Activate*',
      observedTools: ['CreateDomain', 'ReadDomain'],
    });
  });

  it('is clean when both create and activate tools ran', () => {
    const content =
      'Domain ZDEMO_D_MATNR was created and has been successfully activated.';
    const verdict = evaluateDeterministic(content, [
      'CreateDomain',
      'ActivateDomain',
    ]);

    expect(verdict).toEqual({ ok: true });
  });

  it('is clean on an honest refusal (no completed-write claim)', () => {
    const content = 'I could not create it.';
    const verdict = evaluateDeterministic(content, []);

    expect(verdict).toEqual({ ok: true });
  });

  it('flags an unverified delete when no delete tool ran', () => {
    const content = 'The table entry was deleted successfully.';
    const verdict = evaluateDeterministic(content, ['ReadTable']);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.issues).toHaveLength(1);
    expect(verdict.issues[0]).toEqual({
      kind: 'unverified-write',
      claimedOp: 'deleted',
      expectedToolFamily: 'Delete*',
      observedTools: ['ReadTable'],
    });
  });
});

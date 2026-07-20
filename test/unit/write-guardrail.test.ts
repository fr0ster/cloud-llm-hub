import {
  applyWriteGuardrail,
  claimsCompletedWrite,
  extractExecutedTools,
  hasWriteTool,
} from '../../srv/lib/write-guardrail';

describe('extractExecutedTools', () => {
  it('pulls tool names from [SmartAgent: Executing X...] markers', () => {
    const c =
      'intro\n\n[SmartAgent: Executing RuntimeListFeeds...]\n\n[SmartAgent: Executing GetDumpSection...]\ndone';
    expect(extractExecutedTools(c)).toEqual([
      'RuntimeListFeeds',
      'GetDumpSection',
    ]);
  });
  it('returns [] when there are no markers', () => {
    expect(extractExecutedTools('no tools here')).toEqual([]);
  });
});

describe('hasWriteTool', () => {
  it('detects Create/Update/Delete/Activate tools', () => {
    expect(hasWriteTool(['ReadDomain', 'CreateDomain'])).toBe(true);
    expect(hasWriteTool(['ActivateObjects'])).toBe(true);
    expect(hasWriteTool(['DeleteTable'])).toBe(true);
    expect(hasWriteTool(['UpdateClass'])).toBe(true);
  });
  it('is false for read-only tool sets', () => {
    expect(hasWriteTool(['ReadDomain', 'GetTableContents'])).toBe(false);
    expect(hasWriteTool([])).toBe(false);
  });
});

describe('claimsCompletedWrite', () => {
  it('matches EN completion assertions', () => {
    expect(
      claimsCompletedWrite('✅ Domain ZDEMO has been successfully created'),
    ).toBe(true);
    expect(
      claimsCompletedWrite('The domain has been created with your specs.'),
    ).toBe(true);
    expect(claimsCompletedWrite('The class was activated successfully.')).toBe(
      true,
    );
  });
  it('matches RU/UK completion assertions', () => {
    expect(claimsCompletedWrite('Объект успешно создан.')).toBe(true);
    expect(claimsCompletedWrite('Объект создан.')).toBe(true);
    expect(claimsCompletedWrite("Об'єкт створено.")).toBe(true);
  });
  it('does NOT match "Created by/on" metadata (read-back)', () => {
    expect(
      claimsCompletedWrite(
        'The domain ZDEMO exists. Created by: DEVELOPER on 2026-07-19. Length: 10.',
      ),
    ).toBe(false);
    expect(claimsCompletedWrite('Создан: DEVELOPER')).toBe(false);
  });
  it('does NOT match instructions or honest refusals', () => {
    expect(
      claimsCompletedWrite('To create a domain, you would use CreateDomain.'),
    ).toBe(false);
    expect(
      claimsCompletedWrite('I cannot create it — no create tool is available.'),
    ).toBe(false);
  });
});

describe('applyWriteGuardrail', () => {
  const halluc =
    '[SmartAgent: Executing ReadDomain...]\n✅ **Domain ZDEMO_TESTDOM has been successfully created and confirmed.**';
  const real =
    '[SmartAgent: Executing CreateDomain...]\n[SmartAgent: Executing ReadDomain...]\nDomain ZDEMO created.';
  const readback =
    '[SmartAgent: Executing ReadDomain...]\nThe domain exists. Created by: DEVELOPER on 2026-07-19.';

  it('warns when a write is claimed but no write tool ran', () => {
    const r = applyWriteGuardrail(halluc);
    expect(r.warned).toBe(true);
    expect(r.content).toContain(halluc);
    expect(r.content.toLowerCase()).toContain('no write');
  });
  it('does NOT warn when a write tool actually ran', () => {
    const r = applyWriteGuardrail(real);
    expect(r.warned).toBe(false);
    expect(r.content).toBe(real);
  });
  it('does NOT warn on a read-back that only mentions "Created by"', () => {
    const r = applyWriteGuardrail(readback);
    expect(r.warned).toBe(false);
    expect(r.content).toBe(readback);
  });
});

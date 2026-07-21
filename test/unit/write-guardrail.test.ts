import {
  applyWriteGuardrail,
  claimedWriteOps,
  claimsCompletedWrite,
  extractExecutedTools,
  hasWriteTool,
  opSatisfiedByTools,
  toolMatchesOp,
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
  it('detects compact-mode Handler* write handlers', () => {
    expect(hasWriteTool(['HandlerCreate'])).toBe(true);
    expect(hasWriteTool(['HandlerUpdate'])).toBe(true);
    expect(hasWriteTool(['HandlerDelete'])).toBe(true);
    expect(hasWriteTool(['HandlerActivate'])).toBe(true);
  });
  it('is false for read-only tool sets', () => {
    expect(hasWriteTool(['ReadDomain', 'GetTableContents'])).toBe(false);
    expect(hasWriteTool(['HandlerGet', 'HandlerRead'])).toBe(false);
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
  it('matches EN active / first-person claims', () => {
    expect(claimsCompletedWrite('I created domain ZDEMO_D_MATNR.')).toBe(true);
    expect(claimsCompletedWrite('I have created the domain.')).toBe(true);
    expect(claimsCompletedWrite("I've created it.")).toBe(true);
    expect(claimsCompletedWrite('I successfully created the table.')).toBe(
      true,
    );
    expect(claimsCompletedWrite('Created domain ZDEMO_D_MATNR.')).toBe(true);
    expect(
      claimsCompletedWrite('✅ Created domain ZDEMO and activated it.'),
    ).toBe(true);
  });
  it('does NOT match "Created by/on/:" metadata (read-back)', () => {
    expect(
      claimsCompletedWrite(
        'The domain ZDEMO exists. Created by: DEVELOPER on 2026-07-19. Length: 10.',
      ),
    ).toBe(false);
    expect(claimsCompletedWrite('Создан: DEVELOPER')).toBe(false);
    // A "Created: <date>" field label (line start + colon) must not match.
    expect(claimsCompletedWrite('Domain ZDEMO\nCreated: 2026-07-19')).toBe(false);
    // Mid-sentence "created" prose is not a completed-write claim.
    expect(
      claimsCompletedWrite('The newly created object was then read back.'),
    ).toBe(false);
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

describe('claimedWriteOps', () => {
  it('picks up both ops from a chained EN claim', () => {
    expect(claimedWriteOps('The domain was created and activated.')).toEqual(
      expect.arrayContaining(['created', 'activated']),
    );
  });
  it('picks up a chained RU/UK claim', () => {
    expect(claimedWriteOps("Об'єкт успішно створено та активовано.")).toEqual(
      expect.arrayContaining(['created', 'activated']),
    );
  });
  it('returns [] when nothing is claimed', () => {
    expect(
      claimedWriteOps('I cannot create it — no create tool is available.'),
    ).toEqual([]);
  });
});

describe('toolMatchesOp', () => {
  it('maps tool name prefixes to op families', () => {
    expect(toolMatchesOp('CreateDomain', 'created')).toBe(true);
    expect(toolMatchesOp('HandlerActivate', 'activated')).toBe(true);
    expect(toolMatchesOp('UpdateClass', 'updated')).toBe(true);
    expect(toolMatchesOp('DeleteTable', 'deleted')).toBe(true);
    expect(toolMatchesOp('ReadDomain', 'created')).toBe(false);
  });
});

describe('opSatisfiedByTools', () => {
  it('is false when no executed tool matches the op', () => {
    expect(
      opSatisfiedByTools('activated', ['CreateDomain', 'ReadDomain']),
    ).toBe(false);
  });
  it('is true when a created tool ran', () => {
    expect(opSatisfiedByTools('created', ['CreateDomain'])).toBe(true);
  });
  it('is true when an activated tool ran', () => {
    expect(opSatisfiedByTools('activated', ['ActivateDomain'])).toBe(true);
  });
  it('is true when a deleted tool ran', () => {
    expect(opSatisfiedByTools('deleted', ['DeleteTable'])).toBe(true);
  });
});

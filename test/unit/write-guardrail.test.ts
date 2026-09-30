import {
  applyWriteGuardrail,
  claimedWriteOps,
  claimsCompletedWrite,
  extractExecutedTools,
  hasWriteTool,
  isWriteTool,
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
    expect(claimsCompletedWrite('Domain ZDEMO\nCreated: 2026-07-19')).toBe(
      false,
    );
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

describe('isWriteTool', () => {
  it('detects Create/Update/Delete/Activate tool names', () => {
    expect(isWriteTool('CreateDomain')).toBe(true);
    expect(isWriteTool('UpdateClass')).toBe(true);
    expect(isWriteTool('DeleteTable')).toBe(true);
    expect(isWriteTool('ActivateObjects')).toBe(true);
  });
  it('is false for read-only tool names', () => {
    expect(isWriteTool('ReadDomain')).toBe(false);
    expect(isWriteTool('GetTableContents')).toBe(false);
  });
});

// Ukrainian long participles are adjectival: "створений" is both "was created"
// and "a created …". Measured on prod — "Або показати вже створений домен", a
// request for the object's NAME with no write anywhere, was read as a completed
// write and carried an UNVERIFIED_WRITE notice under an answer that created
// nothing. A notice nobody can trust is worse than no notice.
describe('attributive participles are not claims', () => {
  it('does not read a mention of an existing object as a write', () => {
    for (const text of [
      'Або показати вже створений домен, з якого потрібно виходити',
      'оновлений домен потрібно активувати',
      'Вкажіть раніше створений об єкт',
    ]) {
      expect(claimsCompletedWrite(text)).toBe(false);
    }
  });

  it('still reads the predicative forms as claims', () => {
    for (const text of [
      'Домен ZDEMO_TEST створений.',
      'Домен успішно створений у пакеті $TMP',
      'Домен ZDEMO_TEST створено.',
      'Обєкт створено та активовано',
      'Домен оновлений.',
    ]) {
      expect(claimsCompletedWrite(text)).toBe(true);
    }
  });

  it('leaves the Russian short forms unconditional — they cannot modify a noun', () => {
    // Attributive Russian is "созданный", which the pattern deliberately omits.
    expect(claimsCompletedWrite('Домен создан.')).toBe(true);
    expect(claimsCompletedWrite('Домен создан в пакете $TMP')).toBe(true);
  });
});

import { computeSignature, decideJiraInsertStatus, dueDateForCount, matchAssignee, signatureLabel } from '../../srv/jira-policy';

describe('jira-policy', () => {
  describe('computeSignature', () => {
    test('joins requested fields with pipe', () => {
      const sig = computeSignature(
        { system: 'E19.100', dumpId: 'D1', runtimeError: 'X', program: 'P', include: 'I' } as any,
        ['system', 'runtimeError', 'program', 'include']
      );
      expect(sig).toBe('E19.100|X|P|I');
    });

    test('blanks become empty segments', () => {
      const sig = computeSignature({ system: 'E19', dumpId: 'D' } as any, ['system', 'runtimeError']);
      expect(sig).toBe('E19|');
    });
  });

  describe('dueDateForCount', () => {
    const cfg = { first: 14, recurring: 7, frequent: 2, low: 2, high: 5 };
    const today = new Date('2026-04-29T00:00:00Z');
    test('count=1 → +14 days', () => expect(dueDateForCount(1, cfg, today)).toBe('2026-05-13'));
    test('count=2 → +7 days', () => expect(dueDateForCount(2, cfg, today)).toBe('2026-05-06'));
    test('count=4 → +7 days', () => expect(dueDateForCount(4, cfg, today)).toBe('2026-05-06'));
    test('count=5 → +2 days', () => expect(dueDateForCount(5, cfg, today)).toBe('2026-05-01'));
    test('count=10 → +2 days', () => expect(dueDateForCount(10, cfg, today)).toBe('2026-05-01'));
  });

  describe('matchAssignee', () => {
    const dump = { system: 'E19.100', runtimeError: 'OBJECTS_OBJREF_NOT_ASSIGNED', program: 'ZTEST', category: 'cat1' };
    test('returns null when no rules match', () => {
      expect(matchAssignee(dump, [])).toBeUndefined();
    });
    test('matches by program prefix', () => {
      const rules = [{ priority: 10, programPattern: 'Z*', assigneeName: 'a@x', active: true } as any];
      expect(matchAssignee(dump, rules)).toBe('a@x');
    });
    test('lower priority wins', () => {
      const rules = [
        { priority: 10, programPattern: 'Z*', assigneeName: 'a@x', active: true } as any,
        { priority: 5,  programPattern: 'Z*', assigneeName: 'b@x', active: true } as any
      ];
      expect(matchAssignee(dump, rules)).toBe('b@x');
    });
    test('inactive rules ignored', () => {
      const rules = [{ priority: 1, programPattern: 'Z*', assigneeName: 'a@x', active: false } as any];
      expect(matchAssignee(dump, rules)).toBeUndefined();
    });
    test('all non-empty patterns must match', () => {
      const rules = [{
        priority: 10, system: 'OTHER', programPattern: 'Z*', assigneeName: 'a@x', active: true
      } as any];
      expect(matchAssignee(dump, rules)).toBeUndefined();
    });
  });

  describe('signatureLabel', () => {
    test('format: dump-sig-<16 hex chars>', () => {
      expect(signatureLabel('any')).toMatch(/^dump-sig-[0-9a-f]{16}$/);
    });
    test('deterministic for same input', () => {
      expect(signatureLabel('E19.100|RE|ZP|ZI')).toBe(signatureLabel('E19.100|RE|ZP|ZI'));
    });
    test('different signatures yield different labels', () => {
      expect(signatureLabel('a')).not.toBe(signatureLabel('b'));
    });
  });

  describe('decideJiraInsertStatus', () => {
    const openA  = { jiraIssueKey: 'X-1', statusCategoryKey: 'open' as const };
    const doneA  = { jiraIssueKey: 'X-1', statusCategoryKey: 'done' as const };

    test('canonical=null → pending+null', () => {
      expect(decideJiraInsertStatus({ canonical: null, slotRowsForCanonicalKey: [] }))
        .toEqual({ jiraStatus: 'pending', jiraIssueKey: null });
    });

    describe('open branch (canonical statusCategoryKey=open)', () => {
      test('empty slot rows → pending+key (claim)', () => {
        expect(decideJiraInsertStatus({ canonical: openA, slotRowsForCanonicalKey: [] }))
          .toEqual({ jiraStatus: 'pending', jiraIssueKey: 'X-1' });
      });
      test('only created row in slot (canonical itself does not occupy slot in this rule) → pending+key', () => {
        // canonical's own row has jiraStatus='created' which is NOT in the open-branch slot set.
        expect(decideJiraInsertStatus({ canonical: openA, slotRowsForCanonicalKey: [{ jiraStatus: 'created' }] }))
          .toEqual({ jiraStatus: 'pending', jiraIssueKey: 'X-1' });
      });
      test.each([
        ['pending'], ['failed'], ['commented'], ['unheard']
      ])('slot has %s → unheard+key', (s) => {
        expect(decideJiraInsertStatus({ canonical: openA, slotRowsForCanonicalKey: [{ jiraStatus: s }] }))
          .toEqual({ jiraStatus: 'unheard', jiraIssueKey: 'X-1' });
      });
      test('mixed slot states → unheard+key', () => {
        expect(decideJiraInsertStatus({
          canonical: openA,
          slotRowsForCanonicalKey: [{ jiraStatus: 'created' }, { jiraStatus: 'pending' }, { jiraStatus: 'commented' }]
        })).toEqual({ jiraStatus: 'unheard', jiraIssueKey: 'X-1' });
      });
    });

    describe('closed branch (canonical statusCategoryKey=done)', () => {
      test('empty slot rows → pending+key (claim next-cycle creator slot)', () => {
        expect(decideJiraInsertStatus({ canonical: doneA, slotRowsForCanonicalKey: [] }))
          .toEqual({ jiraStatus: 'pending', jiraIssueKey: 'X-1' });
      });
      test.each([
        ['pending'], ['failed']
      ])('slot has %s → unheard+key', (s) => {
        expect(decideJiraInsertStatus({ canonical: doneA, slotRowsForCanonicalKey: [{ jiraStatus: s }] }))
          .toEqual({ jiraStatus: 'unheard', jiraIssueKey: 'X-1' });
      });
      test.each([
        ['commented'], ['unheard']
      ])('closed branch ignores old %s rows from previous cycle → pending+key', (s) => {
        // commented/unheard from the OLD open cycle do not occupy the closed-branch slot.
        expect(decideJiraInsertStatus({ canonical: doneA, slotRowsForCanonicalKey: [{ jiraStatus: s }] }))
          .toEqual({ jiraStatus: 'pending', jiraIssueKey: 'X-1' });
      });
      test('only created (canonical itself) → pending+key', () => {
        expect(decideJiraInsertStatus({ canonical: doneA, slotRowsForCanonicalKey: [{ jiraStatus: 'created' }] }))
          .toEqual({ jiraStatus: 'pending', jiraIssueKey: 'X-1' });
      });
      test('mixed: commented + pending → unheard (pending wins)', () => {
        expect(decideJiraInsertStatus({
          canonical: doneA,
          slotRowsForCanonicalKey: [{ jiraStatus: 'commented' }, { jiraStatus: 'pending' }]
        })).toEqual({ jiraStatus: 'unheard', jiraIssueKey: 'X-1' });
      });
    });
  });
});

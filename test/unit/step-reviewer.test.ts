import { evaluateGated } from '../../srv/lib/step-reviewer';

describe('evaluateGated deterministic notices', () => {
  afterEach(() => {
    delete process.env.LLM_AGENT_STEP_REVIEW_ENABLED;
  });
  it.each(['Hello', 'List ZOBJECT objects', 'I created ZOBJECT.'])(
    'never calls a critic for %s',
    async (content) => {
      const llm = { chat: jest.fn(), async *streamChat() {} };
      const legacyInput = {
        content,
        records: [],
        writeToolOffered: true,
        request: 'ZOBJECT',
        topToolScore: 1,
        completionTokens: 100000,
        model: 'critic',
        llm,
      };
      await evaluateGated(legacyInput);
      expect(llm.chat).not.toHaveBeenCalled();
    },
  );
  it('retains notices for write claims without a successful write', async () => {
    const verdict = await evaluateGated({
      content: 'I created ZOBJECT.',
      records: [],
      writeToolOffered: true,
    });
    expect(verdict.ok).toBe(false);
  });
  it('retains the deterministic notice switch', async () => {
    process.env.LLM_AGENT_STEP_REVIEW_ENABLED = 'false';
    expect(
      await evaluateGated({
        content: 'I created ZOBJECT.',
        records: [],
        writeToolOffered: true,
      }),
    ).toEqual({ ok: true });
  });
});

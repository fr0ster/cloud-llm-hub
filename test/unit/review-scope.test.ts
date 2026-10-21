import {
  createCallRegister,
  runWithAdmission,
} from '../../srv/lib/admission-scope';
import { getReviewSignals, recordToolScore } from '../../srv/lib/review-scope';
import { trackedLlm } from '../../srv/lib/tracked-llm';
import { runWithSessionId } from '../../srv/request-session';

test('score keeps maximum, ignores absence of request and isolates requests', async () => {
  expect(() => recordToolScore(0.9)).not.toThrow();
  expect(getReviewSignals()).toBeUndefined();
  await runWithSessionId('one', async () => {
    recordToolScore(0.5);
    recordToolScore(0.4);
    recordToolScore(0.6);
    expect(getReviewSignals()?.topToolScore).toBe(0.6);
    await runWithSessionId('two', async () =>
      expect(getReviewSignals()?.topToolScore).toBeUndefined(),
    );
    expect(getReviewSignals()?.topToolScore).toBe(0.6);
  });
});

test('sums main chat and stream usage, excludes helper calls of same model', async () => {
  const inner = {
    model: 'model',
    chat: async () => ({
      ok: true,
      value: { content: '', usage: { completionTokens: 12 } },
    }),
    streamChat: async function* () {
      yield {
        ok: true,
        value: { content: '', usage: { completionTokens: 8 } },
      };
    },
  };
  await runWithSessionId('usage', async () => {
    const main = trackedLlm(inner as never, true);
    await main.chat([]);
    await main.chat([]);
    for await (const _chunk of main.streamChat([])) {
    }
    await trackedLlm(inner as never).chat([]);
    expect(getReviewSignals()?.completionTokens).toBe(32);
    expect(getReviewSignals()?.model).toBe('model');
  });
});

test('adding executor usage capture preserves one admission registration per stream', async () => {
  const register = createCallRegister();
  const source = {
    chat: async () => ({ ok: true, value: { content: '' } }),
    streamChat: async function* () {
      yield { ok: true, value: { content: '' } };
    },
  };
  const llm = trackedLlm(trackedLlm(source as never), true);
  await runWithAdmission(register, async () => {
    for await (const _chunk of llm.streamChat([])) {
      expect(register.outstanding).toBe(1);
    }
  });
});

import { parseSapRelevanceScore } from '../../srv/agent-config';
import { concernsSap, TokenStats } from '../../srv/lib/review-signals';

test('window warms up at 20 and retains 50', () => {
  const stats = new TokenStats();
  for (let i = 0; i < 19; i++) stats.record(100);
  expect(stats.isAnomalous(1000)).toBe(false);
  stats.record(100);
  expect(stats.isAnomalous(1000)).toBe(true);
  expect(stats.isAnomalous(0)).toBe(true);
  expect(stats.isAnomalous(100)).toBe(false);
  for (let i = 0; i < 50; i++) stats.record(1000);
  expect(stats.isAnomalous(1000)).toBe(false);
});
test.each(['ZDOMAIN', 'Y_TABLE', '$TMP', 'DEVK912345'])(
  'SAP identifier %s',
  (request) => expect(concernsSap(request)).toBe(true),
);
test('score and config boundaries', () => {
  expect(concernsSap('hello', 0.48)).toBe(true);
  expect(concernsSap('hello', 0.467)).toBe(false);
  expect(parseSapRelevanceScore({})).toBe(0.48);
  for (const value of ['0', '1'])
    expect(
      parseSapRelevanceScore({ LLM_AGENT_SAP_RELEVANCE_SCORE: value }),
    ).toBe(Number(value));
  for (const value of ['-1', '1.1', 'NaN', 'oops'])
    expect(() =>
      parseSapRelevanceScore({ LLM_AGENT_SAP_RELEVANCE_SCORE: value }),
    ).toThrow();
});

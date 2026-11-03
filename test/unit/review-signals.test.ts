import { parseSapRelevanceScore } from '../../srv/agent-config';

test.each([undefined, '0', '1', '-1', '1.1', 'NaN', 'oops'])(
  'deprecated critic relevance setting is ignored: %s',
  (value) => {
    expect(
      parseSapRelevanceScore({ LLM_AGENT_SAP_RELEVANCE_SCORE: value }),
    ).toBe(0.48);
  },
);

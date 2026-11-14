import {
  type IQueryEmbedding,
  type IRag,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { ExpositionFilteringRag } from '../../srv/agent-manager';
import {
  type ToolQueryAnalysis,
  ToolQueryAnalyzer,
} from '../../srv/lib/tool-query-analyzer';
import {
  requestToolGateDecision,
  runWithSessionId,
} from '../../srv/request-session';

function searchWith(analyzeText: (text: string) => Promise<ToolQueryAnalysis>) {
  const analyzer = new ToolQueryAnalyzer({
    chat: jest.fn(),
    streamChat: jest.fn(),
  });
  const analyze = jest
    .spyOn(analyzer, 'analyze')
    .mockImplementation(analyzeText);
  const query = jest.fn(async (_embedding: IQueryEmbedding) => ({
    ok: true as const,
    value: [
      {
        text: 'Read data',
        score: 0.9,
        metadata: {
          id: 'tool:GetSqlQuery',
          exposition: 'readonly',
          readOnlyHint: true,
        },
      },
      {
        text: 'Update a program',
        score: 0.8,
        metadata: {
          id: 'tool:UpdateProgram',
          exposition: 'high',
          readOnlyHint: false,
        },
      },
    ],
  }));
  const store: IRag = {
    query,
    healthCheck: async () => ({ ok: true, value: undefined }),
    getById: async () => ({ ok: true, value: null }),
  };
  const rag = new ExpositionFilteringRag(
    store,
    undefined,
    undefined,
    0,
    analyzer,
    undefined,
    'classifier',
    'smart',
    2,
    1,
    'step-kind',
  );
  const search = async (text: string) => {
    const result = await rag.query(new TextOnlyEmbedding(text), 5, {
      ragFilter: { exposition: ['readonly', 'high'] },
    });
    if (!result.ok) throw result.error;
    return result.value.map((row) => row.metadata.id);
  };
  return { analyze, query, search };
}

it.each([
  ['read request', 'read request'],
  ['read request', 'write request', 'write request', 'read request'],
])(
  'keeps each search kind and translation in one scope: %j',
  async (...texts) => {
    const { analyze, query, search } = searchWith(async (text) => ({
      text: `Translated ${text}`,
      needsAbapSystem: true,
      writes: text === 'write request',
    }));
    await runWithSessionId('steps', async () => {
      for (const text of texts) {
        const ids = await search(text);
        if (text === 'read request') {
          expect(ids).toEqual(['tool:GetSqlQuery']);
        } else {
          expect(ids).toEqual(
            expect.arrayContaining([
              'tool:UpdateProgram',
              'tool:CreateProgram',
              'tool:DeleteProgram',
            ]),
          );
          expect(ids).not.toContain('tool:GetSqlQuery');
        }
      }
    });
    expect(analyze.mock.calls.map(([text]) => text)).toEqual([
      ...new Set(texts),
    ]);
    expect(query.mock.calls.map(([embedding]) => embedding.text)).toEqual(
      texts.map((text) => `Translated ${text}`),
    );
  },
);

it.each([true, false])(
  'keeps the first pending gate decision %s while analysing distinct texts',
  async (needsAbapSystem) => {
    let resolveFirst!: (analysis: ToolQueryAnalysis) => void;
    let resolveLater!: (analysis: ToolQueryAnalysis) => void;
    const firstAnalysis = new Promise<ToolQueryAnalysis>((resolve) => {
      resolveFirst = resolve;
    });
    const laterAnalysis = new Promise<ToolQueryAnalysis>((resolve) => {
      resolveLater = resolve;
    });
    const analyzeFirst = jest.fn(() => firstAnalysis);
    const analyzeLater = jest.fn(() => laterAnalysis);
    const firstValue = {
      text: 'Translated read',
      needsAbapSystem,
      writes: false,
    };
    const laterValue = {
      text: 'Translated write',
      needsAbapSystem: !needsAbapSystem,
      writes: true,
    };
    await runWithSessionId('parallel', async () => {
      const first = requestToolGateDecision('read', analyzeFirst);
      const duplicate = requestToolGateDecision('read', analyzeFirst);
      const later = requestToolGateDecision('write', analyzeLater);
      expect(analyzeFirst).toHaveBeenCalledTimes(1);
      expect(analyzeLater).toHaveBeenCalledTimes(1);
      resolveLater(laterValue);
      resolveFirst(firstValue);
      expect(await first).toEqual(firstValue);
      expect(await duplicate).toEqual(firstValue);
      expect(await later).toEqual({ ...laterValue, needsAbapSystem });
      expect(await requestToolGateDecision('write', analyzeLater)).toEqual({
        ...laterValue,
        needsAbapSystem,
      });
      expect(analyzeLater).toHaveBeenCalledTimes(1);
    });
    expect(
      await runWithSessionId('parallel', () =>
        requestToolGateDecision('write', analyzeLater),
      ),
    ).toEqual(laterValue);
    expect(analyzeLater).toHaveBeenCalledTimes(2);
  },
);

it.each([true, false])(
  'keeps request-wide gate %s when later searches disagree',
  async (needsAbapSystem) => {
    const { analyze, query, search } = searchWith(async (text) => ({
      text: `Translated ${text}`,
      needsAbapSystem: text === 'first' ? needsAbapSystem : !needsAbapSystem,
      writes: false,
    }));
    await runWithSessionId('gate', async () => {
      for (const text of ['first', 'later', 'later']) {
        expect(await search(text)).toEqual(
          needsAbapSystem ? ['tool:GetSqlQuery'] : [],
        );
      }
    });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(([embedding]) => embedding.text)).toEqual([
      'Translated first',
      'Translated later',
      'Translated later',
    ]);
  },
);

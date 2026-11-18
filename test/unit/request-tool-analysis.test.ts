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
import { runWithSessionId } from '../../srv/request-session';

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
    expect(analyze.mock.calls.map(([text]) => text)).toEqual(texts);
    expect(query.mock.calls.map(([embedding]) => embedding.text)).toEqual(
      texts.map((text) => `Translated ${text}`),
    );
  },
);

it.each([true, false])(
  'uses each search decision when the first gate is %s',
  async (needsAbapSystem) => {
    const { analyze, query, search } = searchWith(async (text) => ({
      text: `Translated ${text}`,
      needsAbapSystem: text === 'first' ? needsAbapSystem : !needsAbapSystem,
      writes: false,
    }));
    await runWithSessionId('gate', async () => {
      for (const [text, needsSystem] of [
        ['first', needsAbapSystem],
        ['later', !needsAbapSystem],
        ['later', !needsAbapSystem],
      ] as const) {
        expect(await search(text)).toEqual(
          needsSystem ? ['tool:GetSqlQuery'] : [],
        );
      }
    });
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.map(([embedding]) => embedding.text)).toEqual([
      'Translated first',
      'Translated later',
      'Translated later',
    ]);
  },
);

it('offers SAP readers after a documentation-only step in the same request', async () => {
  const documents = 'Find the documentation for ABAP dictionary tables';
  const sapInspection = 'Inspect the live SAP system and read table MARA';
  const { search } = searchWith(async (text) => ({
    text,
    needsAbapSystem: text === sapInspection,
    writes: false,
  }));
  await runWithSessionId('adaptive-run', async () => {
    expect(await search(documents)).toEqual([]);
    expect(await search(sapInspection)).toEqual(['tool:GetSqlQuery']);
  });
});

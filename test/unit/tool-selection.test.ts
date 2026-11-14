import {
  InMemoryRag,
  type IRag,
  symmetricEmbedder,
  TextOnlyEmbedding,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import {
  ExpositionFilteringRag,
  getSharedCorpusDocs,
} from '../../srv/agent-manager';
import { collectionFor, type SharedCorpusDoc } from '../../srv/lib/tool-corpus';
import { toolDefinitionAnnotations } from '../../srv/lib/tool-definition-effects';
import { ToolQueryAnalyzer } from '../../srv/lib/tool-query-analyzer';
import { selectStepTools } from '../../srv/lib/tool-selection';

it('defaults to step-kind with five reader seeds and two writer seeds', () => {
  const readers = Array.from({ length: 6 }, (_, index) => ({
    text: `reader-${index}`,
    score: 6 - index,
    metadata: { id: `tool:reader-${index}`, readOnlyHint: true },
  }));
  const writers = Array.from({ length: 3 }, (_, index) => ({
    text: `writer-${index}`,
    score: 3 - index,
    metadata: { id: `tool:writer-${index}`, readOnlyHint: false },
  }));
  const rows = readers.concat(writers);
  expect(selectStepTools(rows, [], false, true, () => true)).toEqual(
    readers.slice(0, 5),
  );
  expect(selectStepTools(rows, [], true, true, () => true)).toEqual(
    writers.slice(0, 2),
  );
  expect(selectStepTools(rows, [], undefined, true, () => true)).toEqual(
    readers.slice(0, 5).concat(writers.slice(0, 2)),
  );
});

it('expands every writer seed within its own budget without comparing reader scores', () => {
  const docs = getSharedCorpusDocs();
  const rows = [
    { name: 'GetSqlQuery', score: 1000000, readOnlyHint: true },
    { name: 'UpdateProgram', score: -10, readOnlyHint: false },
    { name: 'UpdateTableType', score: -20, readOnlyHint: false },
    { name: 'UpdateDomain', score: -30, readOnlyHint: false },
  ].map((row) => ({
    text: row.name,
    score: row.score,
    metadata: { id: `tool:${row.name}`, readOnlyHint: row.readOnlyHint },
  }));
  const result = selectStepTools(
    rows,
    docs,
    true,
    true,
    () => true,
    1,
    2,
    'step-kind',
  );
  const ids = result.map((row) => row.metadata.id);
  expect(ids).toEqual(
    expect.arrayContaining([
      'tool:UpdateProgram',
      'tool:GetProgramVersionSource',
      'tool:ActivateProgram',
      'tool:UpdateTableType',
      'tool:GetTableTypeVersions',
      'tool:ActivateTableType',
    ]),
  );
  expect(ids).not.toContain('tool:GetSqlQuery');
  expect(ids).not.toContain('tool:UpdateDomain');
});

it('normalizes only explicit upstream declarations and preserves native annotations', () => {
  expect(
    toolDefinitionAnnotations({ description: 'Read a program' }),
  ).toBeUndefined();
  expect(
    toolDefinitionAnnotations({ description: '[read-only] Read a program' }),
  ).toEqual({ readOnlyHint: true });
  expect(
    toolDefinitionAnnotations({
      description: '[read-only] Read a program',
      annotations: { readOnlyHint: false },
    }),
  ).toEqual({ readOnlyHint: false });
});

it('splits version tools by effect and treats absent annotations as writers', () => {
  const docs = getSharedCorpusDocs();
  for (const name of [
    'GetProgramVersionSource',
    'GetLocalTypes',
    'ListServiceBindingTypes',
  ]) {
    expect(
      collectionFor(docs.find((doc) => doc.name === name)?.readOnlyHint),
    ).toBe('reader');
  }
  expect(collectionFor(toolDefinitionAnnotations({})?.readOnlyHint)).toBe(
    'writer',
  );
});

it.each(['keyword', 'vector'])(
  'shares RO/RW/UNKNOWN and rights behaviour over %s stores',
  async (kind) => {
    const embedder = symmetricEmbedder({
      embed: async () => ({ vector: [1, 0] }),
    });
    const reader: IRag =
      kind === 'keyword' ? new InMemoryRag() : new VectorRag(embedder);
    const writer: IRag =
      kind === 'keyword' ? new InMemoryRag() : new VectorRag(embedder);
    const docs: SharedCorpusDoc[] = [
      {
        id: 'tool:GetSqlQuery',
        name: 'GetSqlQuery',
        text: 'program',
        cached: true,
        readOnlyHint: true,
        exposition: 'readonly',
      },
      {
        id: 'tool:UpdateProgram',
        name: 'UpdateProgram',
        text: 'program',
        cached: true,
        readOnlyHint: false,
        exposition: 'high',
      },
      {
        id: 'tool:ActivateProgram',
        name: 'ActivateProgram',
        text: 'activate',
        cached: true,
      },
    ];
    for (const doc of docs.slice(0, 2)) {
      const result = await (doc.readOnlyHint ? reader : writer)
        .writer?.()
        ?.upsertRaw(doc.id, doc.text, {
          readOnlyHint: doc.readOnlyHint,
          exposition: doc.exposition,
        });
      expect(result?.ok).toBe(true);
    }
    const parts = await Promise.all([
      reader.query(new TextOnlyEmbedding('program'), 5),
      writer.query(new TextOnlyEmbedding('program'), 5),
    ]);
    const rows = parts.flatMap((part) => {
      if (!part.ok) throw new Error('query failed');
      return part.value;
    });
    const selected = (
      writes: boolean | undefined,
      rights = true,
      strategy: 'step-kind' | 'per-collection' = 'step-kind',
    ) =>
      selectStepTools(
        rows,
        docs,
        writes,
        rights,
        () => true,
        2,
        1,
        strategy,
      ).map((row) => row.metadata.id);
    expect(selected(false)).toEqual(['tool:GetSqlQuery']);
    expect(selected(true)).toEqual(
      expect.arrayContaining(docs.slice(1).map((doc) => doc.id)),
    );
    expect(selected(true)).not.toContain('tool:GetSqlQuery');
    expect(selected(undefined)).toEqual(
      expect.arrayContaining(docs.map((doc) => doc.id)),
    );
    expect(selected(true, false)).toEqual(['tool:GetSqlQuery']);
    expect(selected(undefined, false)).toEqual(['tool:GetSqlQuery']);
    expect(selected(false, false, 'per-collection')).toEqual([
      'tool:GetSqlQuery',
    ]);
    expect(selected(false, true, 'per-collection')).toEqual(
      selected(true, true, 'per-collection'),
    );
    expect(
      selectStepTools(
        rows,
        docs,
        true,
        true,
        (row) => row.metadata.id !== 'tool:ActivateProgram',
        2,
        1,
        'step-kind',
      ).map((row) => row.metadata.id),
    ).not.toContain('tool:ActivateProgram');

    // Exercise the production wrapper as well as the shared selection function.
    for (const strategy of ['per-collection', 'step-kind'] as const) {
      for (const writes of [false, true, undefined]) {
        const chat = jest.fn().mockResolvedValue({
          ok: true,
          value: {
            content: JSON.stringify({
              translation: 'program',
              needsAbapSystem: true,
              writes,
            }),
          },
        });
        const analyzer = new ToolQueryAnalyzer({ chat, streamChat: jest.fn() });
        const rag = new ExpositionFilteringRag(
          reader,
          writer,
          undefined,
          0,
          analyzer,
          undefined,
          'off',
          'hard',
          2,
          1,
          strategy,
        );
        for (const rights of [true, false]) {
          const result = await rag.query(new TextOnlyEmbedding('program'), 99, {
            ragFilter: {
              exposition: rights ? ['readonly', 'high'] : ['readonly'],
            },
          });
          if (!result.ok) throw new Error('query failed');
          const ids = result.value.map((row) => row.metadata.id);
          const includesWriter =
            rights && (strategy === 'per-collection' || writes !== false);
          expect(ids.includes('tool:UpdateProgram')).toBe(includesWriter);
          expect(ids.includes('tool:ActivateProgram')).toBe(includesWriter);
          expect(ids.includes('tool:GetProgramVersionSource')).toBe(
            includesWriter,
          );
          expect(ids.includes('tool:GetSqlQuery')).toBe(
            !rights || strategy === 'per-collection' || writes !== true,
          );
          expect(new Set(ids).size).toBe(ids.length);
        }
        expect(chat).toHaveBeenCalledTimes(writes === undefined ? 2 : 1);
      }
    }
  },
);

it.each([undefined, 'true', null, 1])(
  'invalid or missing writes %s is UNKNOWN',
  async (writes) => {
    const chat = jest.fn().mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          translation: 'Read program',
          needsAbapSystem: true,
          writes,
        }),
      },
    });
    const analyzer = new ToolQueryAnalyzer({ chat, streamChat: jest.fn() });
    expect((await analyzer.analyze('Read program')).writes).toBeUndefined();
  },
);
it('uses UNKNOWN when the analyzer is unavailable', async () => {
  const analyzer = new ToolQueryAnalyzer(async () => {
    throw new Error('offline');
  });
  expect((await analyzer.analyze('Read program')).writes).toBeUndefined();
});

it.each([true, false])('parses boolean writes %s', async (writes) => {
  const chat = jest.fn().mockResolvedValue({
    ok: true,
    value: {
      content: JSON.stringify({
        translation: 'Program action',
        needsAbapSystem: true,
        writes,
      }),
    },
  });
  expect(
    (
      await new ToolQueryAnalyzer({ chat, streamChat: jest.fn() }).analyze(
        'Program action',
      )
    ).writes,
  ).toBe(writes);
});

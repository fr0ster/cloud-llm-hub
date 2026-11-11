import { InMemoryRag, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import {
  ExpositionFilteringRag,
  getSharedCorpusDocs,
} from '../../srv/agent-manager';
import { resolveExposition } from '../../srv/lib/exposition';

async function search(
  seed: string,
  role: string,
  readerCount = 2,
  writerCount = 5,
) {
  const reader = new InMemoryRag();
  const writer = new InMemoryRag();
  const docs = getSharedCorpusDocs();
  for (const name of [seed, 'GetSqlQuery', 'SearchObject', 'GetTable']) {
    const doc = docs.find((item) => item.name === name);
    if (!doc) throw new Error(`Missing ${name}`);
    const store = doc.exposition === 'high' ? writer : reader;
    await store.writer().upsertRaw(doc.id, seed, {
      id: doc.id,
      name,
      exposition: doc.exposition,
    });
  }
  const rag = new ExpositionFilteringRag(
    reader,
    writer,
    undefined,
    0,
    undefined,
    undefined,
    'off',
    'hard',
    readerCount,
    writerCount,
  );
  const result = await rag.query(new TextOnlyEmbedding(seed), 100, {
    ragFilter: { exposition: resolveExposition([role]) },
  });
  if (!result.ok) throw new Error('Query failed');
  return result.value;
}

it('expands writer seeds with allowed reads, checks and activation, without duplicates', async () => {
  const rows = await search('UpdateProgram', 'MCP_Developer');
  const names = rows.map((row) => row.metadata.id);
  expect(names).toEqual(
    expect.arrayContaining([
      'tool:UpdateProgram',
      'tool:CheckProgram',
      'tool:ActivateProgram',
      'tool:GetProgram',
    ]),
  );
  expect(new Set(names).size).toBe(names.length);
  expect(names[0]).not.toBe('tool:ActivateProgram');
});

it('keeps reader seeds unexpanded and applies the reader budget', async () => {
  const rows = await search('GetProgram', 'MCP_Reader', 1, 1);
  expect(rows).toHaveLength(1);
  expect(
    rows.every(
      (row) =>
        row.metadata.exposition === 'readonly' ||
        row.metadata.exposition === 'search',
    ),
  ).toBe(true);
});

it('generic seeds add no cluster members', async () => {
  const rows = await search('GetSqlQuery', 'MCP_Developer', 1, 1);
  expect(rows).toHaveLength(1);
  expect(rows[0].metadata.id).toBe('tool:GetSqlQuery');
});

it('expands reader seeds for a write role', async () => {
  const rows = await search('GetProgram', 'MCP_Developer', 1, 1);
  expect(rows.map((row) => row.metadata.id)).toContain('tool:ActivateProgram');
});

it('caps both collections independently even when the caller requests a larger K', async () => {
  const reader = new InMemoryRag();
  const writer = new InMemoryRag();
  for (const [store, names, exposition] of [
    [reader, ['GetSqlQuery', 'SearchObject', 'GetObjectsList'], 'readonly'],
    [writer, ['WriterGenericA', 'WriterGenericB', 'WriterGenericC'], 'high'],
  ] as const) {
    for (const name of names) {
      await store.writer().upsertRaw(`tool:${name}`, 'query', {
        id: `tool:${name}`,
        name,
        exposition,
      });
    }
  }
  const readerQuery = jest.spyOn(reader, 'query');
  const writerQuery = jest.spyOn(writer, 'query');
  const rag = new ExpositionFilteringRag(
    reader,
    writer,
    undefined,
    0,
    undefined,
    undefined,
    'off',
    'hard',
    1,
    2,
  );
  const result = await rag.query(new TextOnlyEmbedding('query'), 100, {
    ragFilter: { exposition: resolveExposition(['MCP_Developer']) },
  });
  if (!result.ok) throw new Error('query failed');
  expect(
    result.value.filter((row) => row.metadata.exposition === 'readonly'),
  ).toHaveLength(1);
  expect(
    result.value.filter((row) => row.metadata.exposition === 'high'),
  ).toHaveLength(2);
  expect(readerQuery.mock.calls[0][1]).toBe(3);
  expect(writerQuery.mock.calls[0][1]).toBe(6);
});

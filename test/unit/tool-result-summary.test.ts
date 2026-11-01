import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { summarizeToolResult } from '../../srv/lib/tool-result-summary';

function record(
  content: ToolCallRecord['result']['content'],
  isError = false,
): ToolCallRecord {
  return {
    call: {
      id: 'private',
      name: 'rag_search',
      arguments: { collection: 'notes', record: 'r', id: 'i', text: 'secret' },
    },
    result: { content, isError },
  };
}

test('strips search payloads and arguments, retaining only identifiers', () => {
  const input = {
    hits: [
      {
        collection: 'notes',
        id: 'r',
        text: 'secret',
        title: 'secret',
        score: 1,
        attributes: { secret: true },
      },
    ],
    unavailable: [{ collection: 'offline', error: 'private' }],
  };
  const inputRecord = {
    ...record('ignored'),
    result: { ...record('ignored').result, structuredContent: input },
  };
  const output = summarizeToolResult(inputRecord);
  expect(output).toEqual({
    call: {
      name: 'rag_search',
      arguments: { collection: 'notes', record: 'r', id: 'i' },
    },
    result: {
      isError: false,
      structuredContent: {
        hits: [{ collection: 'notes', id: 'r' }],
        unavailable: [{ collection: 'offline' }],
      },
    },
  });
});

test('keeps record and collection identifiers, paging and write response IDs', () => {
  expect(
    summarizeToolResult(
      record({
        collection: 'notes',
        record: 'r',
        id: 'i',
        total: 10,
        offset: 2,
        records: [{ id: 'r', text: 'secret', attributes: {} }],
        collections: [{ id: 'notes', title: 'secret' }],
        result: 'not an error',
        text: 'secret',
      }),
    ).result.structuredContent,
  ).toEqual({
    collection: 'notes',
    record: 'r',
    id: 'i',
    total: 10,
    offset: 2,
    records: [{ id: 'r' }],
    collections: [{ id: 'notes' }],
  });
});

test('truncates error message and result to 200 characters', () => {
  expect(
    summarizeToolResult(
      record(
        {
          error: { code: 'FAILED', message: 'm'.repeat(250), text: 'secret' },
          result: 'r'.repeat(250),
        },
        true,
      ),
    ).result.structuredContent,
  ).toEqual({
    error: { code: 'FAILED', message: 'm'.repeat(200) },
    result: 'r'.repeat(200),
  });
});

test('parses JSON content when structuredContent is absent', () => {
  expect(
    summarizeToolResult(
      record(
        JSON.stringify({
          hits: [{ collection: 'notes', id: 'r', text: 'secret' }],
        }),
      ),
    ).result.structuredContent,
  ).toEqual({ hits: [{ collection: 'notes', id: 'r' }] });
});

test('keeps bounded plain content only for errors', () => {
  expect(
    summarizeToolResult(record('e'.repeat(250), true)).result.structuredContent,
  ).toEqual({ result: 'e'.repeat(200) });
  expect(
    summarizeToolResult(record('private text')).result.structuredContent,
  ).toEqual({});
});

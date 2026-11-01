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

test('errors keep only a code, never message or result text', () => {
  expect(
    summarizeToolResult(
      record(
        {
          error: { code: 'FAILED', message: 'document text', text: 'secret' },
          result: 'more text',
        },
        true,
      ),
    ).result.structuredContent,
  ).toEqual({ error: { code: 'FAILED' } });
  expect(
    summarizeToolResult(
      record({ result: 'SESSION_REQUIRED: call session_open first' }, true),
    ).result.structuredContent,
  ).toEqual({ error: { code: 'SESSION_REQUIRED' } });
  expect(
    summarizeToolResult(record({ result: 'backend said: row 42 text' }, true))
      .result.structuredContent,
  ).toEqual({ error: { code: 'ERROR' } });
  expect(
    summarizeToolResult(
      record({ error: { code: 'FAILED: confidential document text' } }, true),
    ).result.structuredContent,
  ).toEqual({ error: { code: 'ERROR' } });
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

test('plain content becomes an error code or nothing', () => {
  expect(
    summarizeToolResult(record('NOT_FOUND: collection x', true)).result
      .structuredContent,
  ).toEqual({ error: { code: 'NOT_FOUND' } });
  expect(
    summarizeToolResult(record('free text', true)).result.structuredContent,
  ).toEqual({ error: { code: 'ERROR' } });
  expect(
    summarizeToolResult(record('private text')).result.structuredContent,
  ).toEqual({});
});

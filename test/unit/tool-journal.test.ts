import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { runWithDialogueRagTools } from '../../srv/lib/dialogue-rag-scope';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  type JournalEntry,
  journalOutcome,
  journalTargets,
  writeActions,
} from '../../srv/lib/tool-journal';

const taskXml =
  '<?xml version="1.0"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="DEVK900007"/>';

function sapWrite(
  name: string,
  content: JournalEntry['result']['content'],
  isError = false,
): JournalEntry {
  return {
    call: { id: 'write', name, arguments: { transport_number: 'DEVK900001' } },
    result: { content, isError },
    answered: true,
    write: true,
    system: 'sap',
  };
}

test.each([
  ['terse', { success: true, task_number: 'DEVK900007' }],
  ['full', { 'tm:root': { '@': { 'tm:number': 'DEVK900007' } } }],
  ['raw', taskXml],
  [
    'raw with cleanup',
    { result: taskXml, cleanup: { message: 'Task typing refused' } },
  ],
] satisfies [string, JournalEntry['result']['content']][])(
  'identifies a created task from the %s response',
  (_detail, content) => {
    const entry = sapWrite('CreateTransportTask', content);
    expect(journalTargets(entry)).toEqual([
      { type: 'transport', name: 'DEVK900007' },
    ]);
    expect(journalOutcome(entry)).toBe('succeeded');
  },
);

test.each([
  ['AddTransportObject', { accepted: true, added: 'unknown' }],
  [
    'MoveTransportObjects',
    { accepted: true, objects: [{ object: 'R3TR DOMA ZSTATUS' }] },
  ],
  ['UpdateDomain', { data: 'unrecognized projection' }],
  ['CreateTransportTask', { success: true, task_number: null }],
  ['CreateTransportTask', '<tm:root tm:number="DEVK900007">'],
] satisfies [string, JournalEntry['result']['content']][])(
  '%s records an unconfirmed write when its response does not confirm the change',
  (name, content) => {
    expect(journalOutcome(sapWrite(name, content))).toBe('unconfirmed');
  },
);

test('keeps a completed operation succeeded and records its secondary cleanup error', () => {
  const cleanup = {
    error: 'client_threw',
    message: 'Unlock failed',
    left_locked: true,
  };
  const entry = sapWrite(
    'UpdateDomain',
    [
      {
        type: 'text',
        text: JSON.stringify({
          operation: 'succeeded',
          error: 'cleanup_failed',
          status: 500,
          cleanup,
        }),
      },
    ],
    true,
  );
  expect(journalOutcome(entry)).toBe('succeeded');
  expect(writeActions([entry])).toContain(JSON.stringify(cleanup));
});

test('lists SAP and RAG writes with typed targets, call ids and outcomes', async () => {
  const inner: IMcpClient = {
    async listTools() {
      return { ok: true, value: [] };
    },
    async callTool(name) {
      if (name === 'DeleteDomain')
        return {
          ok: false,
          error: {
            name: 'McpError',
            code: 'MCP_TRANSPORT',
            message: 'Connection lost',
          },
        };
      if (name === 'UpdateDomain')
        return {
          ok: true,
          value: { content: { success: false, domain_name: 'ZFAIL' } },
        };
      if (name === 'record_update')
        return {
          ok: true,
          value: { content: { success: false, content: 'Record absent' } },
        };
      if (name === 'record_add')
        return {
          ok: true,
          value: {
            content: {
              collection: 'session/drafts',
              record: 'record-1',
              created: true,
            },
          },
        };
      return {
        ok: true,
        value: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                task_number: 'DEVK900007',
              }),
            },
          ],
        },
      };
    },
  };
  const rec = new RecordingMcpClient(inner);
  const trace = { traceId: 'turn' };
  await rec.callTool(
    'CreateTransportTask',
    { transport_number: 'DEVK900001' },
    { trace },
  );
  await rec.callTool(
    'record_add',
    { collection: { scope: 'session', collection: 'drafts' } },
    { trace },
  );
  await rec.callTool('UpdateDomain', { domain_name: 'ZFAIL' }, { trace });
  await rec.callTool('DeleteDomain', { domain_name: 'ZPENDING' }, { trace });
  await rec.callTool('GetDomain', { domain_name: 'ZFAIL' }, { trace });
  await runWithDialogueRagTools(() =>
    rec.callTool(
      'record_update',
      { collection: 'drafts', record: 'missing' },
      { trace },
    ),
  );
  const journal = rec.getToolJournal(trace.traceId);
  const actions = writeActions(journal);
  const facts = actions
    ?.split('\n')
    .slice(1)
    .map((line) => JSON.parse(line));
  expect(facts).toEqual([
    {
      callId: journal[0].call.id,
      system: 'sap',
      operation: 'CreateTransportTask',
      targets: [{ type: 'transport', name: 'DEVK900007' }],
      outcome: 'succeeded',
    },
    {
      callId: journal[1].call.id,
      system: 'rag',
      operation: 'record_add',
      targets: [{ scope: 'session', collection: 'drafts', record: 'record-1' }],
      outcome: 'succeeded',
    },
    {
      callId: journal[2].call.id,
      system: 'sap',
      operation: 'UpdateDomain',
      targets: [{ type: 'domain', name: 'ZFAIL' }],
      outcome: 'failed',
    },
    {
      callId: journal[3].call.id,
      system: 'sap',
      operation: 'DeleteDomain',
      targets: [{ type: 'domain', name: 'ZPENDING' }],
      outcome: 'unconfirmed',
    },
    {
      callId: journal[5].call.id,
      system: 'rag',
      operation: 'record_update',
      targets: [{ scope: 'session', collection: 'drafts', record: 'missing' }],
      outcome: 'failed',
    },
  ]);
  expect(writeActions(rec.getToolJournal('other-turn'))).toBeUndefined();
});

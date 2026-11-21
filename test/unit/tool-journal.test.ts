import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { runWithDialogueRagTools } from '../../srv/lib/dialogue-rag-scope';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { writeActions } from '../../srv/lib/tool-journal';

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

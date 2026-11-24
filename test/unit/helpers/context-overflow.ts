import {
  type IMcpClient,
  LlmError,
  McpError,
  MODEL_CONTEXT_EXCEEDED,
} from '@mcp-abap-adt/llm-agent';
import { RecordingMcpClient } from '../../../srv/lib/recording-mcp-client';
import { harness } from './channel-harness';

export const overflowMessage = 'Запит перевищує контекст моделі';
export const overflowWithSapWarning = `${overflowMessage}. Результат запису невідомий. Перевір стан у SAP перед повтором.`;

export function nestedContextOverflow() {
  return new Error('private wrapper', {
    cause: new LlmError(
      'private prompt and credential',
      MODEL_CONTEXT_EXCEEDED,
    ),
  });
}

export function recorderForOverflow(
  reply: IMcpClient['callTool'] = async () => ({
    ok: false,
    error: new McpError('private transport failure', 'MCP_NO_RESPONSE'),
  }),
) {
  const callTool = jest.fn(reply);
  const recorder = new RecordingMcpClient({
    callTool,
    listTools: async () => ({ ok: true, value: [] }),
  });
  return { recorder, callTool };
}

export async function journalWithUnansweredSapWrite() {
  const { recorder } = recorderForOverflow();
  const traceId = 'dialogue-worker';
  await recorder.callTool('CreateClass', {}, { trace: { traceId } });
  const journal = new Map(
    recorder.getToolJournal(traceId).map((entry) => [entry.call.id, entry]),
  );
  recorder.dropRequest(traceId);
  return journal;
}

export const overflowModes = [
  { mode: 'JSON', stream: false, partial: false },
  { mode: 'before first event', stream: true, partial: false },
  { mode: 'after partial content', stream: true, partial: true },
];

export function arrangeChannelOverflow(partial: boolean, rejected: boolean) {
  const { recorder, callTool } = recorderForOverflow();
  harness.useRecorder(recorder);
  const error = nestedContextOverflow();
  const fail = (): { ok: false; error: Error } => {
    if (rejected) throw error;
    return { ok: false, error };
  };
  harness.process = async (_messages, options) => {
    await recorder.callTool('CreateClass', {}, options);
    return fail();
  };
  harness.stream = async function* (_messages, options) {
    if (partial) yield { ok: true, value: { content: 'partial' } };
    await recorder.callTool('CreateClass', {}, options);
    yield fail();
  };
  return { recorder, callTool };
}

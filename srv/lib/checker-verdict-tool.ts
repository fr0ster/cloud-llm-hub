import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type CallOptions,
  finishDialogueTask,
  type IMcpClient,
  type McpToolResult,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { verdictSchema, verdictToolSchema } from './checker-verdict-schema';

const scope = new AsyncLocalStorage<boolean | undefined>();
export function runWithVerdictTools<T>(
  enabled: boolean | undefined,
  run: () => T,
): T {
  return scope.run(enabled, run);
}
export function currentVerdictTools(): boolean | undefined {
  return scope.getStore();
}
export function verdictToolsEnabled(): boolean {
  return scope.getStore() === true;
}
export const submitVerdictTool = {
  name: 'submit_verdict',
  description:
    'Submit the checker verdict. Claims are required and non-empty when verdict is fail; each claim must be evidence-bound.',
  inputSchema: z.toJSONSchema(verdictToolSchema, { io: 'input' }),
  annotations: { readOnlyHint: true },
};
export function submitVerdict(
  args: Parameters<IMcpClient['callTool']>[1],
  options?: CallOptions,
): McpToolResult {
  if (!verdictToolsEnabled())
    return { isError: true, content: 'Tool unavailable to this profile.' };
  const result = verdictSchema.safeParse(args);
  if (result.success && options?.dialogueTask)
    finishDialogueTask(
      options.dialogueTask,
      JSON.stringify(result.data),
      'submit_verdict',
    );
  return result.success
    ? { content: 'verdict recorded' }
    : {
        isError: true,
        content: JSON.stringify(
          result.error.issues.map(({ path, code, message }) => ({
            path,
            code,
            message,
          })),
        ),
      };
}

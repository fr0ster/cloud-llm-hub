import { AsyncLocalStorage } from 'node:async_hooks';
import type { IMcpClient, McpToolResult } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { parseToolResultMaxChars } from '../agent-config';
import {
  currentSessionLimit,
  sessionToolResultMaxChars,
} from './execution-limits';

export const toolResultBudget = new AsyncLocalStorage<number>();

export function withinToolResultBudget<T>(
  maxChars: number,
  operation: () => T,
): T {
  maxChars = sessionToolResultMaxChars(maxChars);
  const outer =
    currentSessionLimit('toolResultMaxChars') === 'off'
      ? 0
      : (toolResultBudget.getStore() ?? 0);
  const effective =
    outer && maxChars ? Math.min(outer, maxChars) : outer || maxChars;
  return toolResultBudget.run(effective, operation);
}

export interface ToolResultRejection {
  rejected: true;
  originalLength: number;
  maxChars: number;
}

export function capToolResult(
  result: McpToolResult,
  maxChars: number,
  toolName?: string,
  logToolName = true,
): { result: McpToolResult; rejection?: ToolResultRejection } {
  maxChars = sessionToolResultMaxChars(maxChars);
  if (maxChars === 0) return { result };
  const content = result.content;
  // Match the installed tool loop's string/JSON conversion exactly.
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (text.length <= maxChars) return { result };
  const rejection: ToolResultRejection = {
    rejected: true,
    originalLength: text.length,
    maxChars,
  };
  cds.log('tool-result-cap').warn('Tool result exceeds size limit', {
    ...(logToolName && toolName ? { tool: toolName } : {}),
    originalLength: text.length,
    maxChars,
  });
  return {
    result: {
      isError: true,
      content: `Tool ${toolName ?? '(unlisted tool)'} returned ${text.length} characters, exceeding the limit of ${maxChars}. No result data is included. Narrow the request (smaller limit/max_results, a from/to range, filters, or one id).`,
    },
    rejection,
  };
}

/** Covers clients without recording (chat/controller and planner). */
export function withToolResultCap(
  inner: IMcpClient,
  maxChars = parseToolResultMaxChars(),
): IMcpClient {
  const knownNames = new Set<string>();
  return {
    get cacheable() {
      return inner.cacheable;
    },
    ...(inner.healthCheck
      ? { healthCheck: inner.healthCheck.bind(inner) }
      : {}),
    async listTools(options) {
      const result = await inner.listTools(options);
      if (result.ok) for (const tool of result.value) knownNames.add(tool.name);
      return result;
    },
    async callTool(name, args, options) {
      const result = await withinToolResultBudget(maxChars, () =>
        inner.callTool(name, args, options),
      );
      if (!result.ok) return result;
      const capped = capToolResult(
        result.value,
        maxChars,
        name,
        knownNames.has(name),
      );
      return capped.result === result.value
        ? result
        : { ...result, value: capped.result };
    },
  };
}

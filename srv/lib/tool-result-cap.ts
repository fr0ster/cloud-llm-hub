import type { IMcpClient, McpToolResult } from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';
import { parseToolResultMaxChars } from '../agent-config';

export interface ToolResultTruncation {
  truncated: true;
  originalLength: number;
  keptLength: number;
}

export function capToolResult(
  result: McpToolResult,
  maxChars: number,
  knownName?: string,
): { result: McpToolResult; truncation?: ToolResultTruncation } {
  if (maxChars === 0) return { result };
  const content = result.content;
  // Match the installed tool loop's string/JSON conversion exactly.
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (text.length <= maxChars) return { result };
  const truncation: ToolResultTruncation = {
    truncated: true,
    originalLength: text.length,
    keptLength: maxChars,
  };
  cds.log('tool-result-cap').info('Tool result truncated', {
    ...(knownName ? { tool: knownName } : {}),
    originalLength: text.length,
    keptLength: maxChars,
  });
  return {
    result: {
      ...result,
      content:
        text.slice(0, maxChars) +
        `\n[result truncated: ${maxChars} of ${text.length} characters shown. Narrow the request (smaller max_results/limit, a from/to range, filters, or one id) and page through the rest.]`,
    },
    truncation,
  };
}

/** Covers clients without recording (chat/controller and planner). */
export function withToolResultCap(
  inner: IMcpClient,
  maxChars = parseToolResultMaxChars(),
): IMcpClient {
  const knownNames = new Set<string>();
  return {
    ...(inner.healthCheck
      ? { healthCheck: inner.healthCheck.bind(inner) }
      : {}),
    async listTools(options) {
      const result = await inner.listTools(options);
      if (result.ok) for (const tool of result.value) knownNames.add(tool.name);
      return result;
    },
    async callTool(name, args, options) {
      const result = await inner.callTool(name, args, options);
      if (!result.ok) return result;
      const capped = capToolResult(
        result.value,
        maxChars,
        knownNames.has(name) ? name : undefined,
      );
      return capped.result === result.value
        ? result
        : { ...result, value: capped.result };
    },
  };
}

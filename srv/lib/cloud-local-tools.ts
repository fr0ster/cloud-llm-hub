import type { ToolDocInput } from '../agent-manager';

/**
 * Cloud-local tools: MCP tools implemented in THIS repo (not by the
 * mcp-abap-adt core `HandlerExporter`). They must be merged into the shared
 * tool-RAG corpus explicitly — the corpus is assembled purely from
 * `HandlerExporter`, so appending a handler to `listToolsHandler` alone does
 * NOT make it RAG-selectable.
 */
export const CLOUD_LOCAL_TOOLS: ToolDocInput[] = [
  {
    name: 'GetDumpSection',
    description:
      'Returns a runtime dump (ST22 short dump) section index, or one de-padded chapter when `section` is given.',
    inputSchema: {
      type: 'object',
      properties: {
        dump_id: { type: 'string' },
        section: { type: 'string' },
      },
      required: ['dump_id'],
    },
  },
];

/**
 * Merge cloud-local tool defs into a core tool-def list, deduped by name.
 * The existing (core) entry always wins — a cloud-local def is appended only
 * when `tools` has no entry with that name — so a re-merge, or a future core
 * tool of the same name, never doubles the corpus / listTools.
 */
export function mergeCloudLocalTools(tools: ToolDocInput[]): ToolDocInput[] {
  const existingNames = new Set(tools.map((t) => t.name));
  const toAppend = CLOUD_LOCAL_TOOLS.filter((t) => !existingNames.has(t.name));
  return [...tools, ...toAppend];
}

/**
 * Exposition tags for cloud-local tools, merged into `getToolExpositionMap()`
 * (`ToolDocInput` carries no exposition field of its own). Dumps need
 * MCP_Analyst, same tier as `RuntimeGetDumpById`.
 */
export const CLOUD_LOCAL_TOOL_EXPOSITIONS: Record<string, string> = {
  GetDumpSection: 'system',
};

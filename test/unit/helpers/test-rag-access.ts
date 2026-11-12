import type { RagAccess, RagCaller } from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';

export function testAccess(callers: readonly RagCaller[]): RagAccess {
  return testRagAccess(callers);
}

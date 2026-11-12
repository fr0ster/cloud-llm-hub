import type { RagCaller } from '@mcp-abap-adt/llm-agent';
import { bindCaller, callOptionsFor } from '../../../srv/lib/rag-caller';

export async function bindTestCaller(caller: RagCaller) {
  const result = await bindCaller(
    caller.sessionId,
    caller.userId,
    caller.isAdmin,
  );
  if (!result.ok) throw result.error;
  return callOptionsFor(caller);
}

import {
  RagAccessDeniedError,
  type RagCaller,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { getHubRagAccess } from './rag-access';

export async function bindCaller(
  sessionId: string,
  userId: string,
  isAdmin: boolean,
): Promise<Result<RagCaller, RagAccessDeniedError>> {
  if (!sessionId.trim() || !userId.trim() || userId === 'anonymous')
    return {
      ok: false,
      error: new RagAccessDeniedError(
        'An authenticated user and a non-empty session are required',
      ),
    };
  try {
    const bound = await getHubRagAccess().access.bindings.bind(
      sessionId,
      userId,
    );
    if (!bound.ok)
      return {
        ok: false,
        error: new RagAccessDeniedError(bound.error.message),
      };
    return { ok: true, value: { sessionId, userId, isAdmin } };
  } catch (error) {
    return {
      ok: false,
      error: new RagAccessDeniedError(
        error instanceof Error ? error.message : 'Session binding failed',
      ),
    };
  }
}

export function callOptionsFor(caller: RagCaller): {
  caller: RagCaller;
  sessionId: string;
} {
  return { caller, sessionId: caller.sessionId };
}

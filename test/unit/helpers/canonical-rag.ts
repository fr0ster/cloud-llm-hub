import cds from '@sap/cds';
import { z } from 'zod';
import { executeRagTool } from '../../../srv/agent-mcp-rag';
import {
  LongSessionRegistry,
  longSessions,
  longSessionsIfReady,
  setLongSessionsForTest,
} from '../../../srv/lib/long-session';
import { isRagTool } from '../../../srv/lib/rag-tool-catalogue';
import type { CollectionRegistry } from '../../../srv/rag-collections';
import {
  currentProfileTools,
  getRequestSessionId,
  getRequestUserId,
  isReadOnlyTools,
} from '../../../srv/request-session';

export function liveSession(
  userId = 'alice',
  key = 'test-rag-session',
): string {
  if (!longSessionsIfReady())
    setLongSessionsForTest(
      new LongSessionRegistry(
        {
          ttlMs: 3600000,
          maxSessions: 1000,
          maxPerUser: 1000,
          queueLength: 20,
        },
        { onClose: async () => {} },
      ),
    );
  if (!longSessions().get(userId, key)) {
    const session = longSessions().open(userId, { key });
    if ('refused' in session) throw new Error(session.refused);
  }
  return key;
}
export async function callRag(
  registry: CollectionRegistry,
  name: string,
  args: object,
) {
  if (!isRagTool(name)) throw new Error(`Invalid test tool: ${name}`);
  const userId = getRequestUserId() ?? cds.context?.user?.id ?? 'alice';
  return executeRagTool(
    {
      registry,
      userId,
      admin: cds.context?.user?.is?.('MCP_Admin') ?? false,
      sessionKey: liveSession(userId, getRequestSessionId()),
      internal: true,
      trustedAdmission: false,
      permissions: currentProfileTools() ?? { allows: () => true },
      readOnly: isReadOnlyTools(),
      channel: 'openai',
    },
    name,
    args,
  );
}
export async function ragBody(call: ReturnType<typeof callRag>) {
  return z
    .record(z.string(), z.json())
    .parse(JSON.parse((await call).content[0].text));
}

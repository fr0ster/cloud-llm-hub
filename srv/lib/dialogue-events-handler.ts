import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { getAgentConfig } from '../agent-config';
import { dialogueFor } from './dialogue-sessions';
import { longSessionsIfReady } from './long-session';
import type { LongSessionRequest } from './session-connection';

/** Multiple tabs receive live events; only the first connect takes pending.
 * The open channel is the WebUI's live connection, so it counts as session
 * activity: each heartbeat touches the session, and the TTL starts once the
 * channel drops (spec: TTL counts from the last activity).
 */
export async function handleDialogueEvents(
  req: Request,
  res: Response,
): Promise<void> {
  const session = (req as LongSessionRequest).longSession;
  const userId = cds.context?.user?.id ?? 'anonymous';
  if (!session || session.userId !== userId) {
    res.status(404).json({
      error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
    });
    return;
  }
  const config = getAgentConfig();
  if (config.agent.chatCoordinator !== 'dialogue') {
    res
      .status(409)
      .json({ error: { message: 'Dialogue coordinator required' } });
    return;
  }
  let closed = false;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
  };
  res.once('close', cleanup);
  const handle = await dialogueFor(
    userId,
    session.key,
    session.destination ?? config.mcp.destination ?? '',
  );
  if (closed) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event: string, data: unknown) => {
    if (!closed)
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  unsubscribe = handle.subscribe((event) => {
    if (event.kind === 'message') send('message', event.message);
    else send('task', event.task);
  });
  for (const message of handle.session.takePending()) send('message', message);
  heartbeat = setInterval(() => {
    if (closed) return;
    res.write(': heartbeat\n\n');
    longSessionsIfReady()?.touch(session.userId, session.key);
  }, 15_000);
  heartbeat.unref?.();
}

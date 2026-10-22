import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { getAgentConfig } from '../agent-config';
import { dialogueFor } from './dialogue-sessions';
import { longSessionsIfReady } from './long-session';
import type { LongSessionRequest } from './session-connection';

/** Multiple tabs receive live events; messages remain until acknowledged.
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
  await handle.drainPending();
  if (closed) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event: string, data: unknown, id?: string) => {
    if (closed) return;
    try {
      res.write(
        `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    } catch {
      cleanup();
    }
  };
  unsubscribe = handle.subscribe((event) => {
    if (event.kind === 'message')
      send('message', event.message, event.message.id);
    else send('task', event.task);
  });
  send(
    'tasks',
    handle.session.snapshot().tasks.map(({ id, worker, goal, state }) => ({
      id,
      worker,
      goal,
      state,
    })),
  );
  const cursor = req.headers?.['last-event-id'];
  for (const message of handle.outbox.replay(
    typeof cursor === 'string' ? cursor : undefined,
  ))
    send('message', message, message.id);
  if (closed) return;
  heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(': heartbeat\n\n');
    } catch {
      cleanup();
      return;
    }
    longSessionsIfReady()?.touch(session.userId, session.key);
  }, 15_000);
  heartbeat.unref?.();
}

/** Same middleware and ownership boundary as the event stream. */
export async function handleDialogueAck(
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
  if (typeof req.body?.id !== 'string' || !req.body.id) {
    res.status(400).json({ error: { message: 'Message id required' } });
    return;
  }
  const handle = await dialogueFor(
    userId,
    session.key,
    session.destination ?? config.mcp.destination ?? '',
  );
  await handle.outbox.ack(req.body.id);
  res.status(204).end();
}

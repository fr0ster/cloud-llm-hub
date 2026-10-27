import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { getAgentConfig } from '../agent-config';
import {
  type DialogueHandle,
  dialoguePlan,
  lookupDialogue,
  onDialogueCreated,
} from './dialogue-sessions';
import { longSessionsIfReady } from './long-session';
import type { LongSessionRequest } from './session-connection';
import { taskView } from './task-view';
import { dialogueUsageToWire, sumPlannerUsage } from './usage-wire';

/** Read-only view of complete session messages, plans and tasks for all tabs.
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
  let unlisten = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    closed = true;
    unsubscribe();
    unlisten();
    clearInterval(heartbeat);
  };
  res.once('close', cleanup);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event: string, data: object, id?: string) => {
    if (closed) return;
    try {
      res.write(
        `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    } catch {
      cleanup();
    }
  };
  let attached = false;
  const attach = (handle: DialogueHandle) => {
    if (closed || attached) return;
    attached = true;
    send('tasks', handle.session.snapshot().tasks.map(taskView));
    if (closed) return;
    const plan = dialoguePlan(handle.session.snapshot());
    if (plan) send('plan', plan);
    if (closed) return;
    const cursor = req.headers?.['last-event-id'];
    // subscribe replays outbox.history(cursor), including confirmed messages.
    const detach = handle.subscribe(
      (event) => {
        if (event.kind === 'message')
          send(
            'message',
            {
              ...event.message,
              usage: dialogueUsageToWire(
                sumPlannerUsage([event.message.usage]),
              ),
            },
            event.message.id,
          );
        else if (event.kind === 'usage')
          send('usage', {
            id: event.id,
            usage: dialogueUsageToWire(sumPlannerUsage([event.usage])),
          });
        else if (event.kind === 'wait') send('wait', { tasks: event.tasks });
        else if (event.kind === 'plan') send('plan', event.plan);
        else if (event.kind === 'task') send('task', taskView(event.task));
      },
      typeof cursor === 'string' ? cursor : undefined,
    );
    unsubscribe = detach;
    if (closed) detach();
  };
  unlisten = onDialogueCreated(userId, session.key, attach);
  const handle = await lookupDialogue(userId, session.key);
  if (handle) attach(handle);
  else if (!attached) send('tasks', []);
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

/** @deprecated Compatibility no-op for old WebUI tabs. Same ownership boundary
 * as the event stream; delivery is confirmed only by chat requests.
 */
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
  res.status(204).end();
}

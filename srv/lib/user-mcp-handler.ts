import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { resolveSessionKey } from '../session-id';
import { type LongSession, longSessionsIfReady } from './long-session';
import type { LongSessionRequest } from './session-connection';
import {
  UserMcpBridge,
  userMcpRegistration,
  userMcpReply,
  userMcpServerName,
  userMcpTransport,
} from './user-mcp-bridge';

export const userMcpExecutorQuery = z.object({
  userMcp: userMcpTransport,
  server: z.union([
    userMcpServerName.transform((name) => [name]),
    z.array(userMcpServerName).min(1),
  ]),
});
const deleteQuery = z.strictObject({ server: userMcpServerName.optional() });
const callIdSchema = z.uuid();

export function userMcpSessionOf(
  req: Request,
  res: Response,
): LongSession | undefined {
  const userId = cds.context?.user?.id;
  if (!userId || userId === 'anonymous') {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    return;
  }
  const { key } = resolveSessionKey(req);
  if (!key) {
    res.status(400).json({
      error: {
        code: 'SESSION_REQUIRED',
        message: 'x-clh-session is required',
      },
    });
    return;
  }
  const session = (req as LongSessionRequest).longSession;
  if (session && longSessionsIfReady()?.get(userId, key) === session)
    return session;
  res.status(404).json({
    error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
  });
}

export function invalidUserMcpRequest(
  res: Response,
  message = 'Invalid user MCP request',
): void {
  res.status(400).json({
    error: {
      code: 'INVALID_USER_MCP_REQUEST',
      message,
    },
  });
}

export function handlePutUserMcp(req: Request, res: Response): void {
  const session = userMcpSessionOf(req, res);
  if (!session) return;
  const parsed = userMcpRegistration.safeParse(req.body);
  if (!parsed.success) {
    const invalidRole = parsed.error.issues.find(
      ({ path }) =>
        path[0] === 'servers' && path[2] === 'roles' && path.length === 4,
    );
    invalidUserMcpRequest(res, invalidRole?.message);
    return;
  }
  session.userMcp ??= new UserMcpBridge();
  session.userMcp.register(parsed.data.servers);
  res.status(204).end();
}

export function handleDeleteUserMcp(req: Request, res: Response): void {
  const session = userMcpSessionOf(req, res);
  if (!session) return;
  const parsed = deleteQuery.safeParse(req.query);
  if (!parsed.success) {
    invalidUserMcpRequest(res);
    return;
  }
  session.userMcp?.unregister(parsed.data.server);
  res.status(204).end();
}

export function handleUserMcpResult(req: Request, res: Response): void {
  const session = userMcpSessionOf(req, res);
  if (!session) return;
  const callId = callIdSchema.safeParse(req.params.callId);
  const reply = userMcpReply.safeParse(req.body);
  if (!callId.success || !reply.success) {
    invalidUserMcpRequest(res);
    return;
  }
  if (!session.userMcp?.answer(callId.data, reply.data)) {
    res.status(404).json({
      error: {
        code: 'USER_MCP_CALL_NOT_FOUND',
        message: 'Pending tool call not found',
      },
    });
    return;
  }
  res.status(204).end();
}

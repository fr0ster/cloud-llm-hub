/**
 * The ABAP connection a long session holds between its requests.
 *
 * A per-request connection is built and stopped by every request. A long
 * session keeps one instead: one stateful ADT context, its CSRF token and its
 * app-server pin, so debugger state and locks outlive the request that made
 * them. `safeStop` would end all of that for good (a CloudSdkAbapConnection
 * cannot reopen once closed), so no request ever stops the held connection:
 * `releaseRequestConnection` leaves it to the session.
 *
 * Every request of a session carries its credential, and it must be the one
 * the connection was opened with (spec §6): the same SAP login and client, or
 * the same user behind the JWT. A new JWT of the same user replaces the
 * connection and says so; the old one may have expired.
 */

import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import type { Request, Response } from 'express';
import type { CredentialBinding, LongSession } from './long-session';
import type { DumpScope } from './principal';
import {
  establishRequestConnection,
  readRequestCredential,
  safeStop,
} from './request-connection';

/** A request the long-session middleware has bound to its session. */
export type LongSessionRequest = Request & { longSession?: LongSession };

export type SessionNotice = 'abap_session_renewed';

/** Tells the client what the session lost, e.g. debugger state and locks. */
export const SESSION_NOTICE_HEADER = 'x-clh-session-notice';

export type SessionConnectionResult =
  | {
      connection: IAbapConnection;
      dumpScope?: DumpScope;
      handled: false;
      notice?: SessionNotice;
    }
  | { handled: true };

type Verdict = 'same' | 'renew' | 'missing' | 'mismatch';

/** How this request's credential stands to the one the connection holds. */
function compare(bound: CredentialBinding, now: CredentialBinding): Verdict {
  // The connection was opened with a credential this request does not carry.
  if (now.kind === 'none' && bound.kind !== 'none') return 'missing';
  if (bound.kind === 'basic' && now.kind === 'jwt') return 'missing';
  if (bound.kind !== now.kind || bound.sapClient !== now.sapClient) {
    return 'mismatch';
  }
  if (bound.kind === 'basic') {
    return bound.sapLogin === now.sapLogin ? 'same' : 'mismatch';
  }
  if (bound.kind === 'jwt') {
    if (bound.jwtUser !== now.jwtUser) return 'mismatch';
    return bound.jwt === now.jwt ? 'same' : 'renew';
  }
  return 'same';
}

function refuse(
  res: Response,
  status: number,
  type: string,
  message: string,
  destination: string,
): { handled: true } {
  // The shape `establishRequestConnection` writes for a credential failure.
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type, message, destination } }));
  return { handled: true };
}

/**
 * The session's connection for this request: the held one when the credential
 * matches, else a new one (first request, destination switch, renewed JWT).
 * A refusal or a failed connect has its 401/403 written to `res`; a notice
 * goes out as the `x-clh-session-notice` header.
 */
export async function acquireSessionConnection(
  s: LongSession,
  req: Request,
  res: Response,
  destination: string,
): Promise<SessionConnectionResult> {
  let notice: SessionNotice | undefined;
  // On the same destination the credential must be the one bound. A
  // destination switch binds anew: another system may need another user.
  if (s.connection && s.destination === destination) {
    const credential = readRequestCredential(req, {
      userDependent: s.binding?.userDependent,
    });
    switch (compare(s.binding ?? { kind: 'none' }, credential)) {
      case 'same':
        return {
          connection: s.connection,
          dumpScope: s.dumpScope,
          handled: false,
        };
      case 'missing':
        return refuse(
          res,
          401,
          'SAP_CREDENTIALS_REQUIRED',
          `This session's SAP connection was opened with your SAP credentials; send them with every request of the session.`,
          destination,
        );
      case 'mismatch':
        return refuse(
          res,
          403,
          'SESSION_CREDENTIAL_MISMATCH',
          'This session belongs to another SAP login. Open a new session for it.',
          destination,
        );
      case 'renew':
        notice = 'abap_session_renewed';
        break;
    }
  }

  // The new connection first: a request refused here (missing credentials,
  // failed connect) leaves the held connection, binding and destination as
  // they were. Only once it stands does the old ABAP session go.
  const established = await establishRequestConnection(req, res, destination);
  if (established.handled || !established.connection) return { handled: true };
  if (s.connection) await dropSessionConnection(s);
  s.connection = established.connection;
  s.dumpScope = established.dumpScope;
  s.binding = established.credential ?? readRequestCredential(req);
  s.destination = destination;
  if (notice) res.setHeader(SESSION_NOTICE_HEADER, notice);
  return {
    connection: established.connection,
    dumpScope: established.dumpScope,
    handled: false,
    ...(notice ? { notice } : {}),
  };
}

/** End of a request: a connection the session holds stays open; any other is stopped. */
export async function releaseRequestConnection(
  connection: IAbapConnection | undefined,
  s?: LongSession,
): Promise<void> {
  if (connection && s?.connection === connection) return;
  await safeStop(connection);
}

/** Stops the held connection and forgets it with its credential. */
export async function dropSessionConnection(s: LongSession): Promise<void> {
  const connection = s.connection;
  s.connection = undefined;
  s.dumpScope = undefined;
  s.binding = undefined;
  await safeStop(connection);
}

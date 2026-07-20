/**
 * Per-request SAP connection establishment — shared by every channel that runs
 * ABAP tools on the user's behalf (`/v1/chat/completions`, `/v1/messages`, and
 * any future endpoint).
 *
 * Policy (fail-closed — no default destination service user is ever used):
 * - **On-premise destinations** (ProxyType=OnPremise) and **NoAuthentication**
 *   destinations REQUIRE the caller's own ABAP `x-sap-login` / `x-sap-password`.
 *   Missing → 401 SAP_CREDENTIALS_REQUIRED, no connection is built.
 * - **Cloud destinations** (Internet proxy, http) use the destination's
 *   configured auth (typically a JWT via OAuth2ClientCredentials /
 *   OAuth2SAMLBearerAssertion principal propagation). If the caller still sends
 *   `x-sap-login` / `x-sap-password`, those override with basic auth.
 * - Either way the connection is `connect()`-validated before the request runs,
 *   so a bad/expired credential fails here with 401 instead of mid-pipeline.
 *
 * Principal-propagation refinement is deliberately left for a follow-up — for now
 * the resolved destination JWT is passed through unchanged for cloud destinations.
 */

import type { SapConfig } from '@mcp-abap-adt/connection';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces';
import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { createConnection } from './../connections/connectionFactory';
import { resolveDestinationSapConfig } from './../connections/destinationResolver';
import { maskLoginForLog } from './log-mask';
import { computeDumpScope, type DumpScope } from './principal';
import { setRequestResponsible } from './responsible';

export type CredentialError = Error & {
  statusCode?: number;
  code?: string;
  destination?: string;
};

function credentialError(
  message: string,
  destination: string,
  code = 'SAP_CREDENTIALS_REQUIRED',
): CredentialError {
  const err = new Error(message) as CredentialError;
  err.statusCode = 401;
  err.code = code;
  err.destination = destination;
  return err;
}

export interface EstablishResult {
  /** The validated per-request connection (already set in ALS), or undefined when no destination was requested. */
  connection?: IAbapConnection;
  /** True when an error response has already been written to `res` and the caller must return immediately. */
  handled: boolean;
  /** Principal scope for GetDumpSection — the caller must thread it into
   * runWithRequestConnection so the tool has a principal on this (chat) path too. */
  dumpScope?: DumpScope;
}

/**
 * Resolve the destination, enforce the credential policy, build + validate a
 * per-request ABAP connection, and register it in the AsyncLocalStorage scope.
 *
 * On any failure this writes a structured 401/JSON error to `res` and returns
 * `{ handled: true }` — the caller must `return` without touching the agent.
 *
 * When `destination` is empty (LLM-only, no SAP) it is a no-op:
 * `{ handled: false, connection: undefined }`.
 */
export async function establishRequestConnection(
  req: Request,
  res: Response,
  destination: string | undefined,
): Promise<EstablishResult> {
  const log = cds.log('request-connection');

  if (!destination) {
    return { handled: false };
  }

  const sapLogin = (req.headers['x-sap-login'] as string | undefined)?.trim();
  const sapPassword = req.headers['x-sap-password'] as string | undefined;
  // Caller-supplied SAP client (mandant), e.g. "600". Overrides the
  // destination's own sap-client so a single URL-only destination can serve
  // multiple clients per request.
  const sapClient = (req.headers['x-sap-client'] as string | undefined)?.trim();

  try {
    const resolved = await resolveDestinationSapConfig(
      destination,
      req.headers.authorization?.replace('Bearer ', ''),
    );

    // On-premise (Cloud Connector) and NoAuthentication destinations must run
    // under the caller's own ABAP user — never a destination service user.
    const requiresUserCredentials =
      (resolved.proxyType ?? '').toLowerCase() === 'onpremise' ||
      resolved.authenticationType === 'NoAuthentication';

    if (requiresUserCredentials && (!sapLogin || !sapPassword)) {
      throw credentialError(
        `Destination "${destination}" requires your SAP username and password.`,
        destination,
      );
    }

    // The basic-auth override needs BOTH a login and a password — a login alone
    // does NOT authenticate as that login. Everything below (auth config, the
    // diagnostic log, and the dump principal) keys off this single flag.
    const usedBasicOverride = !!(sapLogin && sapPassword);
    const sapConfig: SapConfig = { ...resolved.sapConfig };
    if (usedBasicOverride) {
      // Caller-supplied basic auth overrides the destination's own auth.
      sapConfig.authType = 'basic';
      sapConfig.username = sapLogin;
      sapConfig.password = sapPassword;
      delete sapConfig.jwtToken;
    }
    // Cloud destinations with no caller credentials keep the resolved auth
    // (JWT from the destination / principal propagation passthrough).

    // Per-request client (mandant) override — wins over the destination's
    // sap-client. Sent on the wire as the X-SAP-Client header.
    if (sapClient) {
      sapConfig.client = sapClient;
    }

    const conn = createConnection({
      sapConfig,
      destinationName: resolved.destinationName,
    });
    await conn.connect();

    const connection = conn as unknown as IAbapConnection;
    // NOTE: do NOT bind via enterWith here — the ALS store would be lost across
    // the SmartAgent pipeline's async hops. The caller binds it for the whole
    // agent run via runWithRequestConnection(...) (als.run), so tool calls see it.

    log.info('Per-request SAP connection established', {
      destination,
      auth: usedBasicOverride ? 'user-basic' : sapConfig.authType,
      username: usedBasicOverride
        ? maskLoginForLog(sapLogin)
        : '(destination-auth)',
    });

    // Per-request responsible person for ADT writes (create/update/delete):
    // x-sap-responsible, else the connecting x-sap-login user.
    setRequestResponsible(req.headers);

    // Principal scope for GetDumpSection — same derivation as the planner path,
    // so the tool has a principal when RAG-selected on the chat (/v1) channels.
    const dumpScope = computeDumpScope({
      cdsUserId: cds.context?.user?.id ?? 'anonymous',
      usedBasicOverride,
      sapLogin,
      destinationAuthType: sapConfig.authType,
      resolvedUsername: resolved.username,
      destinationName: resolved.destinationName,
      rawClient: sapClient,
      resolvedClient: resolved.sapConfig.client,
      jwtSub: null,
    });

    return { connection, handled: false, dumpScope };
  } catch (connErr) {
    const err = connErr instanceof Error ? connErr : new Error(String(connErr));
    const errWithCode = err as CredentialError;
    const status = errWithCode.statusCode ?? 401;

    log.warn('Per-request SAP connection unavailable', {
      destination,
      username: maskLoginForLog(sapLogin),
      code: errWithCode.code,
      error: err.message,
    });

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: errWithCode.code || 'sap_credentials_failed',
          message: err.message,
          destination: errWithCode.destination || destination,
        },
      }),
    );
    return { handled: true };
  }
}

/** Best-effort release of a per-request connection (call in `finally`).
 * Ends the server-side ADT stateful session first (releases any edit-lock a
 * mutating tool left open — the "currently editing"/inactive-object symptom),
 * then clears local state. Never throws. */
export async function resetRequestConnection(
  connection?: IAbapConnection,
): Promise<void> {
  await (
    connection as { closeSession?: () => Promise<void> } | undefined
  )?.closeSession?.();
  (connection as { reset?: () => void } | undefined)?.reset?.();
}

import type { SapConfig } from '@mcp-abap-adt/connection';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import cds from '@sap/cds';
import type { Request } from 'express';
import { createConnection } from '../connections/connectionFactory';
import { resolveDestinationSapConfig } from '../connections/destinationResolver';
import { bearerToken, computeDumpScope } from './principal';
import { safeStop } from './request-connection';
import {
  bindSystemIdentity,
  warmSystemIdentity,
} from './system-identity-cache';
import { resolveSystemType } from './system-type';

interface BuiltConnection {
  connection: IAbapConnection;
  resolved: Awaited<ReturnType<typeof resolveDestinationSapConfig>>;
  sapConfig: SapConfig;
  sapLogin: string | undefined;
  sapClient: string | undefined;
  // True iff the basic-auth override was actually applied (login AND password
  // both present). The password itself is NOT returned — only this flag.
  usedBasicOverride: boolean;
}

/** Whether the background connection authenticates with the SAP basic headers. */
export function usesBackgroundBasicOverride(
  authenticationType: string | undefined,
  headers: Pick<Request, 'headers'>['headers'],
): boolean {
  const sapLogin = (headers['x-sap-login'] as string | undefined)?.trim();
  const sapPassword = headers['x-sap-password'] as string | undefined;
  return (
    authenticationType !== 'PrincipalPropagation' && !!(sapLogin && sapPassword)
  );
}

/**
 * Build the per-request SAP connection for a chosen destination, using the
 * credentials carried in the request headers (set by the auth proxy or the
 * client). Mirrors the fail-closed per-request policy used by the other
 * channels; throws on a missing/invalid credential instead of writing a
 * response (the caller turns it into an MCP tool error).
 */
export async function buildConnectionForDestination(
  req: Pick<Request, 'headers'>,
  destination: string,
): Promise<BuiltConnection> {
  const sapLogin = (req.headers['x-sap-login'] as string | undefined)?.trim();
  const sapPassword = req.headers['x-sap-password'] as string | undefined;
  const sapClient = (req.headers['x-sap-client'] as string | undefined)?.trim();

  const resolved = await resolveDestinationSapConfig(
    destination,
    bearerToken(req.headers.authorization),
  );

  if (
    resolved.authenticationType === 'PrincipalPropagation' &&
    (sapLogin || sapPassword)
  ) {
    cds
      .log('agent-mcp')
      .debug(
        'Ignoring x-sap-login/x-sap-password because the destination uses principal propagation',
      );
  }
  // The declared kind, by the one rule (`lib/system-type.ts`): an unknown
  // value is refused before any connection is built. Logged like the other
  // channels; lib 16's HandlerExporter takes no per-destination kind, so the
  // embedded handlers run it as on-premise.
  const systemType = resolveSystemType(req.headers, resolved.systemType);
  cds.log('agent-mcp').info('execute_step connection', {
    destination,
    systemType,
  });

  const requiresUserCredentials =
    ((resolved.proxyType ?? '').toLowerCase() === 'onpremise' &&
      resolved.authenticationType !== 'PrincipalPropagation') ||
    resolved.authenticationType === 'NoAuthentication';
  if (requiresUserCredentials && (!sapLogin || !sapPassword)) {
    throw new Error(
      `Destination "${destination}" requires your SAP username and password (x-sap-login / x-sap-password).`,
    );
  }

  const usedBasicOverride = usesBackgroundBasicOverride(
    resolved.authenticationType,
    req.headers,
  );
  const sapConfig: SapConfig = { ...resolved.sapConfig };
  if (usedBasicOverride) {
    sapConfig.authType = 'basic';
    sapConfig.username = sapLogin;
    sapConfig.password = sapPassword;
    sapConfig.jwtToken = undefined;
  }
  if (sapClient) sapConfig.client = sapClient;

  const conn = createConnection({
    sapConfig,
    destinationName: resolved.destinationName,
  });
  try {
    await conn.connect();
  } catch (error) {
    await safeStop(conn);
    throw error;
  }
  bindSystemIdentity(conn, {
    systemType,
    sapConfig,
    destinationName: resolved.destinationName,
    authenticationType: resolved.authenticationType,
    jwt: bearerToken(req.headers.authorization),
  });
  await warmSystemIdentity(conn, systemType);
  return {
    connection: conn,
    resolved,
    sapConfig,
    sapLogin,
    sapClient,
    usedBasicOverride,
  };
}

/** Explicit ownership also works outside an HTTP/CDS request context. */
export function dumpScopeForConnection(built: BuiltConnection, userId: string) {
  const { resolved, sapConfig, sapLogin, sapClient, usedBasicOverride } = built;
  return computeDumpScope({
    cdsUserId: userId,
    usedBasicOverride,
    sapLogin,
    destinationAuthType: sapConfig.authType,
    resolvedUsername: resolved.username,
    destinationName: resolved.destinationName,
    rawClient: sapClient,
    resolvedClient: resolved.sapConfig.client,
    jwtSub: null,
  });
}

import cds from '@sap/cds';
import type { NextFunction, Request, Response } from 'express';
import { MCP_ROLES } from './exposition';

/** Auth + role check middleware: user must be authenticated AND have at least one tool role */
export const requireMcpRole = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  const user = cds.context?.user;
  if (!user || user.is('anonymous')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header',
    });
    return;
  }
  const hasRole = MCP_ROLES.some((role) => user.is(role));
  if (!hasRole) {
    // A technical token gets a different message on purpose. Telling the
    // operator of a client_credentials client to "assign a role collection"
    // sends them to their own BTP user, where the roles already are and
    // where changing them cannot help: the token carries the CLIENT's
    // scopes, not theirs.
    const technical = user.is('system-user');
    res.status(403).json({
      error: 'Forbidden',
      message: technical
        ? `Access denied: authenticated as technical client "${user.id}" (client_credentials). Its xsuaa client holds neither MCP_Reader nor MCP_Developer; a human's role collections do not apply. Grant the scope to the client, or authenticate as a user.`
        : 'Access denied: user has no MCP roles. Assign MCP_Reader or MCP_Developer role collection.',
    });
    return;
  }
  next();
};

import cds from '@sap/cds';
import type { NextFunction, Request, Response } from 'express';

/** Independent administrative authorization; intentionally not mounted yet. */
export function requireAdminRole(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = cds.context?.user;
  if (!user || user.is('anonymous')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header',
    });
    return;
  }
  if (!user.is('MCP_Admin')) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Access denied: MCP_Admin is required.',
    });
    return;
  }
  next();
}

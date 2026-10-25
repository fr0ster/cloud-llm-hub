import cds from '@sap/cds';
import type { Request, Response } from 'express';
import { requireAdminRole } from '../../srv/lib/require-admin-role';
import { requireMcpRole } from '../../srv/lib/require-mcp-role';

jest.mock('@sap/cds', () => ({ context: undefined }));

describe('independent admin and tool authorization', () => {
  afterEach(() => {
    cds.context = undefined;
  });

  it.each([
    [[], 403, 403],
    [['MCP_Admin'], 200, 403],
    [['MCP_Reader'], 403, 200],
    [['MCP_Developer'], 403, 200],
    [['MCP_Admin', 'MCP_Developer'], 200, 200],
    [['MCP_Analyst'], 403, 403],
    [['MCP_Full'], 403, 403],
    [['anonymous', 'MCP_Admin', 'MCP_Developer'], 401, 401],
  ])('roles %j: admin %s, tools %s', (roles, adminStatus, toolStatus) => {
    cds.context = {
      user: { id: 'test', is: (role: string) => roles.includes(role) },
    } as unknown as typeof cds.context;
    for (const [middleware, expected] of [
      [requireAdminRole, adminStatus],
      [requireMcpRole, toolStatus],
    ] as const) {
      const next = jest.fn();
      const status = jest.fn().mockReturnThis();
      const json = jest.fn();
      middleware({} as Request, { status, json } as unknown as Response, next);
      if (expected === 200) {
        expect(next).toHaveBeenCalledTimes(1);
        expect(status).not.toHaveBeenCalled();
      } else {
        expect(status).toHaveBeenCalledWith(expected);
        expect(next).not.toHaveBeenCalled();
      }
    }
  });

  it('refuses an absent user with 401', () => {
    for (const middleware of [requireAdminRole, requireMcpRole]) {
      const status = jest.fn().mockReturnThis();
      const next = jest.fn();
      middleware(
        {} as Request,
        { status, json: jest.fn() } as unknown as Response,
        next,
      );
      expect(status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });
});

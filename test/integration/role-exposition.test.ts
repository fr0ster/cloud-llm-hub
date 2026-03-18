import { resolve } from 'node:path';
import { config } from 'dotenv';

// Load .env from project root
config({ path: resolve(__dirname, '../../.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4004';
const SAP_URL = process.env.SAP_URL;
const SAP_AUTH_TYPE = process.env.SAP_AUTH_TYPE || 'jwt';
const SAP_JWT_TOKEN = process.env.SAP_JWT_TOKEN;

/** Mocked users from package.json cds.requires.auth */
const USERS = {
  alice: {
    roles: ['MCP_Full', 'MCP_Developer', 'MCP_Analyst', 'MCP_Reader'],
    expectedGroups: ['readonly', 'search', 'system', 'high', 'compact'],
  },
  bob: {
    roles: ['MCP_Developer', 'MCP_Analyst', 'MCP_Reader'],
    expectedGroups: ['readonly', 'search', 'system', 'high'],
  },
  carol: {
    roles: ['MCP_Analyst', 'MCP_Reader'],
    expectedGroups: ['readonly', 'search', 'system'],
  },
  dave: {
    roles: ['MCP_Reader'],
    expectedGroups: ['readonly', 'search'],
  },
};

function basicAuth(user: string): string {
  return `Basic ${Buffer.from(`${user}:`).toString('base64')}`;
}

function sapHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (SAP_URL) headers['x-sap-url'] = SAP_URL;
  if (SAP_AUTH_TYPE) headers['x-sap-auth-type'] = SAP_AUTH_TYPE;
  if (SAP_JWT_TOKEN) headers['x-sap-jwt-token'] = SAP_JWT_TOKEN;
  return headers;
}

async function mcpRequest(
  user: string,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/mcp/stream/http`, {
    method: 'POST',
    headers: {
      ...sapHeaders(),
      Authorization: basicAuth(user),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }),
  });

  let body: unknown;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function getToolCount(body: unknown): number {
  const result = (body as { result?: { tools?: unknown[] } })?.result;
  return result?.tools?.length ?? 0;
}

function getToolNames(body: unknown): string[] {
  const result = (body as { result?: { tools?: { name: string }[] } })?.result;
  return (result?.tools ?? []).map((t) => t.name).sort();
}

const skipReason =
  !SAP_URL || !SAP_JWT_TOKEN
    ? 'Skipped: SAP_URL and SAP_JWT_TOKEN must be set in .env'
    : undefined;

const describeIfConfigured = skipReason ? describe.skip : describe;

describeIfConfigured('Role-based exposition (integration)', () => {
  jest.setTimeout(30_000);

  for (const [user, config] of Object.entries(USERS)) {
    describe(`user: ${user} (${config.roles.join(', ')})`, () => {
      let toolNames: string[] = [];
      let toolCount = 0;

      beforeAll(async () => {
        // Initialize MCP session
        const init = await mcpRequest(user, 'initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        });
        expect(init.status).toBe(200);

        // List tools
        const list = await mcpRequest(user, 'tools/list', {}, 2);
        expect(list.status).toBe(200);
        toolNames = getToolNames(list.body);
        toolCount = getToolCount(list.body);
      });

      it('should return tools', () => {
        expect(toolCount).toBeGreaterThan(0);
      });

      if (!config.roles.includes('MCP_Developer')) {
        it('should NOT include high-level CRUD tools', () => {
          const crudTools = toolNames.filter(
            (t) =>
              t.startsWith('Create') ||
              t.startsWith('Update') ||
              t.startsWith('Delete'),
          );
          expect(crudTools).toEqual([]);
        });
      }

      if (config.roles.includes('MCP_Developer')) {
        it('should include high-level CRUD tools', () => {
          const hasCreate = toolNames.some((t) => t.startsWith('Create'));
          expect(hasCreate).toBe(true);
        });
      }

      if (!config.roles.includes('MCP_Analyst')) {
        it('should NOT include system tools', () => {
          const systemTools = toolNames.filter(
            (t) =>
              t.startsWith('GetTypeInfo') ||
              t.startsWith('GetWhereUsed') ||
              t.startsWith('GetSqlQuery'),
          );
          expect(systemTools).toEqual([]);
        });
      }

      if (config.roles.includes('MCP_Analyst')) {
        it('should include system tools', () => {
          const hasSystem = toolNames.some(
            (t) => t === 'GetWhereUsed' || t === 'GetSqlQuery',
          );
          expect(hasSystem).toBe(true);
        });
      }

      if (config.roles.includes('MCP_Full')) {
        it('should include compact handler tools', () => {
          const hasCompact = toolNames.some((t) => t.startsWith('Handler'));
          expect(hasCompact).toBe(true);
        });
      }

      if (!config.roles.includes('MCP_Full')) {
        it('should NOT include compact handler tools', () => {
          const compactTools = toolNames.filter((t) => t.startsWith('Handler'));
          expect(compactTools).toEqual([]);
        });
      }

      it('should always include read and search tools', () => {
        const hasRead = toolNames.some((t) => t.startsWith('Read'));
        const hasSearch = toolNames.some((t) => t === 'SearchObject');
        expect(hasRead).toBe(true);
        expect(hasSearch).toBe(true);
      });
    });
  }

  it('tool counts should increase with higher roles', async () => {
    const counts: Record<string, number> = {};

    for (const user of ['dave', 'carol', 'bob', 'alice']) {
      const init = await mcpRequest(user, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      });
      expect(init.status).toBe(200);

      const list = await mcpRequest(user, 'tools/list', {}, 2);
      counts[user] = getToolCount(list.body);
    }

    // dave(Reader) < carol(Analyst) < bob(Developer) < alice(Full)
    expect(counts.dave).toBeLessThan(counts.carol);
    expect(counts.carol).toBeLessThan(counts.bob);
    expect(counts.bob).toBeLessThan(counts.alice);
  });
});

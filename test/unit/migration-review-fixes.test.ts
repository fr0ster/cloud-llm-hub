import { z } from 'zod';
import { AgentToolPermissions } from '../../srv/lib/agent-profile-tools';
import { runWithProfileTools } from '../../srv/request-session';

const networkTools = z.object({
  result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
});

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { establishRequestConnection } from '../../srv/lib/request-connection';

jest.mock('../../srv/env-setup', () => ({}));
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    context: {
      user: { id: 'reader', is: (role: string) => role === 'MCP_Reader' },
    },
  },
}));
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async (
    destinationName: string,
    jwt?: string,
  ) => ({
    destinationName,
    proxyType: 'OnPremise',
    authenticationType:
      destinationName === 'PP' ? 'PrincipalPropagation' : 'NoAuthentication',
    sapConfig: {
      url: 'http://sap',
      authType: destinationName === 'PP' ? 'jwt' : 'basic',
      jwtToken: jwt,
    },
  }),
}));
let configureFresh: ((connection: any) => void) | undefined;
const created: Array<{ options: any; connection: any }> = [];
jest.mock('../../srv/connections/connectionFactory', () => ({
  ...jest.requireActual('../../srv/connections/connectionFactory'),
  createConnection: (options: any) => {
    const connection = {
      connect: jest.fn(async () => {}),
      disconnect: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
      reset: jest.fn(),
      setSessionType() {},
      getSessionId: () => null,
      getBaseUrl: async () => 'http://sap',
      makeAdtRequest: jest.fn(async () => {
        throw new Error('offline');
      }),
    };
    if (created.length > 0) configureFresh?.(connection);
    created.push({ options, connection });
    return connection;
  },
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Request } from 'express';
import {
  buildEmbeddedMcpAdapter,
  runWithRequestConnection,
} from '../../srv/agent-manager';
import { createMCPServerForRequest } from '../../srv/mcp-manager';

const optionsSeen: any[] = [];
jest.mock('@mcp-abap-adt/lib/embeddable', () => {
  const Actual = jest.requireActual(
    '@mcp-abap-adt/lib/embeddable',
  ).EmbeddableMcpServer;
  return {
    EmbeddableMcpServer: class extends Actual {
      constructor(options: any) {
        super(options);
        optionsSeen.push(options);
      }
    },
  };
});
beforeEach(() => {
  created.length = 0;
  optionsSeen.length = 0;
  configureFresh = undefined;
});
const request = (destination: string, user: string) =>
  ({
    headers: {
      'x-sap-destination': destination,
      'x-sap-login': user,
      'x-sap-password': `secret-${user}`,
      'x-sap-client': '600',
      authorization: `Bearer token-${user}`,
    },
  }) as unknown as Request;

it.each(['BASIC', 'PP'])(
  'isolates concurrent agent calls across resolver awaits (%s)',
  async (style) => {
    const adapter = await buildEmbeddedMcpAdapter(style);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let arrived = 0;
    const used: string[] = [];
    // Preserve the real exporter wrappers and groups; substitute only ADT I/O.
    const run = async (user: string) => {
      const established = await establishRequestConnection(
        request(style, user),
        {} as never,
        style,
      );
      expect(established.handled).toBe(false);
      const connection = established.connection;
      if (!connection) throw new Error('missing request connection');
      connection.getBaseUrl = async () => {
        if (++arrived === 2) release();
        await gate;
        return 'http://sap';
      };
      connection.makeAdtRequest = async () => {
        used.push(user);
        throw new Error(`connection-${user}`);
      };
      return runWithRequestConnection(
        connection as never,
        () => adapter.callTool('GetClass', { class_name: 'ZCL_TEST' }),
        undefined,
        ['readonly', 'high', 'search', 'system'],
      );
    };
    await Promise.all([run('ALICE'), run('BOB')]);
    expect(used).toContain('ALICE');
    expect(used).toContain('BOB');
  },
);

it.each(['RuntimeRunClass', 'RuntimeRunProgram'])(
  'refuses agent background execution for %s',
  async (name) => {
    const adapter = await buildEmbeddedMcpAdapter('BASIC');
    const listed = await adapter.listTools();
    expect(listed.ok).toBe(true);
    if (listed.ok)
      expect(
        listed.value.find((t) => t.name === name)?.inputSchema?.properties,
      ).not.toHaveProperty('background');
    const result = await runWithRequestConnection(
      {} as never,
      () => adapter.callTool(name, { background: true }),
      undefined,
      ['readonly', 'high', 'search', 'system'],
    );
    expect(JSON.stringify(result)).toContain('background_runs_unavailable');
  },
);

it('raw readers cannot list or call execution and write tools', async () => {
  const bound = await createMCPServerForRequest(request('BASIC', 'ALICE'), {
    establish: false,
  });
  try {
    // The policy wraps send before SDK initialization, so exercise its actual boundary.
    // Use a small HTTP response stand-in for forbidden calls (no SDK dispatch).
    for (const name of [
      'RuntimeRunClass',
      'RuntimeRunProgram',
      'RuntimeCreateProfilerTraceParameters',
      'DiscardBackgroundRun',
      'CreateClass',
    ]) {
      let body = '';
      await bound.handle(
        { headers: {} } as any,
        {
          writeHead() {},
          end(text: string) {
            body = text;
          },
        } as any,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: {} },
        },
      );
      expect(JSON.parse(body).result.isError).toBe(true);
    }
    expect(created[0].connection.makeAdtRequest).not.toHaveBeenCalled();
  } finally {
    await bound.cleanup();
  }
});

it.each(['BASIC', 'PP'])(
  'request fresh factory retains credentials and destination (%s)',
  async (style) => {
    const requests = await Promise.all(
      ['ALICE', 'BOB'].map((user) =>
        createMCPServerForRequest(request(style, user), { establish: false }),
      ),
    );
    try {
      await Promise.all(
        optionsSeen.map((options) => options.freshConnection()),
      );
      for (const user of ['ALICE', 'BOB']) {
        const matching = created.filter(({ options }) =>
          style === 'PP'
            ? options.sapConfig.jwtToken === `token-${user}`
            : options.sapConfig.username === user,
        );
        expect(matching).toHaveLength(2);
        expect(matching[0].options).toEqual(matching[1].options);
        expect(matching[1].options.destinationName).toBe(style);
        expect(matching[1].options.sapConfig.client).toBe('600');
      }
    } finally {
      await Promise.all(requests.map((r) => r.cleanup()));
    }
  },
);

it.each(['failed', 'connecting', 'reading'])(
  'cleans up fresh long read while %s, even when dispose fails',
  async (phase) => {
    const bound = await createMCPServerForRequest(request('BASIC', 'ALICE'), {
      establish: false,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    configureFresh = (fresh) => {
      fresh.connect.mockImplementation(async () => {
        if (phase === 'failed') {
          started();
          throw new Error('fresh connect failed');
        }
        if (phase === 'connecting') {
          started();
          await gate;
        }
      });
      fresh.makeAdtRequest.mockImplementation(async () => {
        started();
        await gate;
        throw new Error('read ended');
      });
    };
    const server = bound.server;
    await bound.transport.close();
    const client = new Client({ name: 'review', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const call = client
      .callTool({ name: 'GetTableContents', arguments: { table_name: 'T000' } })
      .catch((e) => e);
    await entered;
    // Exercise the hub cleanup with the instance owning the in-flight fresh call.
    jest
      .spyOn(bound.server, 'dispose')
      .mockRejectedValueOnce(new Error('dispose failed'));
    await expect(bound.cleanup()).rejects.toThrow('dispose failed');
    release();
    await call;
    expect(created[1].connection.disconnect).toHaveBeenCalled();
    expect(created[0].connection.close).toHaveBeenCalled();
    await client.close();
    await server.terminalClose();
  },
);

it('raw tools/list shows only hub readonly tools', async () => {
  const bound = await createMCPServerForRequest(request('BASIC', 'ALICE'), {
    establish: false,
  });
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    await bound.handle(req, res, JSON.parse(Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
    );
    const body = (await response.json()) as any;
    expect(body.result.tools.map((t: any) => t.name)).toContain('GetClass');
    for (const name of [
      'RuntimeRunClass',
      'RuntimeRunProgram',
      'RuntimeCreateProfilerTraceParameters',
      'DiscardBackgroundRun',
      'CreateClass',
    ]) {
      expect(body.result.tools.map((t: any) => t.name)).not.toContain(name);
    }
  } finally {
    await bound.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  }
});

it('agent long reads finish on their request connection', async () => {
  const adapter = await buildEmbeddedMcpAdapter('BASIC');
  const io = jest.fn(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return {
      status: 200,
      headers: {},
      data: '<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"><totalRows>0</totalRows></dataPreview:tableData>',
    };
  });
  const connection = {
    getBaseUrl: async () => 'http://sap',
    getSessionId: () => null,
    makeAdtRequest: io,
  };
  const result = await runWithRequestConnection(
    connection as never,
    () =>
      adapter.callTool('GetTableContents', {
        table_name: 'T000',
        detail: 'raw',
      }),
    undefined,
    ['readonly', 'search', 'system'],
  );
  expect(io).toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('fresh_connection_unavailable');
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.isError).toBe(false);
});

it('does not advertise agent timeouts or dedicated sessions', async () => {
  const adapter = await buildEmbeddedMcpAdapter('BASIC');
  const listed = await adapter.listTools();
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw new Error('tool listing failed');
  for (const tool of listed.value) {
    expect(tool.inputSchema?.properties).not.toHaveProperty('timeout');
    expect(tool.description).not.toContain('Optional timeout');
    expect(tool.description).not.toContain(
      'Runs on an ABAP session of its own',
    );
  }
});

it.each([1, 0, null, '1'])(
  'rejects explicit agent timeout %p before ADT execution',
  async (timeout) => {
    const adapter = await buildEmbeddedMcpAdapter('BASIC');
    const io = jest.fn();
    const result = await runWithRequestConnection(
      { makeAdtRequest: io } as never,
      () =>
        adapter.callTool('GetTableContents', { table_name: 'T000', timeout }),
      undefined,
      ['readonly', 'search', 'system'],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('agent_timeout_unavailable');
    expect(io).not.toHaveBeenCalled();
  },
);

it('retrieval query label arrays contain no duplicates', () => {
  const queries = require('../../tools/tool-rag-queries.json');
  function check(value: unknown): void {
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string'))
        expect(new Set(value).size).toBe(value.length);
      else value.forEach(check);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(check);
    }
  }
  check(queries);
});

it('profile embedded definitions and forged SAP/cloud calls share the execution guard', async () => {
  const adapter = await buildEmbeddedMcpAdapter('BASIC');
  await runWithProfileTools(
    new AgentToolPermissions(['GetClass']),
    async () => {
      const listed = await adapter.listTools();
      expect(listed.ok && listed.value.map((tool) => tool.name)).toEqual([
        'GetClass',
      ]);
      for (const name of ['CreateClass', 'GetDumpSection', 'RuntimeRunClass']) {
        expect(JSON.stringify(await adapter.callTool(name, {}))).toContain(
          'forbids',
        );
      }
    },
  );
  expect(created).toEqual([]);
});

it('profile network definitions and forged direct calls reject before backend I/O', async () => {
  const permissions = new AgentToolPermissions(['GetClass']);
  const bound = await createMCPServerForRequest(request('BASIC', 'ALICE'), {
    establish: false,
  });
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', resolve);
    });
    await runWithProfileTools(permissions, () =>
      bound.handle(req, res, JSON.parse(Buffer.concat(chunks).toString())),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing HTTP address');
  const post = async (method: string, name?: string): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        ...(name ? { params: { name, arguments: {} } } : {}),
      }),
    });
    return response.text();
  };
  try {
    const listed = networkTools.parse(JSON.parse(await post('tools/list')));
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(['GetClass']);
    for (const name of ['CreateClass', 'GetTable', 'RuntimeRunClass']) {
      expect(await post('tools/call', name)).toContain('forbids');
    }
    for (const connection of created)
      expect(connection.connection.makeAdtRequest).not.toHaveBeenCalled();
  } finally {
    await bound.cleanup();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

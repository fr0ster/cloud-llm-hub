import { HandlerExporter, isArgsOnly } from '@mcp-abap-adt/lib/handlers';
import { createConnection } from '../../srv/connections/connectionFactory';
import { boundHandlerExporter } from '../../srv/lib/bound-handler-exporter';
import { resolveExposition } from '../../srv/lib/exposition';
import { outageFromToolResult } from '../../srv/lib/mcp-outage';
import { rawHandlerRegistry } from '../../srv/lib/raw-handler-registry';
import { isReadOnlyTool } from '../../srv/lib/tool-authorization';
import { buildToolExpositionMap } from '../../srv/lib/tool-exposition-map';
import { isWriteTool } from '../../srv/lib/write-guardrail';

it('reader receives GetClass with part and developer receives one copy', () => {
  const map = buildToolExpositionMap();
  expect(map.get('GetClass')).toBe('readonly');
  expect(resolveExposition(['MCP_Reader'])).toContain(map.get('GetClass'));
  for (const includeHighLevel of [false, true]) {
    const entries = new HandlerExporter({
      includeHighLevel,
    }).getHandlerEntries();
    const reads = entries.filter((e) => e.toolDefinition.name === 'GetClass');
    expect(reads).toHaveLength(1);
    expect(reads[0].toolDefinition.inputSchema.properties).toHaveProperty(
      'part',
    );
    expect(entries.some((e) => e.toolDefinition.name === 'SessionOpen')).toBe(
      false,
    );
  }
});

it.each([
  'UpdatePackage',
  'DeletePackage',
  'SortAndCompressTransportTask',
  'MoveTransportObjects',
  'DiscardBackgroundRun',
])('%s is a write for both guards', (name) => {
  expect(isWriteTool(name)).toBe(true);
  expect(isReadOnlyTool(name, { readOnlyHint: true })).toBe(false);
  expect(buildToolExpositionMap().get(name)).toBe('high');
});

it.each(['RuntimeRunClass', 'RuntimeRunProgram'])(
  '%s remains execution despite read-only hints',
  (name) => {
    expect(isReadOnlyTool(name, { readOnlyHint: true })).toBe(false);
  },
);

it('classifies the automatically composed background-run readers', () => {
  const map = buildToolExpositionMap();
  expect(map.get('GetBackgroundRun')).toBe('readonly');
  expect(map.get('ListBackgroundRuns')).toBe('readonly');
});

it.each(['tunnel_timeout', 'no_scc_registration'])(
  'v20 ADT failure rendering preserves [%s]',
  async (status) => {
    const connection = createConnection({
      sapConfig: { url: 'http://sap', authType: 'basic' },
      systemType: 'onprem',
    });
    connection.getBaseUrl = async () => 'http://sap';
    Object.assign(connection, { isConnected: () => true });
    connection.makeAdtRequest = async () => {
      throw new Error(`network failed [${status}]`);
    };
    const context = { connection };
    const entry = boundHandlerExporter(context, { systemType: 'onprem' })
      .getHandlerEntries()
      .find((e) => e.toolDefinition.name === 'GetClass');
    if (!entry) throw new Error('GetClass missing');
    const args = { class_name: 'ZCL_X' };
    const result = await (isArgsOnly(entry.handler)
      ? entry.handler(args)
      : entry.handler(context, args));
    expect(JSON.stringify(result)).toContain('connection');
    expect(outageFromToolResult(result, 'SAP')?.status).toBe(status);
  },
);

it('authentication_failed without an outage tag remains a credential error', () => {
  expect(
    outageFromToolResult(
      {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'authentication_failed',
              message: 'Credentials refused',
            }),
          },
        ],
      },
      'SAP',
    ),
  ).toBeUndefined();
});

it('a listed long read opens and closes a fresh session, leaving the main connection alone', async () => {
  const { EmbeddableMcpServer } = await import('@mcp-abap-adt/lib/embeddable');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import(
    '@modelcontextprotocol/sdk/inMemory.js'
  );
  const mainRequest = jest.fn();
  const connect = jest.fn(async () => {});
  const disconnect = jest.fn(async () => {});
  const connection = createConnection({
    sapConfig: { url: 'http://sap', authType: 'basic' },
    systemType: 'onprem',
  });
  connection.makeAdtRequest = mainRequest;
  const freshConnection = jest.fn(async () => {
    const fresh = createConnection({
      sapConfig: { url: 'http://sap', authType: 'basic' },
      systemType: 'onprem',
    });
    fresh.connect = connect;
    fresh.makeAdtRequest = async () => {
      throw new Error('offline [tunnel_timeout]');
    };
    return Object.assign(fresh, { disconnect, isConnected: () => true });
  });
  const server = new EmbeddableMcpServer({
    connection,
    systemType: 'onprem',
    handlersRegistry: rawHandlerRegistry(['readonly'], 'onprem'),
    freshConnection,
    exposition: ['readonly'],
    transportCloseEndsSession: false,
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'GetTableContents',
      arguments: { table_name: 'T000' },
    });
    expect(JSON.stringify(result)).not.toContain(
      'fresh_connection_unavailable',
    );
    expect(freshConnection).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(mainRequest).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.dispose();
  }
});

it.each(['client_threw', 'authentication_failed'])(
  '%s structured failure retains outage classification',
  (error) => {
    for (const status of ['tunnel_timeout', 'no_scc_registration']) {
      const result = {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error,
              message: `Request failed [${status}]`,
              raw_body: `SAP proxy [${status}]`,
            }),
          },
        ],
      };
      expect(outageFromToolResult(result, 'SAP')?.status).toBe(status);
    }
  },
);

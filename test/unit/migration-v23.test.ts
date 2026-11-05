import { EmbeddableMcpServer } from '@mcp-abap-adt/lib/embeddable';
import { HandlerExporter } from '@mcp-abap-adt/lib/handlers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '../../srv/connections/connectionFactory';
import { rawHandlerRegistry } from '../../srv/lib/raw-handler-registry';

jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async () => ({
    sapConfig: { url: 'http://sap', authType: 'basic' },
  }),
}));

import {
  buildEmbeddedMcpAdapter,
  destinationProfileToolCatalogue,
} from '../../srv/agent-manager';
import { effectiveProfileTools } from '../../srv/lib/agent-profile-tools';
import { resolveExposition } from '../../srv/lib/exposition';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import {
  assertToolAllowed,
  isReadOnlyTool,
} from '../../srv/lib/tool-authorization';
import { buildToolExpositionMap } from '../../srv/lib/tool-exposition-map';
import {
  runWithProfileTools,
  runWithReadOnlyTools,
} from '../../srv/request-session';

const writes = [
  'CreateInclude',
  'UpdateInclude',
  'UpdateIncludeMetadata',
  'DeleteInclude',
  'ActivateInclude',
];
const map = buildToolExpositionMap();

test.each(['onprem', 'cloud'] as const)(
  'raw MCP lists include tools on %s according to system availability',
  async (systemType) => {
    const connection = createConnection({
      sapConfig: { url: 'http://sap', authType: 'basic' },
      systemType,
    });
    const server = new EmbeddableMcpServer({
      connection,
      systemType,
      handlersRegistry: rawHandlerRegistry(['readonly', 'high'], systemType),
    });
    const client = new Client({ name: 'include-tools-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of [...writes, 'GetMainPrograms']) {
        expect(listed.includes(name)).toBe(systemType === 'onprem');
      }
    } finally {
      await client.close();
      await server.dispose();
    }
  },
);

test('include writes follow program tools in the executor catalogue and channel', async () => {
  const catalogue = destinationProfileToolCatalogue();
  const executor = effectiveProfileTools({
    catalogue,
    grants: new Set(catalogue.map((tool) => tool.name)),
    result: 'report',
    policy: 'all',
  });
  const client = new RecordingMcpClient(await buildEmbeddedMcpAdapter('SAP'));
  await runWithProfileTools(executor, async () => {
    const result = await client.listTools();
    if (!result.ok) throw result.error;
    const listed = result.value.map((tool) => tool.name);
    for (const name of [...writes, 'CreateProgram', 'UpdateProgram']) {
      expect(listed).toContain(name);
      expect(executor.allows(name)).toBe(true);
      expect(map.get(name)).toBe('high');
      expect(() =>
        assertToolAllowed(
          name,
          map.get(name),
          resolveExposition(['MCP_Developer']),
        ),
      ).not.toThrow();
    }
  });
});

test.each([
  { result: 'report', policy: 'read-only' },
  { result: 'verdict', policy: 'all' },
] as const)(
  '$result/$policy refuses include writes and lists GetMainPrograms',
  async ({ result, policy }) => {
    const catalogue = destinationProfileToolCatalogue();
    const permissions = effectiveProfileTools({
      catalogue,
      grants: new Set(catalogue.map((tool) => tool.name)),
      result,
      policy,
    });
    const client = new RecordingMcpClient(await buildEmbeddedMcpAdapter('SAP'));
    await runWithProfileTools(permissions, async () => {
      const listed = await client.listTools();
      if (!listed.ok) throw listed.error;
      expect(listed.value.map((tool) => tool.name)).toContain(
        'GetMainPrograms',
      );
      for (const name of writes) {
        expect(permissions.allows(name)).toBe(false);
        expect(listed.value.map((tool) => tool.name)).not.toContain(name);
        expect(await client.callTool(name, {})).toMatchObject({
          ok: true,
          value: { isError: true },
        });
      }
    });
  },
);

test.each(writes)(
  '%s cannot bypass reader or checker guards with read-only hints',
  (name) => {
    expect(isReadOnlyTool(name, { readOnlyHint: true })).toBe(false);
    expect(() =>
      assertToolAllowed(name, 'readonly', resolveExposition(['MCP_Reader']), {
        readOnlyHint: true,
      }),
    ).toThrow();
    runWithReadOnlyTools(() => {
      expect(() =>
        assertToolAllowed(name, 'high', resolveExposition(['MCP_Developer']), {
          readOnlyHint: true,
        }),
      ).toThrow('read-only');
    });
  },
);

test('include tools are on-premise only and CreateProgram no longer offers include', () => {
  const entries = new HandlerExporter().getHandlerEntries();
  for (const name of [...writes, 'GetMainPrograms']) {
    const entry = entries.find((tool) => tool.toolDefinition.name === name);
    expect(entry?.toolDefinition.available_in).toEqual(['onprem']);
  }
  const program = entries.find(
    (tool) => tool.toolDefinition.name === 'CreateProgram',
  );
  expect(
    program?.toolDefinition.inputSchema.properties.program_type.enum,
  ).not.toContain('include');
  expect(map.get('GetMainPrograms')).toBe('readonly');
  expect(() =>
    assertToolAllowed(
      'GetMainPrograms',
      'readonly',
      resolveExposition(['MCP_Reader']),
    ),
  ).not.toThrow();
});

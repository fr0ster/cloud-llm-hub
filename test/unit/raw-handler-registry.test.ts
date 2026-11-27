import { EmbeddableMcpServer } from '@mcp-abap-adt/lib/embeddable';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '../../srv/connections/connectionFactory';
import { resolveExposition } from '../../srv/lib/exposition';
import { rawHandlerRegistry } from '../../srv/lib/raw-handler-registry';
import { assertToolAllowed } from '../../srv/lib/tool-authorization';
import { buildRawToolExpositionMap } from '../../srv/lib/tool-exposition-map';

it.each(['cloud', 'onprem'] as const)(
  'registers abapGit and builds role-appropriate prompts on %s',
  async (systemType) => {
    const connection = createConnection({
      destinationName: 'TEST',
      sapConfig: { url: 'http://sap.invalid', authType: 'basic' },
    });
    const wire = jest.spyOn(connection, 'makeAdtRequest');
    const reader = resolveExposition(['MCP_Reader']);
    const lookup = buildRawToolExpositionMap();

    for (const role of ['MCP_Reader', 'MCP_Developer']) {
      const exposition = resolveExposition([role]);
      const server = new EmbeddableMcpServer({
        connection,
        systemType,
        handlersRegistry: rawHandlerRegistry(exposition),
        transportCloseEndsSession: false,
      });
      const client = new Client({ name: 'raw-registry-test', version: '1' });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const { tools } = await client.listTools();
        const git = tools
          .map(({ name }) => name)
          .filter((name) => name.includes('AbapGit'));
        const expected = [
          'ListAbapGitRepos',
          'CheckAbapGitExternalRepo',
          'GetAbapGitStaging',
          'CheckAbapGitRepo',
          'GetAbapGitFile',
          ...(systemType === 'cloud'
            ? ['GetAbapGitModifiedObjects', 'GetAbapGitErrorLog']
            : []),
        ];
        if (role === 'MCP_Developer') {
          const writes = [
            'LinkAbapGitRepo',
            'UnlinkAbapGitRepo',
            'PullAbapGitRepo',
            'PushAbapGitRepo',
            systemType === 'cloud'
              ? 'GetAbapGitBranchInfo'
              : 'SwitchAbapGitBranch',
          ];
          for (const name of writes) {
            expect(() =>
              assertToolAllowed(name, lookup.get(name), reader),
            ).toThrow();
          }
          expected.push(...writes);
        }
        expect(git.sort()).toEqual(expected.sort());
        for (const name of git) {
          expect(() =>
            assertToolAllowed(name, lookup.get(name), exposition),
          ).not.toThrow();
        }
        const { prompts } = await client.listPrompts();
        const names = prompts.map(({ name }) => name);
        expect(names).toContain('get');
        expect(names.includes('create')).toBe(role === 'MCP_Developer');
        const prompt = await client.getPrompt({
          name: 'get',
          arguments: { object_type: 'class', name: 'ZCL_TEST' },
        });
        expect(JSON.stringify(prompt)).toContain('GetClass');
      } finally {
        await client.close();
        await server.dispose();
      }
    }
    expect(wire).not.toHaveBeenCalled();
  },
);

it.each(['cloud', 'onprem'] as const)(
  'a raw batched read reaches ADT with the %s system type on its fresh connection',
  async (systemType) => {
    // Destination connections rely on the host to state their system type.
    const makeConnection = () =>
      createConnection({
        destinationName: 'TEST',
        sapConfig: { url: 'http://sap.invalid', authType: 'basic' },
      });
    const connection = makeConnection();
    const fresh = makeConnection();
    jest.spyOn(fresh, 'connect').mockResolvedValue(undefined);
    jest.spyOn(fresh, 'disconnect').mockResolvedValue(undefined);
    const request = jest
      .spyOn(fresh, 'makeAdtRequest')
      .mockImplementation(async ({ url }) => {
        if (url.endsWith('/systeminformation')) {
          return {
            data: { systemID: 'TEST', client: '100', userName: 'DEVELOPER' },
            status: 200,
            statusText: 'OK',
            headers: {},
          };
        }
        throw new Error(`ADT request reached ${url}`);
      });
    const server = new EmbeddableMcpServer({
      connection,
      systemType,
      handlersRegistry: rawHandlerRegistry(['readonly', 'system']),
      systemContextResolver: async () => null,
      freshConnection: async () => fresh,
      transportCloseEndsSession: false,
    });
    const client = new Client({ name: 'batch-read-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listing = await client.listTools();
      expect(listing.tools.map(({ name }) => name)).toContain(
        'GetPackageContents',
      );
      const result = await client.callTool({
        name: 'GetPackageContents',
        arguments: { package_names: ['ZTEST', 'ZSECOND'] },
      });
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/communication/batch'),
        }),
      );
      expect(JSON.stringify(result)).not.toContain('system_type_required');
    } finally {
      await client.close();
      await server.dispose();
    }
  },
);

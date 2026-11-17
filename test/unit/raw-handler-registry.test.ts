import { EmbeddableMcpServer } from '@mcp-abap-adt/lib/embeddable';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConnection } from '../../srv/connections/connectionFactory';
import { rawHandlerRegistry } from '../../srv/lib/raw-handler-registry';

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
      .mockRejectedValue(new Error('ADT batch reached'));
    const server = new EmbeddableMcpServer({
      connection,
      systemType,
      handlersRegistry: rawHandlerRegistry(['readonly', 'system']),
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
      expect(listing.tools.map(({ name }) => name)).toContain('ListTransports');
      const result = await client.callTool({
        name: 'ListTransports',
        arguments: {},
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

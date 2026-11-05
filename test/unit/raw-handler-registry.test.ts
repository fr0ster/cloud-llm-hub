import {
  type HandlerContext,
  type HandlerEntry,
  HandlerExporter,
  HighLevelHandlersGroup,
  isArgsOnly,
  noConnectionContext,
} from '@mcp-abap-adt/lib/handlers';
import { createConnection } from '../../srv/connections/connectionFactory';
import { boundHandlerExporter } from '../../srv/lib/bound-handler-exporter';
import { rawHandlerRegistry } from '../../srv/lib/raw-handler-registry';

jest.mock('../../srv/lib/bound-handler-exporter');

const boundExporter = jest.mocked(boundHandlerExporter);
const libraryEntries = new HandlerExporter().getHandlerEntries();
const longReads = libraryEntries.filter(({ toolDefinition }) => {
  const schema: Record<string, object> = toolDefinition.inputSchema;
  return (
    Object.hasOwn(schema, 'timeout') ||
    (schema.properties !== null &&
      typeof schema.properties === 'object' &&
      Object.hasOwn(schema.properties, 'timeout'))
  );
});

async function invoke(entry: HandlerEntry, context: HandlerContext) {
  const args = { timeout: 30 };
  return isArgsOnly(entry.handler)
    ? entry.handler(args)
    : entry.handler(context, args);
}

describe('rawHandlerRegistry long-read system type', () => {
  const savedSystemType = process.env.SAP_SYSTEM_TYPE;
  beforeEach(() => {
    delete process.env.SAP_SYSTEM_TYPE;
    boundExporter.mockReset();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (savedSystemType === undefined) delete process.env.SAP_SYSTEM_TYPE;
    else process.env.SAP_SYSTEM_TYPE = savedSystemType;
  });

  function captureBoundHandler() {
    const reached = jest.fn(async () => 'bound handler reached');
    boundExporter.mockImplementation(() => {
      const exporter = new HandlerExporter();
      jest
        .spyOn(exporter, 'getHandlerEntries')
        .mockReturnValue(
          libraryEntries.map((entry) => ({ ...entry, handler: reached })),
        );
      return exporter;
    });
    return reached;
  }

  it('enumerates the library long reads, including the reported regressions', () => {
    expect(longReads.map((entry) => entry.toolDefinition.name)).toEqual(
      expect.arrayContaining([
        'GetIncludesList',
        'SearchObject',
        'GetPackageTree',
        'ListATCResults',
        'GetATCResult',
      ]),
    );
  });

  describe.each(['cloud', 'onprem'] as const)('%s', (systemType) => {
    it.each(longReads.map((entry) => [entry.toolDefinition.name]))(
      'routes %s through the bound exporter with the call context and system type',
      async (name) => {
        const reached = captureBoundHandler();
        const registry = rawHandlerRegistry(
          ['readonly', 'high', 'search', 'system'],
          systemType,
        );
        const entries = registry
          .getHandlerGroups()
          .flatMap((g) => g.getHandlers());
        const matching = entries.filter((e) => e.toolDefinition.name === name);
        expect(matching.length).toBeGreaterThan(0);
        for (const entry of matching) {
          // Foreground and background destination calls use the same factory.
          // Build each independently so the bound path must retain its connection.
          for (const kind of ['destination', 'background', 'direct'] as const) {
            const sapConfig = {
              url: 'https://sap.example.invalid',
              authType: 'basic' as const,
            };
            const context: HandlerContext = {
              connection:
                kind === 'direct'
                  ? createConnection({ sapConfig, systemType })
                  : createConnection({
                      sapConfig,
                      destinationName: `${kind}-sap`,
                    }),
            };
            await expect(invoke(entry, context)).resolves.toBe(
              'bound handler reached',
            );
            expect(boundExporter).toHaveBeenLastCalledWith(context, {
              systemType,
            });
            expect(boundExporter.mock.calls.at(-1)?.[0]).toBe(context);
          }
        }
        expect(reached).toHaveBeenCalledTimes(matching.length * 3);
      },
    );
  });

  it.each([{ timeout: {} }, { type: 'object', properties: { timeout: {} } }])(
    'recognizes timeout in schema %j',
    async (inputSchema) => {
      captureBoundHandler();
      jest
        .spyOn(HighLevelHandlersGroup.prototype, 'getHandlers')
        .mockReturnValue([
          {
            toolDefinition: {
              name: 'GetIncludesList',
              description: '',
              inputSchema,
            },
            handler: async () => {
              throw new Error('Unbound handler must not run');
            },
          },
        ]);
      const entry = rawHandlerRegistry(['high'], 'cloud')
        .getHandlerGroups()[0]
        .getHandlers()[0];
      await expect(invoke(entry, noConnectionContext())).resolves.toBe(
        'bound handler reached',
      );
      expect(boundExporter).toHaveBeenCalledWith(expect.anything(), {
        systemType: 'cloud',
      });
    },
  );
});

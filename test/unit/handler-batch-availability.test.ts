import { type HandlerContext, isArgsOnly } from '@mcp-abap-adt/lib/handlers';
import {
  buildEmbeddedMcpAdapter,
  runWithRequestConnection,
  setRequestConnection,
} from '../../srv/agent-manager';
import { createConnection } from '../../srv/connections/connectionFactory';
import * as boundHandlers from '../../srv/lib/bound-handler-exporter';

jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async () => ({
    sapConfig: { url: 'http://sap', authType: 'basic' },
  }),
}));

test.each(['run', 'set'] as const)(
  '%s request context disables batch and ListTransports reaches ADT',
  async (binding) => {
    const connection = createConnection({
      sapConfig: { url: 'http://sap', authType: 'basic' },
      systemType: 'onprem',
    });
    const request = jest
      .spyOn(connection, 'makeAdtRequest')
      .mockRejectedValue(new Error('fake ADT reached'));
    const bind = jest.spyOn(boundHandlers, 'boundHandlerExporter');
    try {
      const adapter = await buildEmbeddedMcpAdapter('SAP');
      const invoke = () => adapter.callTool('ListTransports', {});
      if (binding === 'run')
        await runWithRequestConnection(connection, invoke, undefined, [
          'readonly',
          'system',
        ]);
      else {
        setRequestConnection(connection, undefined, ['readonly', 'system']);
        await invoke();
      }
      const context: HandlerContext | undefined = bind.mock.calls.at(-1)?.[0];
      expect(context?.batchAvailability?.available()).toBe(false);
      expect(context?.batchAvailability?.noteOuterStatus(200)).toBeUndefined();
      expect(context?.batchAvailability?.available()).toBe(false);
      expect(request).toHaveBeenCalled();
      if (!context) throw new Error('Missing handler context');
      const exporter = boundHandlers.boundHandlerExporter(context, {
        systemType: 'onprem',
      });
      const entry = exporter
        .getHandlerEntries()
        .find(({ toolDefinition }) => toolDefinition.name === 'ListTransports');
      if (!entry) throw new Error('Missing ListTransports');
      const result = await (isArgsOnly(entry.handler)
        ? entry.handler({})
        : entry.handler(context, {}));
      expect(JSON.stringify(result)).not.toContain('system_type_required');
    } finally {
      jest.restoreAllMocks();
    }
  },
);

import cds, { Request, Service } from '@sap/cds';

interface ProxyInvocation {
  toolId: string;
  mode?: 'sse' | 'stream-http';
  payload?: string;
}

const DEFAULT_MODE: 'sse' | 'stream-http' = 'stream-http';

/**
 * CAP service handler for McpProxyService.
 * CAP enforces the `@requires: 'proxyAccess'` annotation defined in the CDS model.
 */
export default async function registerMcpProxyHandlers(srv: Service): Promise<void> {
  const log = cds.log('mcp-proxy');

  srv.on('Health', async () => {
    const now = new Date().toISOString();
    log.debug('Health check responded', { now });

    return {
      status: 'UP',
      timestamp: now,
    };
  });

  srv.on('InvokeTool', async (req: Request<ProxyInvocation>) => {
    const { toolId, mode = DEFAULT_MODE } = req.data;

    log.info('Proxy request received', { toolId, mode });

    // TODO: Inject concrete MCP backend adapter once available.
    return {
      status: 'PENDING_IMPLEMENTATION',
      mode,
      message: 'MCP proxy integration is not yet implemented.',
      receivedAt: new Date().toISOString(),
    };
  });
}

/**
 * Agent Manager - SmartAgent lifecycle management
 *
 * Builds and manages SmartAgent instances using SmartAgentBuilder.
 * Configuration comes from environment variables (set via mta.yaml or CF CLI).
 *
 * Architecture:
 * - SmartAgentBuilder wires together: LLM (sap-ai-sdk pipeline), MCP (McpClientAdapter), RAG (in-memory)
 * - LLM: Uses @sap-ai-sdk/orchestration via pipeline provider 'sap-ai-sdk'
 * - MCP: MCPClientWrapper → McpClientAdapter → connects to /mcp/stream/http (self-loop)
 * - RAG: InMemoryRag (no external embedding service needed)
 *
 * Configuration:
 * - LLM settings (model, temperature, maxTokens) from env vars
 * - SAP AI Core credentials from AICORE_SERVICE_KEY or VCAP_SERVICES (read by SDK)
 * - MCP destination from env vars
 */

import type { MCPClientConfig } from '@mcp-abap-adt/llm-agent';
import { MCPClientWrapper } from '@mcp-abap-adt/llm-agent';
// Deep imports for SmartAgent subsystem (not re-exported from main entry)
import { McpClientAdapter } from '@mcp-abap-adt/llm-agent/dist/smart-agent/adapters/mcp-client-adapter';
import type { SmartAgentHandle } from '@mcp-abap-adt/llm-agent/dist/smart-agent/builder';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent/dist/smart-agent/builder';
import { makeLlmFromProvider } from '@mcp-abap-adt/llm-agent/dist/smart-agent/pipeline';
import cds, { type Request } from '@sap/cds';
import { type AgentConfig, getAgentConfig } from './agent-config';

/** Cached SmartAgent handle (singleton per configuration) */
let agentHandle: SmartAgentHandle | null = null;
let agentConfig: AgentConfig | null = null;

/**
 * Build MCP client configuration from agent configuration.
 * MCP client connects to MCP proxy, which resolves destination and creates MCP server.
 */
function buildMCPConfig(config: AgentConfig, req: Request): MCPClientConfig {
  const log = cds.log('agent-manager');

  // MCP endpoint - use config or construct from request
  let mcpEndpoint = config.mcp.endpoint;
  if (!mcpEndpoint) {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host =
      req.headers.host || req.headers['x-forwarded-host'] || 'localhost:4004';
    mcpEndpoint = `${protocol}://${host}/mcp/stream/http`;
  }

  // Extract authentication from request (for MCP proxy authentication)
  const authHeader = (req.headers.authorization as string) || 'Basic YWxpY2U6';

  const headers: Record<string, string> = {
    Authorization: authHeader,
    'X-SAP-Destination': config.mcp.destination,
  };

  log.debug('Building MCP config', {
    mcpEndpoint,
    mcpDestination: config.mcp.destination,
  });

  return {
    url: mcpEndpoint,
    headers,
  };
}

/**
 * Get or create SmartAgent handle.
 *
 * Lazy-initializes a singleton SmartAgent built via SmartAgentBuilder:
 * - LLM: sap-ai-sdk pipeline provider (wraps @sap-ai-sdk/orchestration)
 * - MCP: MCPClientWrapper → McpClientAdapter (connects to /mcp/stream/http)
 * - RAG: in-memory (no external embedding service)
 */
export async function getSmartAgent(req: Request): Promise<SmartAgentHandle> {
  const log = cds.log('agent-manager');
  const config = getAgentConfig();

  // Return cached handle if config hasn't changed
  if (agentHandle && agentConfig === config) {
    log.debug('Using cached SmartAgent handle');
    return agentHandle;
  }

  // Close existing agent if config changed
  if (agentHandle) {
    log.info('Config changed, closing existing SmartAgent');
    await agentHandle.close().catch((err) => {
      log.warn('Failed to close previous SmartAgent', { error: String(err) });
    });
    agentHandle = null;
  }

  log.info('Building SmartAgent', {
    model: config.llm.model,
    mode: config.agent.mode,
    maxIterations: config.agent.maxIterations,
    ragType: config.agent.ragType,
    mcpDestination: config.mcp.destination,
  });

  // Create main LLM via pipeline factory (uses @sap-ai-sdk/orchestration)
  const mainLlm = makeLlmFromProvider(
    {
      provider: 'sap-ai-sdk',
      apiKey: 'sap-ai-sdk-managed',
      model: config.llm.model,
      temperature: config.llm.temperature,
      resourceGroup: config.llm.resourceGroup,
    },
    config.llm.temperature,
  );

  // Create classifier LLM (same provider, lower temperature)
  const classifierLlm = makeLlmFromProvider(
    {
      provider: 'sap-ai-sdk',
      apiKey: 'sap-ai-sdk-managed',
      model: config.llm.model,
      resourceGroup: config.llm.resourceGroup,
    },
    0.1,
  );

  // Create MCP client and wrap in adapter
  const mcpConfig = buildMCPConfig(config, req);
  const mcpClient = new MCPClientWrapper(mcpConfig);
  const mcpAdapter = new McpClientAdapter(mcpClient);

  // Build SmartAgent
  const builder = new SmartAgentBuilder({
    llm: { apiKey: 'sap-ai-sdk-managed', model: config.llm.model },
    rag: { type: config.agent.ragType },
    agent: {
      maxIterations: config.agent.maxIterations,
      mode: config.agent.mode,
    },
  })
    .withMainLlm(mainLlm)
    .withClassifierLlm(classifierLlm)
    .withMcpClients([mcpAdapter]);

  const handle = await builder.build();
  agentHandle = handle;
  agentConfig = config;

  // Run health check in background
  handle.agent
    .healthCheck()
    .then((res) => {
      if (res.ok) {
        const v = res.value;
        const mcpStatus =
          v.mcp.length === 0
            ? 'NONE'
            : v.mcp.every((m) => m.ok)
              ? 'OK'
              : 'PARTIAL/FAIL';
        log.info('SmartAgent health check', {
          llm: v.llm ? 'OK' : 'FAIL',
          rag: v.rag ? 'OK' : 'FAIL',
          mcp: mcpStatus,
        });
      } else {
        log.warn('SmartAgent health check failed', {
          error: res.error.message,
        });
      }
    })
    .catch((e) => {
      log.warn('SmartAgent health check error', { error: String(e) });
    });

  log.info('SmartAgent built and ready');
  return handle;
}

/**
 * Gracefully close the SmartAgent (call on shutdown)
 */
export async function closeSmartAgent(): Promise<void> {
  if (agentHandle) {
    const log = cds.log('agent-manager');
    log.info('Closing SmartAgent');
    await agentHandle.close();
    agentHandle = null;
    agentConfig = null;
  }
}

/**
 * Agent Service - CAP service for LLM Agent
 *
 * Provides OData endpoints to interact with the LLM agent.
 *
 * Architecture:
 * - Configuration comes from environment variables (set via mta.yaml or CF CLI)
 * - This service uses agent-manager.ts which loads configuration and creates agent instances
 * - Agent itself doesn't know about SAP destinations - it only works with MCP client
 * - MCP client connects to MCP proxy, which resolves destination and creates MCP server
 * - All authentication is handled through destinations (configured in BTP Cockpit)
 */

import cds, { type Request, type Service } from '@sap/cds';
import type { AgentConfig } from './agent-config';
import { getAgent } from './agent-manager';

/**
 * Register CAP service handlers
 */
export default async function registerAgentServiceHandlers(
  srv: Service,
): Promise<void> {
  const log = cds.log('agent-service');
  log.info('Registering AgentService handlers');

  /**
   * Chat endpoint - send message to agent
   *
   * Agent manager loads configuration from environment variables and creates agent instance.
   * Agent doesn't know about SAP - it just works with MCP client.
   */
  srv.on('Chat', async (req: Request) => {
    const message = req.data.message as string;

    if (!message || typeof message !== 'string') {
      const error = new Error(
        'Message parameter is required and must be a string',
      );
      (error as Error & { statusCode?: number }).statusCode = 400;
      throw error;
    }

    const user = req.user as { id?: string } | undefined;
    log.info('Chat request received', {
      messageLength: message.length,
      user: user?.id,
    });

    try {
      // Get agent instance - agent-manager handles all MCP configuration
      const agent = await getAgent(req);
      const response = await agent.process(message);

      if (response.error) {
        log.error('Agent processing error', { error: response.error });
        throw new Error(response.error);
      }

      return response.message;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Chat handler error', { error: err.message });
      throw error;
    }
  });

  /**
   * Get conversation history
   * Note: History is per-agent-instance (cached by destination/config)
   */
  srv.on('GetHistory', async (req: Request) => {
    try {
      const agent = await getAgent(req);
      const history = agent.getHistory();
      return history.map((msg: { role?: string; content?: string }) => ({
        role: msg.role,
        content: msg.content,
        timestamp: new Date(),
      }));
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.warn('Failed to get history', { error: err.message });
      return [];
    }
  });

  /**
   * Clear conversation history
   * Clears history for the agent instance matching the request configuration
   */
  srv.on('ClearHistory', async (req: Request) => {
    try {
      const agent = await getAgent(req);
      agent.clearHistory();
      log.info('Conversation history cleared');

      return {
        success: true,
        message: 'Conversation history cleared successfully',
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Failed to clear history', { error: err.message });
      return {
        success: false,
        message: err.message || 'Failed to clear history',
      };
    }
  });

  /**
   * Health check
   * Uses configuration from environment variables (set via mta.yaml)
   */
  srv.on('Health', async (req: Request) => {
    const { getAgentConfig } = await import('./agent-config');

    let agentReady = false;
    let mcpConnected = false;
    let config: AgentConfig | null = null;

    try {
      // Load configuration to show in health check
      config = getAgentConfig();

      const agent = await getAgent(req);
      agentReady = !!agent;

      // Try to list tools to check connection
      try {
        const agentWithClient = agent as unknown as {
          mcpClient?: { listTools?: () => Promise<unknown> };
        };
        await agentWithClient.mcpClient?.listTools?.();
        mcpConnected = true;
      } catch (_err) {
        // Connection not ready
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn('Health check failed', { error: error.message });
    }

    return {
      status: agentReady && mcpConnected ? 'READY' : 'NOT_READY',
      agentReady,
      mcpConnected,
      llmProvider: 'SAP Core AI',
      llmDestination: config?.llm?.aiCoreService?.name || 'NOT_CONFIGURED',
      model: config?.llm?.model || 'NOT_CONFIGURED',
      mcpDestination: config?.mcp?.destination || 'NOT_CONFIGURED',
      timestamp: new Date().toISOString(),
    };
  });

  log.info('AgentService handlers registered');
}

// CommonJS compatibility for CAP
module.exports = registerAgentServiceHandlers;

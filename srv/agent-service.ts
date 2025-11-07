/**
 * Agent Service - CAP service for LLM Agent
 * 
 * Provides OData endpoints to interact with the LLM agent.
 * 
 * Architecture:
 * - This service uses agent-manager.ts which handles all MCP configuration
 * - Agent itself doesn't know about SAP destinations - it only works with MCP client
 * - cloud-llm-hub (this layer) determines which MCP to use and how to configure it
 */

import cds, { type Service, type Request } from '@sap/cds';
import { getAgent } from './agent-manager';
import type { BaseAgent } from '@cloud-llm-hub/llm-agent';

/**
 * Register CAP service handlers
 */
export default async function registerAgentServiceHandlers(srv: Service): Promise<void> {
  const log = cds.log('agent-service');
  log.info('Registering AgentService handlers');

  /**
   * Chat endpoint - send message to agent
   * 
   * Agent manager handles MCP configuration from request headers.
   * Agent doesn't know about SAP - it just works with MCP client.
   */
  srv.on('Chat', async (req: Request) => {
    const message = req.data.message as string;
    
    if (!message || typeof message !== 'string') {
      const error = new Error('Message parameter is required and must be a string');
      (error as any).statusCode = 400;
      throw error;
    }

    log.info('Chat request received', { 
      messageLength: message.length,
      user: (req.user as any)?.id,
      destination: req.headers['x-sap-destination'],
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
    } catch (error: any) {
      log.error('Chat handler error', { error: error.message });
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
      return history.map((msg: any) => ({
        role: msg.role,
        content: msg.content,
        timestamp: new Date(),
      }));
    } catch (error: any) {
      log.warn('Failed to get history', { error: error.message });
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
    } catch (error: any) {
      log.error('Failed to clear history', { error: error.message });
      return {
        success: false,
        message: error.message || 'Failed to clear history',
      };
    }
  });

  /**
   * Health check
   */
  srv.on('Health', async (req: Request) => {
    const mcpEndpoint = process.env.MCP_ENDPOINT || 'http://localhost:4004/mcp/stream/http';
    
    // Determine SAP Core AI destination and model
    const destination = (req.headers['x-sap-core-ai-destination'] as string) || process.env.SAP_CORE_AI_DESTINATION || 'NOT_CONFIGURED';
    const model = (req.headers['x-sap-core-ai-model'] as string) || process.env.SAP_CORE_AI_MODEL || 'NOT_CONFIGURED';
    
    let agentReady = false;
    let mcpConnected = false;
    
    try {
      const agent = await getAgent(req);
      agentReady = !!agent;
      
      // Try to list tools to check connection
      try {
        await (agent as any).mcpClient.listTools();
        mcpConnected = true;
      } catch (err) {
        // Connection not ready
      }
    } catch (err: any) {
      log.warn('Health check failed', { error: err.message });
    }

    return {
      status: agentReady && mcpConnected ? 'READY' : 'NOT_READY',
      agentReady,
      mcpConnected,
      llmProvider: 'SAP Core AI',
      destination,
      model,
      timestamp: new Date().toISOString(),
    };
  });

  log.info('AgentService handlers registered');
}

// CommonJS compatibility for CAP
module.exports = registerAgentServiceHandlers;


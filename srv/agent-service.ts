/**
 * Agent Service - CAP service for LLM Agent
 *
 * Provides OData endpoints to interact with SmartAgent.
 *
 * Architecture:
 * - SmartAgent orchestrates LLM + MCP + RAG pipeline
 * - LLM access via SAP AI Core (@sap-ai-sdk/orchestration)
 * - MCP tools via self-loop to /mcp/stream/http
 */

import cds, { type Request, type Service } from '@sap/cds';
import { type AgentConfig, getAgentConfig } from './agent-config';
import { getSmartAgent } from './agent-manager';

/**
 * Register CAP service handlers
 */
export default async function registerAgentServiceHandlers(
  srv: Service,
): Promise<void> {
  const log = cds.log('agent-service');
  log.info('Registering AgentService handlers');

  /**
   * Chat endpoint - send message to SmartAgent
   *
   * SmartAgent orchestrates: intent classification → RAG lookup → LLM + MCP tool loop → response
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
      const handle = await getSmartAgent();
      const result = await handle.agent.process(message);

      if (result.ok) {
        log.debug('SmartAgent response', {
          iterations: result.value.iterations,
          toolCalls: result.value.toolCallCount,
          stopReason: result.value.stopReason,
        });
        return result.value.content || '';
      }

      log.error('SmartAgent processing failed', {
        error: result.error.message,
        code: result.error.code,
      });
      throw new Error(result.error.message);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Chat handler error', { error: err.message });
      throw error;
    }
  });

  /**
   * Get conversation history
   */
  srv.on('GetHistory', async (_req: Request) => {
    return [];
  });

  /**
   * Clear conversation history
   */
  srv.on('ClearHistory', async (_req: Request) => {
    log.info('ClearHistory called');
    return {
      success: true,
      message: 'Conversation history cleared successfully',
    };
  });

  /**
   * Health check - verifies SmartAgent subsystems (LLM, RAG, MCP)
   */
  srv.on('Health', async (req: Request) => {
    let config: AgentConfig | null = null;
    try {
      config = getAgentConfig();
    } catch {
      return {
        status: 'NOT_READY',
        agentReady: false,
        mcpConnected: false,
        llmProvider: 'SAP Core AI',
        llmDestination: 'NOT_CONFIGURED',
        model: 'NOT_CONFIGURED',
        mcpDestination: 'NOT_CONFIGURED',
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const handle = await getSmartAgent();
      const healthResult = await handle.agent.healthCheck();

      if (healthResult.ok) {
        const v = healthResult.value;
        const mcpConnected = v.mcp.length > 0 && v.mcp.every((m) => m.ok);

        return {
          status: v.llm ? 'READY' : 'NOT_READY',
          agentReady: v.llm,
          mcpConnected,
          llmProvider: 'SAP Core AI',
          llmDestination: 'sap-ai-sdk',
          model: config.llm.model,
          mcpDestination: config.mcp.destination,
          timestamp: new Date().toISOString(),
        };
      }

      log.warn('Health check returned error result', {
        error: healthResult.error.message,
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn('Health check failed', { error: error.message });
    }

    return {
      status: 'NOT_READY',
      agentReady: false,
      mcpConnected: false,
      llmProvider: 'SAP Core AI',
      llmDestination: 'sap-ai-sdk',
      model: config.llm.model,
      mcpDestination: config.mcp.destination,
      timestamp: new Date().toISOString(),
    };
  });

  log.info('AgentService handlers registered');
}

// CommonJS compatibility for CAP
module.exports = registerAgentServiceHandlers;

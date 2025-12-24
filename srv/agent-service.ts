/**
 * Agent Service - CAP service for LLM Agent
 *
 * Provides OData endpoints to interact with the LLM agent.
 *
 * Architecture:
 * - Configuration comes from environment variables (set via mta.yaml or CF CLI)
 * - Simple LLM chat: receives message → sends to SAP AI Core → returns response
 * - All authentication is handled through SAP AI Core service binding
 */

import cds, { type Request, type Service } from '@sap/cds';
import { SapCoreAIProvider, type Message } from '@mcp-abap-adt/llm-proxy';
import { getAgentConfig, type AgentConfig } from './agent-config';
import { createLLMProvider } from './agent-manager';

/**
 * Register CAP service handlers
 */
export default async function registerAgentServiceHandlers(
  srv: Service,
): Promise<void> {
  const log = cds.log('agent-service');
  log.info('Registering AgentService handlers');

  /**
   * Chat endpoint - send message to LLM via SAP AI Core
   *
   * Simple implementation: receives message → sends to SAP AI Core → returns response
   * No MCP, no Agent orchestration - just direct LLM communication
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
      // Load configuration from environment variables
      const config = getAgentConfig();

      // Create LLM provider (SAP AI Core)
      const llmProvider = await createLLMProvider(config);

      log.debug('Sending message to SAP AI Core', {
        model: config.llm.model,
        messageLength: message.length,
      });

      // Format message for LLM provider (expects Message[] format)
      const messages: Message[] = [
        {
          role: 'user',
          content: message,
        },
      ];

      // Call LLM provider directly (no Agent, no MCP)
      const response = await llmProvider.chat(messages);

      log.debug('Received response from SAP AI Core', {
        responseLength: response.content?.length || 0,
      });

      // Return the response content
      return response.content || '';
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Chat handler error', { error: err.message });
      throw error;
    }
  });

  /**
   * Get conversation history
   * Note: Simple implementation - no history stored (stateless)
   * TODO: Add history storage if needed
   */
  srv.on('GetHistory', async (_req: Request) => {
    // Simple implementation - no history for now
    return [];
  });

  /**
   * Clear conversation history
   * Note: Simple implementation - no history stored (stateless)
   */
  srv.on('ClearHistory', async (_req: Request) => {
    log.info('ClearHistory called (no history stored in simple mode)');
    return {
      success: true,
      message: 'Conversation history cleared successfully',
    };
  });

  /**
   * Health check
   * Simple implementation - checks if SAP AI Core configuration is available
   */
  srv.on('Health', async (_req: Request) => {
    let llmReady = false;
    let config: AgentConfig | null = null;

    try {
      // Load configuration to show in health check
      config = getAgentConfig();

      // Try to create provider to verify configuration
      try {
        await createLLMProvider(config);
        llmReady = true;
      } catch (err) {
        log.warn('Failed to create LLM provider', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn('Health check failed', { error: error.message });
    }

    return {
      status: llmReady ? 'READY' : 'NOT_READY',
      llmReady,
      llmProvider: 'SAP Core AI',
      llmDestination: config?.llm?.aiCoreService?.name || 'NOT_CONFIGURED',
      model: config?.llm?.model || 'NOT_CONFIGURED',
      timestamp: new Date().toISOString(),
    };
  });

  log.info('AgentService handlers registered');
}

// CommonJS compatibility for CAP
module.exports = registerAgentServiceHandlers;

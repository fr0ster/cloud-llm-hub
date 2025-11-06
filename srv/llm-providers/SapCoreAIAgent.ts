/**
 * SAP Core AI Agent - Agent implementation for SAP Core AI
 * 
 * Uses PromptBasedAgent as base since SAP Core AI API format may vary.
 * Can be customized based on actual SAP Core AI API capabilities.
 */

import { PromptBasedAgent, type PromptBasedAgentConfig } from '@cloud-llm-hub/llm-agent';
import { SapCoreAIProvider } from './SapCoreAIProvider';

export interface SapCoreAIAgentConfig extends Omit<PromptBasedAgentConfig, 'llmProvider'> {
  llmProvider: SapCoreAIProvider;
}

export class SapCoreAIAgent extends PromptBasedAgent {
  constructor(config: SapCoreAIAgentConfig) {
    super(config);
  }

  // Can override methods here if SAP Core AI has specific requirements
  // For now, uses prompt-based approach from base class
}


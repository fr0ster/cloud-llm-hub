/**
 * SAP Core AI LLM Provider
 * 
 * Implementation of LLMProvider interface for SAP Core AI service.
 * This provider uses SAP Cloud SDK for authentication and destination handling.
 * 
 * Similar to CloudSdkAbapConnection, this leverages SAP Cloud SDK's
 * automatic destination handling and authentication.
 */

import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { BaseLLMProvider } from '@cloud-llm-hub/llm-agent';
import type { Message, LLMResponse, LLMProviderConfig } from '@cloud-llm-hub/llm-agent';
import cds from '@sap/cds';

export interface SapCoreAIConfig extends LLMProviderConfig {
  /**
   * SAP Destination name for Core AI service
   */
  destinationName: string;
  
  /**
   * Model name (optional, defaults to service default)
   */
  model?: string;
  
  /**
   * Temperature (optional)
   */
  temperature?: number;
  
  /**
   * Max tokens (optional)
   */
  maxTokens?: number;
}

/**
 * SAP Core AI Provider implementation
 * 
 * Uses SAP Cloud SDK executeHttpRequest for authentication and destination handling.
 * Similar architecture to CloudSdkAbapConnection.
 */
export class SapCoreAIProvider extends BaseLLMProvider {
  private destinationName: string;
  private model: string;
  private log = cds.log('sap-core-ai-provider');

  constructor(config: SapCoreAIConfig) {
    super(config);
    
    if (!config.destinationName) {
      throw new Error('SAP destination name is required for SapCoreAIProvider');
    }
    
    this.destinationName = config.destinationName;
    this.model = config.model || 'gpt-4o-mini'; // Default model, can be overridden
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    try {
      this.log.debug('Sending chat request to SAP Core AI', {
        destination: this.destinationName,
        model: this.model,
        messageCount: messages.length,
      });

      // Format messages for SAP Core AI API
      const requestBody = {
        model: this.model,
        messages: this.formatMessages(messages),
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 2000,
      };

      // Use SAP Cloud SDK executeHttpRequest for automatic destination handling
      const response = await executeHttpRequest(
        { destinationName: this.destinationName },
        {
          method: 'POST',
          url: '/v1/chat/completions', // SAP Core AI endpoint
          headers: {
            'Content-Type': 'application/json',
          },
          data: requestBody,
        }
      );

      const choice = response.data.choices?.[0];
      
      if (!choice) {
        throw new Error('No response from SAP Core AI');
      }

      this.log.debug('Received response from SAP Core AI', {
        finishReason: choice.finish_reason,
      });

      return {
        content: choice.message?.content || '',
        finishReason: choice.finish_reason,
      };
    } catch (error: any) {
      this.log.error('SAP Core AI API error', {
        destination: this.destinationName,
        error: error.message,
        response: error.response?.data,
      });
      
      throw new Error(
        `SAP Core AI API error: ${error.response?.data?.error?.message || error.message}`
      );
    }
  }

  /**
   * Format messages for SAP Core AI API
   */
  private formatMessages(messages: Message[]): any[] {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));
  }
}


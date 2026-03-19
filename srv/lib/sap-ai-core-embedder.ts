/**
 * SAP AI Core Embedder — IEmbedder implementation using @sap-ai-sdk/orchestration.
 *
 * Generates text embeddings via SAP AI Core embedding model deployments.
 * Authentication: reads AICORE_SERVICE_KEY env var automatically (same as LLM provider).
 */

import type { IEmbedder } from '@mcp-abap-adt/llm-agent/dist/smart-agent/interfaces/rag';
import type { CallOptions } from '@mcp-abap-adt/llm-agent/dist/smart-agent/interfaces/types';
import {
  type EmbeddingModel,
  OrchestrationEmbeddingClient,
} from '@sap-ai-sdk/orchestration';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small') */
  model: string;
  /** SAP AI Core resource group (optional) */
  resourceGroup?: string;
}

export class SapAiCoreEmbedder implements IEmbedder {
  private readonly model: string;
  private readonly resourceGroup?: string;

  constructor(config: SapAiCoreEmbedderConfig) {
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
  }

  async embed(text: string, _options?: CallOptions): Promise<number[]> {
    const client = new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: this.model as EmbeddingModel } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );

    const response = await client.embed({ input: text });
    const embeddings = response.getEmbeddings();

    if (!embeddings || embeddings.length === 0) {
      throw new Error('No embeddings returned from SAP AI Core');
    }

    const embedding = embeddings[0].embedding;

    // Handle base64-encoded embeddings
    if (typeof embedding === 'string') {
      const buffer = Buffer.from(embedding, 'base64');
      const float32 = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.length / 4,
      );
      return Array.from(float32);
    }

    return embedding;
  }
}

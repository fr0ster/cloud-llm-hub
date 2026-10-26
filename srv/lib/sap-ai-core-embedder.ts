/**
 * SAP AI Core Embedder — IEmbedder implementation using @sap-ai-sdk/orchestration.
 *
 * Generates text embeddings via SAP AI Core embedding model deployments.
 * Authentication: reads AICORE_SERVICE_KEY env var automatically (same as LLM provider).
 */

import {
  beginEmbeddingRequest,
  type CallOptions,
  type IEmbedder,
  type IUsageRecorder,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import { OrchestrationEmbeddingClient } from '@sap-ai-sdk/orchestration';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small') */
  model: string;
  /** SAP AI Core resource group (optional) */
  resourceGroup?: string;
  usage?: IUsageRecorder;
}

export class SapAiCoreEmbedder implements IEmbedder {
  private readonly model: string;
  private readonly resourceGroup?: string;
  private readonly usage?: IUsageRecorder;

  constructor(config: SapAiCoreEmbedderConfig) {
    this.usage = config.usage;
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
  }

  async embed(text: string, options?: CallOptions) {
    const results = await this.embedBatch([text], options);
    return results[0];
  }

  async embedBatch(texts: string[], options?: CallOptions) {
    if (texts.length === 0) return [];
    const request = beginEmbeddingRequest(
      options,
      startOperation(options),
      {
        provider: 'sap-ai-sdk',
        model: this.model,
        inputs: texts.length,
        inputChars: texts.reduce(
          (sum: number, text: string): number => sum + text.length,
          0,
        ),
        granularity: 'sdk-call',
        retriesVisible: false,
      },
      this.usage,
    );
    let outcome: 'ok' | 'error' | 'aborted' = 'error';
    let failure: Error | undefined;
    let inputTokens: number | undefined;
    try {
      const client = new OrchestrationEmbeddingClient(
        { embeddings: { model: { name: this.model } } },
        this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
      );
      const response = await client.embed(
        { input: texts.length === 1 ? texts[0] : texts },
        { signal: options?.signal },
      );
      inputTokens = response.getTokenUsage()?.prompt_tokens;
      const embeddings = response.getEmbeddings();
      if (!embeddings || embeddings.length !== texts.length) {
        throw new Error('No embeddings returned from SAP AI Core');
      }
      const indexed = new Map<number, { vector: number[] }>();
      for (const { embedding, index } of embeddings) {
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= texts.length ||
          indexed.has(index)
        )
          throw new Error(
            'Invalid or duplicate embedding index from SAP AI Core',
          );
        indexed.set(index, decode(embedding));
      }
      const results = texts.map(
        (_: string, index: number): { vector: number[] } => {
          const result = indexed.get(index);
          if (!result)
            throw new Error('Missing embedding index from SAP AI Core');
          return result;
        },
      );
      function decode(embedding: number[] | string): { vector: number[] } {
        if (typeof embedding !== 'string') return { vector: embedding };
        const buffer = Buffer.from(embedding, 'base64');
        const float32 = new Float32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.length / 4,
        );
        return { vector: Array.from(float32) };
      }
      outcome = 'ok';
      return results;
    } catch (error) {
      if (error instanceof Error) failure = error;
      outcome =
        options?.signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
          ? 'aborted'
          : 'error';
      throw error;
    } finally {
      request.end({
        outcome,
        error: failure,
        inputTokens,
        tokensSource: inputTokens === undefined ? 'unknown' : 'provider',
      });
    }
  }
}

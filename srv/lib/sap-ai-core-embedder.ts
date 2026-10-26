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
import {
  type EmbeddingModel,
  OrchestrationEmbeddingClient,
} from '@sap-ai-sdk/orchestration';

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

  async embed(
    text: string,
    options?: CallOptions,
  ): Promise<{
    vector: number[];
    usage?: { promptTokens: number; totalTokens: number };
  }> {
    const createClient = (): OrchestrationEmbeddingClient =>
      new OrchestrationEmbeddingClient(
        { embeddings: { model: { name: this.model as EmbeddingModel } } },
        this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
      );
    if (!(options?.usage ?? this.usage)) {
      const client = createClient();
      const response = await client.embed({ input: text });
      return this.decode(response);
    }

    const request = beginEmbeddingRequest(
      options,
      startOperation(options),
      {
        provider: 'sap-ai-sdk',
        model: this.model,
        inputs: 1,
        inputChars: text.length,
        granularity: 'sdk-call',
        retriesVisible: false,
      },
      this.usage,
    );
    let outcome: 'ok' | 'error' | 'aborted' = 'error';
    let failure: Error | undefined;
    let inputTokens: number | undefined;
    try {
      const client = createClient();
      const response = await client.embed({ input: text });
      inputTokens = response.getTokenUsage()?.prompt_tokens;
      const result = this.decode(response);
      outcome = 'ok';
      return result;
    } catch (error) {
      if (error instanceof Error) failure = error;
      outcome =
        options?.signal?.aborted ||
        ((error instanceof Error || error instanceof DOMException) &&
          error.name === 'AbortError')
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

  private decode(
    response: Awaited<ReturnType<OrchestrationEmbeddingClient['embed']>>,
  ): { vector: number[] } {
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
      return { vector: Array.from(float32) };
    }
    return { vector: embedding };
  }
}

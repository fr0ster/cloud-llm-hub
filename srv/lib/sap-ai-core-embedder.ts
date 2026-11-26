/**
 * Text embeddings through SAP AI Core orchestration or a foundation-models deployment.
 */

import {
  beginEmbeddingRequest,
  type CallOptions,
  type IEmbedder,
  type IUsageRecorder,
  startOperation,
} from '@mcp-abap-adt/llm-agent';
import { buildDestination } from '@mcp-abap-adt/sap-aicore-llm';
import {
  AzureOpenAiEmbeddingClient,
  type AzureOpenAiEmbeddingModel,
} from '@sap-ai-sdk/foundation-models';
import {
  type EmbeddingModel,
  OrchestrationEmbeddingClient,
} from '@sap-ai-sdk/orchestration';
import { getAiCoreAccess } from './llm-factory';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small') */
  model: string;
  /** SAP AI Core resource group (optional) */
  resourceGroup?: string;
  scenario?: 'foundation-models';
  usage?: IUsageRecorder;
}

export class SapAiCoreEmbedder implements IEmbedder {
  private readonly model: string;
  private readonly resourceGroup?: string;
  private readonly scenario?: SapAiCoreEmbedderConfig['scenario'];
  private readonly usage?: IUsageRecorder;

  constructor(config: SapAiCoreEmbedderConfig) {
    this.usage = config.usage;
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
    this.scenario = config.scenario;
  }

  async embed(
    text: string,
    options?: CallOptions,
  ): Promise<{
    vector: number[];
    usage?: { promptTokens: number; totalTokens: number };
  }> {
    if (!(options?.usage ?? this.usage)) {
      const { embedding } = await this.requestEmbedding(text, options?.signal);
      return this.decode(embedding);
    }

    const request = beginEmbeddingRequest(
      options,
      startOperation(options),
      {
        provider:
          this.scenario === 'foundation-models'
            ? 'sap-aicore-foundation'
            : 'sap-ai-sdk',
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
      const response = await this.requestEmbedding(text, options?.signal);
      inputTokens = response.inputTokens;
      const result = this.decode(response.embedding);
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

  private async requestEmbedding(text: string, signal?: AbortSignal) {
    if (this.scenario === 'foundation-models') {
      signal?.throwIfAborted();
      const destination = await buildDestination(getAiCoreAccess());
      const client = new AzureOpenAiEmbeddingClient(
        {
          modelName: this.model as AzureOpenAiEmbeddingModel,
          resourceGroup: this.resourceGroup,
        },
        destination,
      );
      const response = await client.run({ input: text }, { signal });
      return {
        get embedding() {
          return response.getEmbedding();
        },
        get inputTokens() {
          return response._data.usage?.prompt_tokens;
        },
      };
    }
    const client = new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: this.model as EmbeddingModel } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );
    const response = await client.embed({ input: text });
    return {
      get embedding() {
        return response.getEmbeddings()?.[0]?.embedding;
      },
      get inputTokens() {
        return response.getTokenUsage()?.prompt_tokens;
      },
    };
  }

  private decode(embedding?: number[] | string): { vector: number[] } {
    if (embedding === undefined) {
      throw new Error('No embeddings returned from SAP AI Core');
    }

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

/**
 * Agent Manager - SmartAgent lifecycle management
 *
 * Builds and manages SmartAgent instances using SmartAgentBuilder.
 * Configuration comes from environment variables (set via mta.yaml or CF CLI).
 *
 * Architecture:
 * - SmartAgentBuilder wires together: LLM, MCP, RAG, resilience, caching, metrics
 * - LLM: SAP AI Core via sap-ai-sdk provider
 * - MCP: Embedded EmbeddableMcpServer (in-process, no HTTP overhead)
 * - RAG: FallbackRag(VectorRag → InMemoryRag) with CircuitBreakerEmbedder
 * - RAG quality: LlmQueryExpander (synonym expansion) + LlmReranker (semantic re-scoring)
 * - Resilience: CircuitBreaker for LLM + embedder failures
 * - Caching: ToolCache for deduplication, SessionManager for token budget
 * - Metrics: InMemoryMetrics for request/tool/RAG/LLM counters and latencies
 */

import type { HandlerContext } from '@mcp-abap-adt/core/handlers';
import { HandlerExporter } from '@mcp-abap-adt/core/handlers';
import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  ClineClientAdapter,
  FallbackRag,
  getStreamToolCallName,
  InMemoryMetrics,
  InMemoryRag,
  type IRag,
  type ISpan,
  type IStageHandler,
  MCPClientWrapper,
  McpClientAdapter,
  makeLlm,
  type PipelineContext,
  SessionManager,
  SmartAgentBuilder,
  type SmartAgentHandle,
  type StructuredPipelineDefinition,
  ToolCache,
  toToolCallDelta,
  VectorRag,
} from '@mcp-abap-adt/llm-agent';
import cds from '@sap/cds';

/** Inlined from llm-agent (not re-exported from package root) */
function isToolContextUnavailableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('not available') ||
    normalized.includes('unavailable') ||
    normalized.includes('not found') ||
    normalized.includes('forbidden')
  );
}

import { z } from 'zod';
import { type AgentConfig, getAgentConfig } from './agent-config';

// ---------------------------------------------------------------------------
// NamespaceFilteredRag — wraps InMemoryRag with per-query namespace filtering
// ---------------------------------------------------------------------------
// InMemoryRag only filters by this.namespace (constructor-time). When used as
// a shared store across destinations, this.namespace is undefined and ALL records
// are returned. This wrapper reads options.ragFilter.namespace at query time
// and filters results accordingly, matching VectorRag/QdrantRag behavior.
// ---------------------------------------------------------------------------

class NamespaceFilteredRag implements IRag {
  private inner: InMemoryRag;

  constructor(config?: { dedupThreshold?: number }) {
    this.inner = new InMemoryRag(config);
  }

  async upsert(
    text: string,
    metadata: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) {
    return this.inner.upsert(text, metadata, options);
  }

  async query(
    text: string,
    k: number,
    options?: { signal?: AbortSignal; ragFilter?: { namespace?: string } },
  ) {
    const result = await this.inner.query(text, k, options);
    if (!result.ok) return result;

    const ns = options?.ragFilter?.namespace;
    if (ns) {
      result.value = result.value.filter(
        (r: { metadata?: { namespace?: string } }) =>
          r.metadata?.namespace === ns,
      );
    }
    return result;
  }

  async healthCheck() {
    return this.inner.healthCheck();
  }
}

import { createConnection } from './connections/connectionFactory';
import { resolveDestinationSapConfig } from './connections/destinationResolver';
import { getAvailableDestinations } from './lib/btp-destinations';
import { loggerAdapter } from './lib/logger';
import { SapAiCoreEmbedder } from './lib/sap-ai-core-embedder';

/**
 * Convert inputSchema from HandlerExporter to JSON Schema.
 *
 * HandlerExporter returns Zod raw shapes (Record<string, ZodType>),
 * not JSON Schema. The MCP SDK converts them automatically in listTools,
 * but our embedded MCP path bypasses that conversion.
 */
function toJsonSchema(inputSchema: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { type: 'object', properties: {} };
  }

  // Already JSON Schema (from high-level handlers that define it directly)
  if (
    (inputSchema as Record<string, unknown>).type === 'object' &&
    (inputSchema as Record<string, unknown>).properties
  ) {
    return inputSchema as Record<string, unknown>;
  }

  // Zod raw shape: Record<string, ZodType> — wrap in z.object() and convert
  // Uses Zod v4 built-in toJSONSchema, then strips $schema and additionalProperties
  // which SAP AI Core Orchestration API doesn't expect in tool parameter schemas
  try {
    // biome-ignore lint/suspicious/noExplicitAny: Zod raw shape type varies between handler groups
    const zodObj = z.object(inputSchema as any);
    const result = z.toJSONSchema(zodObj) as Record<string, unknown>;
    delete result.$schema;
    delete result.additionalProperties;
    return result;
  } catch {
    // Fallback: return empty schema
    return { type: 'object', properties: {} };
  }
}

/**
 * Custom classify handler — extends the built-in classify logic and sets
 * `ctx.ragText` from action subprompts.
 *
 * In the default (hardcoded) flow, ragText is computed inline after classification.
 * The structured pipeline expects ragText to be set by the classify stage,
 * but the built-in ClassifyHandler doesn't do this. Without ragText, the
 * translate/expand/rag-query stages all operate on an empty string.
 */
class CustomClassifyHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const log = cds.log('agent-manager/classify');
    log.info('CustomClassifyHandler executing', {
      inputText: ctx.inputText?.slice(0, 100),
      classificationEnabled: ctx.config.classificationEnabled,
    });
    // Classify input into subprompts (same logic as built-in ClassifyHandler)
    if (ctx.config.classificationEnabled === false) {
      ctx.subprompts = [
        { type: 'action', text: ctx.inputText, dependency: 'independent' },
      ];
      span.setAttribute('skipped', true);
    } else {
      const result = await ctx.classifier.classify(ctx.inputText, ctx.options);
      if (!result.ok) {
        // Classification failed — log error but fallback to action, don't kill pipeline
        log.error('Classifier failed, falling back to action subprompt', {
          error: result.error.message,
        });
        ctx.subprompts = [
          {
            type: 'action',
            text: ctx.inputText,
            context: 'sap-abap',
            dependency: 'independent',
          },
        ];
      } else {
        ctx.subprompts = result.value;
        ctx.options?.sessionLogger?.logStep('classifier_response', {
          subprompts: result.value,
        });
      }
    }

    // Update control flags (same logic as built-in ClassifyHandler._updateControlFlags)
    const actions = ctx.subprompts.filter(
      (sp: { type: string }) => sp.type === 'action',
    );
    const mode = ctx.config.mode || 'smart';
    ctx.isSapRequired =
      actions.some((a: { context?: string }) => a.context === 'sap-abap') ||
      mode === 'hard';
    const ragMode = ctx.config.ragRetrievalMode ?? 'auto';
    ctx.shouldRetrieve =
      ragMode === 'always' || (ragMode === 'auto' && ctx.isSapRequired);

    // Set ragText from action subprompts (NOT done by built-in ClassifyHandler).
    // Without this, translate/expand/rag-query all operate on empty string.
    ctx.ragText =
      actions.map((a: { text: string }) => a.text).join(' ') || ctx.inputText;

    ctx.options?.sessionLogger?.logStep('custom_classify', {
      subpromptCount: ctx.subprompts.length,
      actionCount: actions.length,
      shouldRetrieve: ctx.shouldRetrieve,
      ragText: ctx.ragText.slice(0, 200),
    });

    return true;
  }
}

/**
 * Custom tool-select stage handler using the dedicated 'tools' RAG store.
 *
 * Replaces the built-in ToolSelectHandler which scans ALL ragResults for
 * `tool:*` entries (mixing tool descriptions into assembler output).
 * This handler queries only `ctx.ragStores.tools` and does NOT write to
 * `ctx.ragResults`, keeping tool discovery isolated from user knowledge.
 *
 * v3.0.0 dynamic stores: `tools` is registered via `.withRag()` as a
 * first-class store, but only this handler queries it — no `rag-query`
 * stage in the pipeline for `tools`.
 */
class CustomToolSelectHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const log = cds.log('agent-manager/tool-select');
    log.info('CustomToolSelectHandler executing', {
      ragStoreKeys: Object.keys(ctx.ragStores),
      hasToolsStore: !!ctx.ragStores.tools,
      mcpToolsCount: ctx.mcpTools.length,
      mcpClientsCount: ctx.mcpClients.length,
      inputText: ctx.inputText?.slice(0, 100),
    });
    const mode = ctx.config.mode || 'smart';

    // List all MCP tools if not already done
    if (ctx.mcpTools.length === 0 && ctx.mcpClients.length > 0) {
      const settled = await Promise.allSettled(
        ctx.mcpClients.map(async (client) => ({
          client,
          result: await client.listTools(ctx.options),
        })),
      );
      for (const entry of settled) {
        if (entry.status === 'fulfilled' && entry.value.result.ok) {
          for (const t of entry.value.result.value) {
            if (!ctx.toolClientMap.has(t.name)) {
              ctx.mcpTools.push(t);
              ctx.toolClientMap.set(t.name, entry.value.client);
            }
          }
        } else {
          // Explicit failure logging — helps diagnose "0 tools" issues
          const reason =
            entry.status === 'rejected'
              ? String(entry.reason)
              : !entry.value.result.ok
                ? `listTools returned error: ${'error' in entry.value.result ? String(entry.value.result.error) : 'unknown'}`
                : 'unknown';
          log.error('MCP client listTools failed', { reason });
        }
      }
      log.info('MCP tools loaded', {
        mcpToolsCount: ctx.mcpTools.length,
        clientResults: settled.map((s) =>
          s.status === 'fulfilled'
            ? {
                ok: s.value.result.ok,
                count: s.value.result.ok ? s.value.result.value.length : 0,
              }
            : { ok: false, error: String(s.reason) },
        ),
      });
    }

    // Query the dedicated 'tools' store from ctx.ragStores (registered via withRag)
    const toolsStore = ctx.ragStores.tools;
    // Use our own default (15) instead of ctx.config.ragQueryK (builder default is 10,
    // too few for 259 MCP tools — SearchObject gets pushed below the cutoff)
    const k = (config.k as number) || 15;
    const queryText = ctx.ragText || ctx.inputText;
    let ragToolNames = new Set<string>();

    if (!toolsStore) {
      log.warn('Tools RAG store not found', {
        availableStores: Object.keys(ctx.ragStores),
      });
    }

    if (toolsStore && ctx.mcpTools.length > 0) {
      // Query tools store WITHOUT ragFilter — tools are shared (no namespace).
      // ctx.options contains ragFilter.namespace for per-user isolation,
      // but tool records were upserted without namespace metadata.
      // Passing ragFilter would filter out ALL tool records → 0 results → hallucination.
      const { ragFilter: _unused, ...toolQueryOpts } = (ctx.options ??
        {}) as Record<string, unknown>;

      // Retry once on failure (covers transient 429 rate-limit from embedder)
      let result = await toolsStore.query(queryText, k, toolQueryOpts);
      if (!result.ok) {
        log.warn('Tools RAG query failed, retrying in 1.5s', {
          error: 'error' in result ? String(result.error) : 'unknown',
        });
        await new Promise((r) => setTimeout(r, 1500));
        result = await toolsStore.query(queryText, k, toolQueryOpts);
      }

      if (result.ok) {
        ragToolNames = new Set(
          result.value
            .map((r) => r.metadata.id)
            .filter((id): id is string => !!id?.startsWith('tool:'))
            .map((id) => id.slice(5)),
        );
        ctx.options?.sessionLogger?.logStep('custom_tool_select', {
          query: queryText.slice(0, 200),
          k,
          resultCount: result.value.length,
          matchedTools: [...ragToolNames],
          results: result.value.map((r) => ({
            id: r.metadata.id,
            score: r.score,
            text: r.text.slice(0, 120),
          })),
        });
      } else {
        log.error('Tools RAG query failed after retry', {
          query: queryText.slice(0, 200),
          error: 'error' in result ? String(result.error) : 'unknown',
          storeType: toolsStore.constructor.name,
        });
      }
    } else if (ctx.mcpTools.length === 0) {
      log.warn(
        'No MCP tools available for RAG query — LLM will have no tools',
        {
          mcpClientsCount: ctx.mcpClients.length,
          toolsStoreType: toolsStore?.constructor.name ?? 'none',
        },
      );
    }

    // Select tools based on RAG results.
    // If RAG returns 0 matches (language mismatch, embedder failure, etc.) but MCP tools
    // ARE available, fall back to all tools. Zero tools = guaranteed hallucination.
    let selectedMcpTools: typeof ctx.mcpTools;
    if (ragToolNames.size > 0) {
      selectedMcpTools = ctx.mcpTools.filter((t) => ragToolNames.has(t.name));
    } else if (ctx.mcpTools.length > 0) {
      // Fallback: RAG didn't match any tools — provide all MCP tools to prevent hallucination
      selectedMcpTools = ctx.mcpTools;
      log.warn(
        'RAG tool query returned 0 matches — falling back to all MCP tools',
        {
          query: queryText.slice(0, 200),
          mcpToolsCount: ctx.mcpTools.length,
          mode,
        },
      );
    } else {
      selectedMcpTools = [];
    }

    ctx.selectedTools =
      mode === 'hard'
        ? selectedMcpTools
        : [...selectedMcpTools, ...ctx.externalTools];

    // Apply availability filtering
    const filtered = ctx.toolAvailabilityRegistry.filterTools(
      ctx.sessionId,
      ctx.selectedTools,
    );
    ctx.activeTools = filtered.allowed;
    if (filtered.blocked.length > 0) {
      ctx.options?.sessionLogger?.logStep('active_tools_filtered_by_registry', {
        blocked: filtered.blocked,
      });
    }

    span.setAttribute('mcp_tools', ctx.mcpTools.length);
    span.setAttribute('selected', ctx.selectedTools.length);
    span.setAttribute('active', ctx.activeTools.length);

    ctx.options?.sessionLogger?.logStep('tools_selected', {
      totalMcp: ctx.mcpTools.length,
      ragMatchedTools: [...ragToolNames],
      selectedCount: ctx.selectedTools.length,
      selectedNames: ctx.selectedTools.map((t) => t.name),
      activeCount: ctx.activeTools.length,
    });

    return true;
  }
}

/**
 * Custom rag-upsert handler — stores classified subprompts (fact, feedback, state)
 * with per-session namespace for user isolation.
 *
 * The built-in RagUpsertHandler reads namespace from static `ctx.config.sessionPolicy`,
 * but our singleton SmartAgent serves all users. This handler reads the sessionId
 * from `ctx.options` (passed per-request) and uses it as the namespace.
 *
 * This ensures each user's facts/feedback/state are isolated in RAG queries.
 * The 'tools' store is shared — it has no namespace and is NOT written here.
 */
class CustomRagUpsertHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const log = cds.log('agent-manager/rag-upsert');

    // Use ragFilter.namespace (= userId) for per-user isolation.
    // Set in openai-handler.ts from cds.context.user.id (XSUAA/mocked auth).
    // biome-ignore lint/suspicious/noExplicitAny: ragFilter not in CallOptions type
    const namespace = (ctx.options as any)?.ragFilter?.namespace as
      | string
      | undefined;
    const metadata: Record<string, unknown> = {};
    if (namespace) {
      metadata.namespace = namespace;
    }
    // TTL: 1 hour
    metadata.ttl = Math.floor((Date.now() + 3600_000) / 1000);

    // Resolve store by subprompt type (fact→facts, feedback→feedback, state→state)
    const resolveStore = (type: string) =>
      ctx.ragStores[type] ?? ctx.ragStores[`${type}s`];

    // Filter: skip actions and chat, only upsert fact/feedback/state
    const toStore = ctx.subprompts.filter(
      (sp: { type: string }) =>
        sp.type !== 'action' && sp.type !== 'chat' && resolveStore(sp.type),
    );

    if (toStore.length === 0) {
      span.setAttribute('skipped', true);
      return true;
    }

    const results = await Promise.allSettled(
      toStore.map(async (sp: { type: string; text: string }) => {
        const store = resolveStore(sp.type);
        if (!store) return;
        const res = await store.upsert(sp.text, metadata, ctx.options);
        if (!res.ok) {
          log.warn('RAG upsert failed', {
            type: sp.type,
            error: 'error' in res ? String(res.error) : 'unknown',
          });
        }
        return { type: sp.type, ok: res.ok };
      }),
    );

    const stored = results
      .filter((r) => r.status === 'fulfilled' && r.value?.ok)
      .map((r) => (r as PromiseFulfilledResult<{ type: string }>).value.type);

    log.info('RAG upsert completed', {
      namespace: namespace ?? 'none',
      subpromptTypes: toStore.map((sp: { type: string }) => sp.type),
      storedTypes: stored,
    });

    span.setAttribute('stored_count', stored.length);
    return true;
  }
}

// ---------------------------------------------------------------------------
// CustomToolLoopHandler — per-iteration RAG tool re-selection
// ---------------------------------------------------------------------------

/**
 * Custom tool-loop handler with per-iteration RAG-based tool re-selection.
 *
 * Problem: The built-in ToolLoopHandler selects tools ONCE (via tool-select stage)
 * before the loop starts. If iteration 1 uses CreateClass, iteration 2 won't have
 * UpdateClass in its tool set because the initial query was about "creating".
 *
 * Solution: On each iteration > 0, re-query the tools RAG store using the latest
 * context (last tool result + LLM response) to get fresh top-k tools. Also update
 * the system message's "## Available Tools" section to match.
 *
 * Token cost: ~zero. RAG query = embedding + cosine (no LLM call).
 * Tool count stays at k=15 per iteration (not 259).
 */
class CustomToolLoopHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    parentSpan: ISpan,
  ): Promise<boolean> {
    const log = cds.log('agent-manager/tool-loop');
    const maxIterations =
      (config.maxIterations as number) ?? ctx.config.maxIterations;
    const maxToolCalls =
      (config.maxToolCalls as number) ?? ctx.config.maxToolCalls;
    const heartbeatMs =
      (config.heartbeatIntervalMs as number) ??
      ctx.config.heartbeatIntervalMs ??
      5000;
    const mode = ctx.config.mode || 'smart';
    const externalTools = mode === 'hard' ? [] : ctx.externalTools;
    const externalToolNames = new Set(externalTools.map((t) => t.name));
    let toolCallCount = 0;
    let messages = ctx.assembledMessages;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const timingLog: Array<{ phase: string; duration: number }> = [];
    const loopStart = Date.now();
    let currentTools = ctx.activeTools;

    // RAG re-selection config
    const toolsStore = ctx.ragStores.tools;
    const ragK = 15;

    for (let iteration = 0; ; iteration++) {
      if (ctx.options?.signal?.aborted) {
        // biome-ignore lint/suspicious/noExplicitAny: matching library error type
        ctx.yield({ ok: false, error: new Error('Aborted') } as any);
        return false;
      }

      if (iteration >= maxIterations) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'length',
            usage,
            timing: timingLog,
          },
        });
        return true;
      }

      // -- Per-iteration RAG tool re-selection (iteration > 0) ----------------
      if (iteration > 0 && toolsStore) {
        const reSelectStart = Date.now();

        // Build query from failed tool names + error context + original input
        // When assistant makes tool_calls, content is often empty — extract tool names instead
        const lastToolMsg = [...messages]
          .reverse()
          .find((m) => m.role === 'tool');
        const lastAssistantMsg = [...messages]
          .reverse()
          .find((m) => m.role === 'assistant');

        // Extract tool call names from last assistant message (e.g., "CreateClass", "CreateBehaviorImplementation")
        const toolCallNames: string[] = [];
        if (lastAssistantMsg && 'tool_calls' in lastAssistantMsg) {
          const toolCalls = (lastAssistantMsg as any).tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const name = tc?.function?.name || tc?.name || '';
              if (name) toolCallNames.push(name);
            }
          }
        }

        // Build re-select query with error context
        // Key insight: when CreateClass fails with "already exists", query should guide RAG toward Update* tools
        const toolError =
          lastToolMsg?.content && typeof lastToolMsg.content === 'string'
            ? lastToolMsg.content.slice(0, 200)
            : '';
        const isError =
          toolError.includes('error') ||
          toolError.includes('Error') ||
          toolError.includes('failed') ||
          toolError.includes('already exist');

        let reSelectQuery: string;

        // When Create* tools are involved, derive Update* counterparts for RAG hints
        // CreateClass → UpdateClass, CreateFunctionGroup → UpdateFunctionGroup, etc.
        const createToolNames = toolCallNames.filter((n) =>
          n.startsWith('Create'),
        );
        const updateHints = createToolNames
          .map((n) => n.replace(/^Create/, 'Update'))
          .join(', ');

        if (toolCallNames.length > 0 && isError) {
          // Failed tool calls — steer RAG toward alternative tools
          const failedNames = toolCallNames.join(', ');
          const hints = updateHints
            ? ` Need ${updateHints} to modify existing object.`
            : '';
          reSelectQuery = `${failedNames} failed: ${toolError.slice(0, 150)}.${hints} Alternative tool for: ${ctx.inputText.slice(0, 200)}`;
        } else if (toolCallNames.length > 0) {
          // Successful tool calls — include tool result + explicit Update* hint
          const toolResult =
            lastToolMsg?.content && typeof lastToolMsg.content === 'string'
              ? lastToolMsg.content.slice(0, 300)
              : '';
          const hints = updateHints
            ? ` Next step: ${updateHints} to set source code.`
            : '';
          reSelectQuery = `After ${toolCallNames.join(', ')}: ${toolResult}${hints}\n${ctx.inputText.slice(0, 200)}`;
        } else if (
          lastAssistantMsg?.content &&
          typeof lastAssistantMsg.content === 'string'
        ) {
          reSelectQuery = lastAssistantMsg.content.slice(0, 300);
          if (toolError) {
            reSelectQuery = `${reSelectQuery}\n${toolError}`;
          }
        } else {
          reSelectQuery = ctx.inputText;
          if (toolError) {
            reSelectQuery = `${reSelectQuery}\n${toolError}`;
          }
        }

        // Query tools RAG (no namespace filter — tools are shared)
        log.info('Tool re-selection query', {
          iteration: iteration + 1,
          query: reSelectQuery.slice(0, 300),
          failedTools: toolCallNames,
          isError,
        });
        const { ragFilter: _unused, ...toolQueryOpts } = (ctx.options ??
          {}) as Record<string, unknown>;
        const ragResult = await toolsStore.query(
          reSelectQuery,
          ragK,
          toolQueryOpts,
        );

        if (ragResult.ok && ragResult.value.length > 0) {
          const newToolNames = new Set(
            ragResult.value
              .map((r: { metadata: { id?: string } }) => r.metadata.id)
              .filter((id): id is string => !!id?.startsWith('tool:'))
              .map((id: string) => id.slice(5)),
          );

          // Filter MCP tools to RAG-selected ones
          const newMcpTools = ctx.mcpTools.filter((t) =>
            newToolNames.has(t.name),
          );
          currentTools = [...newMcpTools, ...externalTools];

          // Apply availability filtering
          const filtered = ctx.toolAvailabilityRegistry.filterTools(
            ctx.sessionId,
            currentTools,
          );
          currentTools = filtered.allowed;

          // Update "## Available Tools" in system message
          const sysMsg = messages.find((m) => m.role === 'system');
          if (sysMsg && typeof sysMsg.content === 'string') {
            const toolsSection = currentTools
              .filter((t) => !externalToolNames.has(t.name))
              .map((t) => `- ${t.name}: ${t.description}`)
              .join('\n');
            sysMsg.content = sysMsg.content.replace(
              /## Available Tools\n[\s\S]*?(?=\n##|$)/,
              `## Available Tools\n${toolsSection}`,
            );
          }

          ctx.options?.sessionLogger?.logStep('tool_reselect', {
            iteration: iteration + 1,
            query: reSelectQuery.slice(0, 200),
            matchedTools: [...newToolNames],
            duration: Date.now() - reSelectStart,
          });
        } else {
          log.warn('Tool re-selection failed, keeping previous tools', {
            iteration: iteration + 1,
            error:
              !ragResult.ok && 'error' in ragResult
                ? String(ragResult.error)
                : 'no results',
          });
        }
      }

      // Filter tools per iteration (availability registry)
      const filteredForIteration = ctx.toolAvailabilityRegistry.filterTools(
        ctx.sessionId,
        currentTools,
      );
      currentTools = filteredForIteration.allowed;

      ctx.options?.sessionLogger?.logStep(`llm_request_iter_${iteration + 1}`, {
        messages,
        tools: currentTools,
      });

      // -- LLM streaming call ------------------------------------------------
      const llmSpan = ctx.tracer.startSpan('smart_agent.llm_call', {
        parent: parentSpan,
        attributes: { 'llm.iteration': iteration + 1 },
      });
      ctx.metrics.llmCallCount.add();
      const llmCallStart = Date.now();
      const stream = ctx.mainLlm.streamChat(
        messages,
        currentTools,
        ctx.options,
      );
      let content = '';
      // biome-ignore lint/suspicious/noExplicitAny: library finish reason type
      let finishReason: any;
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      for await (const chunkResult of stream) {
        if (!chunkResult.ok) {
          llmSpan.setStatus('error', chunkResult.error.message);
          llmSpan.end();
          // biome-ignore lint/suspicious/noExplicitAny: matching library error type
          ctx.yield({
            ok: false,
            error: new Error(chunkResult.error.message),
          } as any);
          return false;
        }
        // biome-ignore lint/suspicious/noExplicitAny: library chunk type
        const chunk = chunkResult.value as any;
        if (chunk.content) {
          content += chunk.content;
          ctx.yield({ ok: true, value: { content: chunk.content } });
        }
        if (chunk.toolCalls) {
          // biome-ignore lint/suspicious/noExplicitAny: library stream tool call types
          const streamCalls = chunk.toolCalls as any[];
          const externalDeltas = streamCalls.filter((tc) =>
            externalToolNames.has(getStreamToolCallName(tc) ?? ''),
          );
          if (externalDeltas.length > 0) {
            ctx.yield({
              ok: true,
              value: { content: '', toolCalls: externalDeltas },
            });
          }
          for (const [fallbackIndex, rawToolCall] of streamCalls.entries()) {
            const tc = toToolCallDelta(rawToolCall, fallbackIndex);
            if (!toolCallsMap.has(tc.index)) {
              toolCallsMap.set(tc.index, {
                id: tc.id || '',
                name: tc.name || '',
                arguments: tc.arguments || '',
              });
            } else {
              const ex = toolCallsMap.get(tc.index);
              if (ex) {
                if (tc.id) ex.id = tc.id;
                if (tc.name) ex.name = tc.name;
                if (tc.arguments) ex.arguments += tc.arguments;
              }
            }
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) {
          usage.promptTokens += chunk.usage.promptTokens;
          usage.completionTokens += chunk.usage.completionTokens;
          usage.totalTokens += chunk.usage.totalTokens;
          ctx.sessionManager.addTokens(chunk.usage.totalTokens);
        }
      }

      llmSpan.setStatus('ok');
      llmSpan.end();
      const llmCallDuration = Date.now() - llmCallStart;
      ctx.metrics.llmCallLatency.record(llmCallDuration);
      timingLog.push({
        phase: `llm_call_${iteration + 1}`,
        duration: llmCallDuration,
      });

      const toolCalls = Array.from(toolCallsMap.values()).map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.name, arguments: args };
      });

      ctx.options?.sessionLogger?.logStep(
        `llm_response_iter_${iteration + 1}`,
        {
          content,
          toolCalls,
          finishReason,
        },
      );

      // -- No tool calls: validate and finish --------------------------------
      if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
        const valResult = await ctx.outputValidator.validate(
          content,
          { messages, tools: currentTools },
          ctx.options,
        );
        if (valResult.ok && !valResult.value.valid) {
          const correction =
            valResult.value.correctedContent ?? valResult.value.reason;
          messages = [
            ...messages,
            { role: 'assistant', content },
            {
              role: 'user',
              content: `Your previous response was rejected by validation: ${correction}. Please try again.`,
            },
          ];
          continue;
        }
        ctx.options?.sessionLogger?.logStep('final_response', {
          content,
          usage,
        });
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: finishReason || 'stop',
            usage,
            timing: timingLog,
          },
        });
        return true;
      }

      // -- Classify tool calls -----------------------------------------------
      const internalCalls = toolCalls.filter((tc) =>
        ctx.toolClientMap.has(tc.name),
      );
      const validExternalCalls = toolCalls.filter((tc) =>
        externalToolNames.has(tc.name),
      );
      const blockedToolNames = ctx.toolAvailabilityRegistry.getBlockedToolNames(
        ctx.sessionId,
      );
      const blockedCalls = toolCalls.filter((tc) =>
        blockedToolNames.has(tc.name),
      );
      const hallucinations = toolCalls.filter(
        (tc) =>
          !blockedToolNames.has(tc.name) &&
          !ctx.toolClientMap.has(tc.name) &&
          !externalToolNames.has(tc.name),
      );

      // -- Handle blocked tools ----------------------------------------------
      if (blockedCalls.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: content || null,
            tool_calls: blockedCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
        for (const blocked of blockedCalls) {
          messages = [
            ...messages,
            {
              role: 'tool',
              content: `Error: Tool "${blocked.name}" is temporarily unavailable in this session.`,
              tool_call_id: blocked.id,
            },
          ];
        }
        continue;
      }

      // -- Handle hallucinated tools -----------------------------------------
      if (hallucinations.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
        for (const h of hallucinations) {
          messages = [
            ...messages,
            {
              role: 'tool',
              content: `Error: Tool "${h.name}" not found.`,
              tool_call_id: h.id,
            },
          ];
        }
        continue;
      }

      // -- Handle external tool calls ----------------------------------------
      if (validExternalCalls.length > 0) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            usage,
            timing: timingLog,
          },
        });
        return true;
      }

      // -- Execute internal MCP tool calls -----------------------------------
      if (content || internalCalls.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: content || null,
            tool_calls: internalCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
      }

      // Check tool call budget
      const remaining =
        maxToolCalls !== undefined
          ? maxToolCalls - toolCallCount
          : internalCalls.length;
      if (remaining <= 0) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        ctx.timing.push(...timingLog);
        ctx.yield({
          ok: true,
          value: {
            content: '',
            finishReason: 'length',
            usage,
            timing: timingLog,
          },
        });
        return true;
      }

      const batch = internalCalls.slice(0, remaining);

      // Yield progress messages
      for (const tc of batch) {
        ctx.yield({
          ok: true,
          value: { content: `\n\n[SmartAgent: Executing ${tc.name}...]\n` },
        });
      }

      // Execute tool calls concurrently with heartbeat
      const toolExecPromises = batch.map(async (tc) => {
        const toolStart = Date.now();
        ctx.options?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
          arguments: tc.arguments,
        });
        const client = ctx.toolClientMap.get(tc.name);
        if (!client) return { tc, text: '', res: null, duration: 0 };

        const toolSpan = ctx.tracer.startSpan('smart_agent.tool_call', {
          parent: parentSpan,
          attributes: { 'tool.name': tc.name },
        });
        const cached = ctx.toolCache.get(tc.name, tc.arguments);
        const res = cached
          ? (() => {
              ctx.metrics.toolCacheHitCount.add();
              toolSpan.setAttribute('cache', 'hit');
              return { ok: true as const, value: cached };
            })()
          : await (async () => {
              const r = await client.callTool(
                tc.name,
                tc.arguments,
                ctx.options,
              );
              if (r.ok) ctx.toolCache.set(tc.name, tc.arguments, r.value);
              return r;
            })();

        const text = !res.ok
          ? res.error.message
          : typeof res.value.content === 'string'
            ? res.value.content
            : JSON.stringify(res.value.content);
        toolSpan.setStatus(res.ok ? 'ok' : 'error', res.ok ? undefined : text);
        toolSpan.end();
        return { tc, text, res, duration: Date.now() - toolStart };
      });

      // Heartbeat while waiting for tools
      const allDone = Promise.all(toolExecPromises);
      const pendingTools = new Set(batch.map((tc) => tc.name));
      const toolStartTime = Date.now();
      // biome-ignore lint/suspicious/noExplicitAny: matches library types
      let results: any[] = [];
      let settled = false;
      for (const [i, p] of toolExecPromises.entries()) {
        p.then(() => pendingTools.delete(batch[i].name));
      }
      while (!settled) {
        const winner = await Promise.race([
          allDone.then((r) => ({ tag: 'done' as const, results: r })),
          new Promise<{ tag: 'tick' }>((resolve) =>
            setTimeout(() => resolve({ tag: 'tick' }), heartbeatMs),
          ),
        ]);
        if (winner.tag === 'done') {
          results = winner.results;
          settled = true;
        } else {
          for (const tool of pendingTools) {
            ctx.yield({
              ok: true,
              value: {
                content: '',
                heartbeat: { tool, elapsed: Date.now() - toolStartTime },
              },
            });
          }
        }
      }

      // Collect timing and process results
      for (const r of results) {
        timingLog.push({ phase: `tool_${r.tc.name}`, duration: r.duration });
      }

      // biome-ignore lint/suspicious/noExplicitAny: matching library Message type
      const toolMessages: any[] = [];
      for (const { tc, text, res } of results) {
        if (!res) continue;
        if (!res.ok && isToolContextUnavailableError(text)) {
          ctx.toolAvailabilityRegistry.block(ctx.sessionId, tc.name, text);
          currentTools = currentTools.filter((t) => t.name !== tc.name);
        }
        ctx.options?.sessionLogger?.logStep(`mcp_result_${tc.name}`, {
          result: text,
        });
        toolCallCount++;
        ctx.metrics.toolCallCount.add();
        toolMessages.push({
          role: 'tool',
          content: text,
          tool_call_id: tc.id,
        });
      }
      messages = [...messages, ...toolMessages];
    }
  }
}

/**
 * Structured pipeline definition — mirrors the default flow but uses
 * our custom tool-select handler with a dedicated 'tools' RAG store.
 *
 * Key difference from default: rag-query only queries facts/feedback/state.
 * The 'tools' store is queried exclusively by CustomToolSelectHandler,
 * keeping tool descriptions out of assembler's Known Facts section.
 *
 * Flow: classify → [summarize] → [rag-upsert] → [translate] → [expand] →
 *       [parallel rag-queries] → [rerank] → tool-select → skill-select →
 *       assemble → tool-loop
 */
const pipelineDefinition: StructuredPipelineDefinition = {
  version: '1',
  stages: [
    { id: 'classify', type: 'classify' },
    {
      id: 'summarize',
      type: 'summarize',
      when: 'config.historySummarizationLimit',
    },
    {
      id: 'rag-upsert',
      type: 'rag-upsert',
      when: 'config.ragUpsertEnabled',
    },
    // RAG retrieval: translate → expand → parallel queries → rerank
    // translate and expand must be sequential (both read/write ctx.ragText)
    { id: 'translate', type: 'translate', when: 'shouldRetrieve' },
    { id: 'expand', type: 'expand', when: 'shouldRetrieve' },
    {
      id: 'rag-queries',
      type: 'parallel',
      when: 'shouldRetrieve',
      stages: [
        {
          id: 'rag-facts',
          type: 'rag-query',
          config: { store: 'facts' },
        },
        {
          id: 'rag-feedback',
          type: 'rag-query',
          config: { store: 'feedback' },
        },
        {
          id: 'rag-state',
          type: 'rag-query',
          config: { store: 'state' },
        },
      ],
    },
    { id: 'rerank', type: 'rerank', when: 'shouldRetrieve' },
    // Custom tool-select: uses its own RAG store, not ctx.ragResults.facts
    { id: 'tool-select', type: 'tool-select' },
    { id: 'skill-select', type: 'skill-select' },
    { id: 'assemble', type: 'assemble' },
    { id: 'tool-loop', type: 'tool-loop' },
  ],
};

/** Per-destination SmartAgent handles */
const agentHandles = new Map<string, SmartAgentHandle>();

/** Runtime model override (null = use config default) */
let currentModel: string | null = null;

/** Shared LLM instances (updated on model switch) */
let sharedMainLlm: ReturnType<typeof makeLlm> | null = null;
let sharedClassifierLlm: ReturnType<typeof makeLlm> | null = null;

/** Check if at least one SmartAgent is initialized and ready */
export function isAgentReady(): boolean {
  return agentHandles.size > 0;
}

/** Get the model name currently used by the agent */
export function getCurrentModel(): string {
  return currentModel || getAgentConfig().llm.model;
}

/** Shared metrics instance (survives agent rebuilds) */
const metrics = new InMemoryMetrics();

/** Get agent metrics snapshot */
export function getAgentMetrics() {
  return metrics.snapshot();
}

// ---------------------------------------------------------------------------
// Multi-destination state management
// ---------------------------------------------------------------------------

/** Per-destination pre-built state for fast switching */
export interface DestinationState {
  mcpAdapter: McpClientAdapter | null;
  toolsRag: IRag;
  toolCount: number;
  status: 'pending' | 'ready' | 'vectorizing' | 'error' | 'unreachable';
  error?: string;
}

/** Map of destination name → pre-built state */
const destinationStates = new Map<string, DestinationState>();

/** Last-used destination per session (for detecting switches in openai-handler) */
const lastDestinationBySession = new Map<string, string>();

/** Get last-used destination for a session, or config default */
export function getCurrentDestination(sessionId?: string): string {
  if (sessionId) {
    return (
      lastDestinationBySession.get(sessionId) ||
      getAgentConfig().mcp.destination
    );
  }
  return getAgentConfig().mcp.destination;
}

/** Track which destination was used for a session */
export function setSessionDestination(
  sessionId: string,
  destination: string,
): void {
  lastDestinationBySession.set(sessionId, destination);
}

/** Get all destination states for API/UI consumption */
export function getDestinationStates(): Array<{
  name: string;
  status: string;
  toolCount: number;
  error?: string;
}> {
  return [...destinationStates.entries()].map(([name, state]) => ({
    name,
    status: state.status,
    toolCount: state.toolCount,
    error: state.error,
  }));
}

// ---------------------------------------------------------------------------
// Shared embedder + RAG stores (survive destination switches)
// ---------------------------------------------------------------------------

let sharedEmbedderBreaker: CircuitBreaker | null = null;
let sharedEmbedder: CircuitBreakerEmbedder | null = null;
let sharedRagStores: { facts: IRag; feedback: IRag; state: IRag } | null = null;

/** Get or create shared embedder (singleton) */
function getOrCreateEmbedder(resourceGroup?: string): {
  embedder: CircuitBreakerEmbedder;
  breaker: CircuitBreaker;
} | null {
  const config = getAgentConfig();
  if (config.agent.ragType === 'in-memory') return null;

  if (!sharedEmbedder) {
    const embeddingModel =
      process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small';
    sharedEmbedderBreaker = new CircuitBreaker({
      failureThreshold: 30,
      recoveryWindowMs: 60_000,
    });
    const rawEmbedder = new SapAiCoreEmbedder({
      model: embeddingModel,
      resourceGroup,
    });
    sharedEmbedder = new CircuitBreakerEmbedder(
      rawEmbedder,
      sharedEmbedderBreaker,
    );
  }

  return {
    embedder: sharedEmbedder,
    breaker: sharedEmbedderBreaker as NonNullable<typeof sharedEmbedderBreaker>,
  };
}

/** Create a tools RAG store (one per destination) */
function createToolsRagStore(resourceGroup?: string): IRag {
  const embedding = getOrCreateEmbedder(resourceGroup);
  if (!embedding) return new InMemoryRag();

  const toolsVectorRag = new VectorRag(embedding.embedder, {
    vectorWeight: 0.7,
    keywordWeight: 0.3,
  });
  return new FallbackRag(toolsVectorRag, new InMemoryRag(), embedding.breaker);
}

/** Get or create shared RAG stores (facts, feedback, state — persist across destination switches) */
function getOrCreateSharedRagStores(resourceGroup?: string): {
  facts: IRag;
  feedback: IRag;
  state: IRag;
} {
  if (sharedRagStores) return sharedRagStores;

  const embedding = getOrCreateEmbedder(resourceGroup);
  const facts = embedding
    ? new FallbackRag(
        new VectorRag(embedding.embedder, {
          vectorWeight: 0.7,
          keywordWeight: 0.3,
        }),
        new InMemoryRag(),
        embedding.breaker,
      )
    : new InMemoryRag();

  sharedRagStores = {
    facts,
    feedback: new NamespaceFilteredRag(),
    state: new NamespaceFilteredRag(),
  };

  return sharedRagStores;
}

// ---------------------------------------------------------------------------
// Tool vectorization (extracted for reuse across destinations)
// ---------------------------------------------------------------------------

/** Vectorize MCP tools into a RAG store */
async function vectorizeTools(
  mcpAdapter: McpClientAdapter,
  toolsStore: IRag,
  embedderBreaker: CircuitBreaker | null,
): Promise<{ ok: number; failed: number; total: number }> {
  const log = cds.log('agent-manager');

  const toolsResult = await mcpAdapter.listTools();
  if (!toolsResult.ok) {
    throw new Error('MCP listTools failed — cannot vectorize tools');
  }

  const tools = toolsResult.value;
  const maxRetries = 3;
  const throttleMs = 50;

  const toolEntries = tools.map((t) => {
    const paramNames = Object.keys(
      (t.inputSchema as { properties?: Record<string, unknown> })?.properties ??
        {},
    ).join(', ');
    return {
      name: t.name,
      text: [
        `Tool: ${t.name}`,
        `Description: ${t.description}`,
        paramNames ? `Parameters: ${paramNames}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  });

  let pending = toolEntries;
  let totalOk = 0;

  for (
    let attempt = 0;
    attempt <= maxRetries && pending.length > 0;
    attempt++
  ) {
    if (attempt > 0) {
      const waitMs = 65_000;
      log.info(
        `Vectorization retry ${attempt}/${maxRetries}: waiting ${waitMs}ms, ${pending.length} tools remaining`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      embedderBreaker?.recordSuccess();
    }

    const failed: typeof pending = [];
    for (const t of pending) {
      const res = await toolsStore.upsert(t.text, { id: `tool:${t.name}` });
      if (res.ok) {
        totalOk++;
      } else {
        failed.push(t);
      }
      if (throttleMs > 0) {
        await new Promise((r) => setTimeout(r, throttleMs));
      }
    }
    pending = failed;

    if (pending.length > 0) {
      log.warn(
        `Vectorization attempt ${attempt}: ${failed.length} failed, ${totalOk} succeeded`,
        { embedderBreakerState: embedderBreaker?.state ?? 'n/a' },
      );
    }
  }

  if (pending.length > 0) {
    log.error('Tool vectorization incomplete', {
      failedCount: pending.length,
      failedTools: pending.map((t) => t.name).slice(0, 20),
      totalTools: tools.length,
      successCount: totalOk,
    });
  }

  log.info('Vectorized MCP tools', {
    toolCount: tools.length,
    upsertOk: totalOk,
    embedderBreakerState: embedderBreaker?.state ?? 'n/a',
  });

  return { ok: totalOk, failed: pending.length, total: tools.length };
}

// ---------------------------------------------------------------------------
// Per-destination initialization
// ---------------------------------------------------------------------------

/**
 * Initialize a single destination: build MCP adapter, vectorize tools, build SmartAgent.
 * Updates destinationStates map and agentHandles map.
 */
async function initDestination(
  destinationName: string,
): Promise<DestinationState> {
  const log = cds.log('agent-manager');
  const config = getAgentConfig();

  log.info('Initializing destination', { destination: destinationName });

  const state: DestinationState = {
    mcpAdapter: null,
    toolsRag: createToolsRagStore(config.llm.resourceGroup),
    toolCount: 0,
    status: 'vectorizing',
  };
  destinationStates.set(destinationName, state);

  try {
    state.mcpAdapter = await buildEmbeddedMcpAdapter(destinationName);

    const embedding = getOrCreateEmbedder(config.llm.resourceGroup);
    const result = await vectorizeTools(
      state.mcpAdapter,
      state.toolsRag,
      embedding?.breaker ?? null,
    );
    state.toolCount = result.ok;

    // Build a full SmartAgent for this destination
    const handle = await buildAgentForDestination(
      state.mcpAdapter,
      state.toolsRag,
      config,
    );
    agentHandles.set(destinationName, handle);

    state.status = 'ready';
    log.info('Destination ready', {
      destination: destinationName,
      toolCount: state.toolCount,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    state.error = errorMsg;
    // Distinguish unreachable (probe failed) from other init errors
    if (errorMsg.includes('unreachable')) {
      state.status = 'unreachable';
      log.warn('Destination unreachable, skipping', {
        destination: destinationName,
        error: errorMsg,
      });
    } else {
      state.status = 'error';
      log.error('Destination initialization failed', {
        destination: destinationName,
        error: errorMsg,
      });
    }
  }

  return state;
}

/**
 * Initialize remaining destinations in background (after primary is ready).
 * Fetches available SAP destinations from BTP Destination Service and
 * vectorizes each one's MCP tools into a separate RAG store.
 */
async function initBackgroundDestinations(): Promise<void> {
  const log = cds.log('agent-manager');

  try {
    const destinations = await getAvailableDestinations();
    const primaryDest = getAgentConfig().mcp.destination;
    const others = destinations.filter((d) => d.name !== primaryDest);

    if (others.length === 0) {
      log.info('No additional destinations to initialize');
      return;
    }

    log.info('Starting background destination initialization', {
      destinations: others.map((d) => d.name),
    });

    // Register all destinations as 'pending' immediately so UI sees the full list
    for (const dest of others) {
      if (!destinationStates.has(dest.name)) {
        destinationStates.set(dest.name, {
          mcpAdapter: null,
          toolsRag: new InMemoryRag(),
          toolCount: 0,
          status: 'pending',
        });
      }
    }

    // Sequential: each destination does embedding calls, avoid overwhelming API
    for (const dest of others) {
      const state = destinationStates.get(dest.name);
      if (state?.status === 'ready') continue;
      await initDestination(dest.name);
    }

    const states = [...destinationStates.values()];
    log.info('Background destination initialization complete', {
      total: destinationStates.size,
      ready: states.filter((s) => s.status === 'ready').length,
      unreachable: states.filter((s) => s.status === 'unreachable').length,
      errors: states.filter((s) => s.status === 'error').length,
    });

    // Schedule periodic retry for unreachable destinations
    scheduleUnreachableRetry();
  } catch (err) {
    log.warn('Background destination initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Periodically retry unreachable destinations (every 5 min) */
const UNREACHABLE_RETRY_INTERVAL_MS = 5 * 60 * 1000;
let unreachableRetryTimer: ReturnType<typeof setInterval> | null = null;

function scheduleUnreachableRetry(): void {
  if (unreachableRetryTimer) return;
  const log = cds.log('agent-manager');

  unreachableRetryTimer = setInterval(async () => {
    const unreachable = [...destinationStates.entries()].filter(
      ([, s]) => s.status === 'unreachable',
    );
    if (unreachable.length === 0) {
      // All destinations reachable — stop retrying
      if (unreachableRetryTimer) {
        clearInterval(unreachableRetryTimer);
        unreachableRetryTimer = null;
      }
      return;
    }

    log.info('Retrying unreachable destinations', {
      destinations: unreachable.map(([name]) => name),
    });

    for (const [name] of unreachable) {
      await initDestination(name);
      const state = destinationStates.get(name);
      if (state?.status === 'ready') {
        log.info('Previously unreachable destination is now ready', {
          destination: name,
          toolCount: state.toolCount,
        });
      }
    }
  }, UNREACHABLE_RETRY_INTERVAL_MS);
}

/**
 * Build embedded MCP client (in-process, no HTTP).
 *
 * Uses HandlerExporter to get tool definitions and handlers directly,
 * then wraps them in MCPClientWrapper with `transport: 'embedded'`.
 * Connection is resolved from BTP Destination and injected as handler context.
 */
async function buildEmbeddedMcpAdapter(
  destinationName: string,
): Promise<McpClientAdapter> {
  const log = cds.log('agent-manager');

  // Resolve destination to get SAP connection config
  const resolved = await resolveDestinationSapConfig(destinationName);
  const connection = createConnection({
    sapConfig: resolved.sapConfig,
    destinationName: resolved.destinationName,
  });

  // Probe: verify SAP system is reachable before building the full MCP adapter
  const PROBE_TIMEOUT_MS = 15_000;
  const abapConn =
    connection as unknown as import('@mcp-abap-adt/interfaces').IAbapConnection;
  try {
    const probeResult = await abapConn.makeAdtRequest({
      url: '/sap/bc/adt/discovery',
      method: 'GET',
      timeout: PROBE_TIMEOUT_MS,
    });
    if (probeResult.status >= 500) {
      throw new Error(`SAP system returned HTTP ${probeResult.status}`);
    }
    log.info('Destination probe OK', {
      destination: destinationName,
      status: probeResult.status,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Destination "${destinationName}" is unreachable: ${msg}`);
  }

  // Get MCP tool handlers filtered by configured exposition (handler sets)
  const config = getAgentConfig();
  const expo = config.agent.exposition;
  const exporter = new HandlerExporter({
    includeReadOnly: expo.includes('readonly'),
    includeHighLevel: expo.includes('high'),
    includeLowLevel: expo.includes('low'),
    includeCompact: expo.includes('compact'),
    includeSystem: expo.includes('system'),
    includeSearch: expo.includes('search'),
    logger: loggerAdapter,
  });

  const entries = exporter.getHandlerEntries();

  // Handler context with injected connection
  const context: HandlerContext = {
    connection:
      connection as unknown as import('@mcp-abap-adt/interfaces').IAbapConnection,
    logger: loggerAdapter,
  };

  // Inject real connection into handler groups so closure-based handlers (handler.length === 1)
  // use our connection instead of dummyContext (connection: null).
  // HandlerExporter creates groups with dummyContext; BaseMcpServer.registerHandlers() fixes this
  // by setting group.context before calling, but we bypass that — so we do it here.
  // biome-ignore lint/suspicious/noExplicitAny: accessing private handlerGroups field
  const handlerGroups = (exporter as any).handlerGroups as Array<{
    context: HandlerContext;
  }>;
  if (handlerGroups) {
    for (const group of handlerGroups) {
      group.context = context;
    }
  }

  // Build handler map (handlers now use updated group.context via closure)
  const handlerMap = new Map(
    entries.map((e) => [e.toolDefinition.name, e.handler]),
  );

  log.info('Building embedded MCP client', {
    destination: destinationName,
    connectionType: connection.constructor.name,
    toolCount: entries.length,
    tools: exporter.getToolNames(),
  });

  // Use embedded transport — direct in-process handler calls
  const mcpClient = new MCPClientWrapper({
    transport: 'embedded',
    listToolsHandler: async () =>
      entries.map((e) => ({
        name: e.toolDefinition.name,
        description: e.toolDefinition.description,
        inputSchema: toJsonSchema(e.toolDefinition.inputSchema),
      })),
    callToolHandler: async (name, args) => {
      const handler = handlerMap.get(name);
      if (!handler) {
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      try {
        // Handlers from HandlerExporter have two signatures:
        // - length >= 2: (context, args) => ... (direct handlers)
        // - length === 1: (args) => ... (closure-based, uses group.context)
        // Match BaseMcpServer.registerHandlers() logic (line 283-301)
        const toolCall =
          handler.length >= 2
            ? handler(context, args)
            : (handler as unknown as (a: typeof args) => unknown)(args);

        // Timeout: prevent hanging when SAP system doesn't respond (e.g. after destination switch)
        const MCP_TOOL_TIMEOUT_MS = 60_000;
        const result = await Promise.race([
          toolCall,
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `MCP tool "${name}" timed out after ${MCP_TOOL_TIMEOUT_MS / 1000}s`,
                  ),
                ),
              MCP_TOOL_TIMEOUT_MS,
            ),
          ),
        ]);

        const resultStr = JSON.stringify(result).slice(0, 1000);
        log.info('MCP tool call', {
          destination: destinationName,
          tool: name,
          handlerType: handler.length >= 2 ? 'direct' : 'closure',
          argsKeys: Object.keys(args || {}),
          args: JSON.stringify(args).slice(0, 300),
          resultLength: resultStr.length,
          resultPreview: resultStr.slice(0, 500),
        });
        return result;
      } catch (err) {
        log.error('MCP tool call failed', {
          tool: name,
          args: JSON.stringify(args).slice(0, 500),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  });

  // connect() populates internal tools list from listToolsHandler
  await mcpClient.connect();

  return new McpClientAdapter(mcpClient);
}

/** Create shared LLM instances (called once, reused across all agents) */
function getOrCreateSharedLlms(config: AgentConfig): {
  mainLlm: ReturnType<typeof makeLlm>;
  classifierLlm: ReturnType<typeof makeLlm>;
} {
  if (!sharedMainLlm) {
    const mainModel = getCurrentModel();
    sharedMainLlm = makeLlm(
      {
        provider: 'sap-ai-sdk',
        apiKey: 'sap-ai-sdk-managed',
        model: mainModel,
        temperature: config.llm.temperature,
        maxTokens: config.llm.maxTokens,
        resourceGroup: config.llm.resourceGroup,
      },
      config.llm.temperature,
    );
  }
  if (!sharedClassifierLlm) {
    const classifierModel =
      process.env.LLM_AGENT_CLASSIFIER_MODEL || config.llm.model;
    sharedClassifierLlm = makeLlm(
      {
        provider: 'sap-ai-sdk',
        apiKey: 'sap-ai-sdk-managed',
        model: classifierModel,
        maxTokens: config.llm.maxTokens,
        resourceGroup: config.llm.resourceGroup,
      },
      0.1,
    );
  }
  return { mainLlm: sharedMainLlm, classifierLlm: sharedClassifierLlm };
}

/**
 * Build a SmartAgent for a specific destination.
 * Shares LLM, embedder, facts/feedback/state RAG, metrics across all agents.
 */
async function buildAgentForDestination(
  mcpAdapter: McpClientAdapter,
  toolsRag: IRag,
  config: AgentConfig,
): Promise<SmartAgentHandle> {
  const log = cds.log('agent-manager');
  const { mainLlm, classifierLlm } = getOrCreateSharedLlms(config);
  const shared = getOrCreateSharedRagStores(config.llm.resourceGroup);

  const ragStores: Record<string, IRag> = {
    tools: toolsRag,
    facts: shared.facts,
    feedback: shared.feedback,
    state: shared.state,
  };

  const builder = new SmartAgentBuilder({
    agent: {
      maxIterations: config.agent.maxIterations,
      mode: config.agent.mode,
      refreshToolsPerIteration: false,
    },
    prompts: {
      system: [
        'You are an SAP ABAP expert assistant connected to a live SAP system via MCP (Model Context Protocol) tools.',
        'You MUST use MCP tools to answer any questions about SAP objects, tables, packages, classes, programs, or system data.',
        'Never guess or provide generic answers when MCP tools are available — always query the SAP system.',
        'When the user asks about SAP objects (tables, packages, classes, function modules, etc.), use SearchObject or other relevant MCP tools to find them.',
        '',
        '## ABAP Object Creation Workflow',
        'Creating an ABAP object is ALWAYS a two-step process:',
        '1. Create* tool (e.g., CreateClass) — creates an empty shell with metadata only',
        '2. Update* tool (e.g., UpdateClass) — sets the actual source code',
        'You MUST call both steps. Never stop after Create* — the object is useless without source code from Update*.',
        'If Create* fails with "already exists", use the corresponding Update* tool to modify the existing object.',
        '',
        'Respond in the same language the user writes in.',
      ].join('\n'),
      classifier: [
        'You are a semantic intent classifier. Decompose the user message into logical tasks.',
        'Output ONLY a raw JSON array — no markdown fences, no explanation, no surrounding text.',
        'Each task is an object with these fields:',
        '  "type": one of "action", "fact", "chat", "feedback", "state"',
        '  "text": the task description (copy from user message)',
        '  "context": "sap-abap" if SAP/ABAP terms present, otherwise "general"',
        '  "dependency": "independent" or "sequential"',
        '',
        'Rules:',
        '- Multi-step requests: split into separate objects with "sequential" dependency',
        '- Independent tasks: separate objects with "independent" dependency',
        '- Greetings, math, jokes: type "chat"',
        '- SAP keywords (table, class, program, transport, ABAP, CDS, BAPI, etc.): context "sap-abap"',
        '',
        'Example input: "Read table MARA and tell me a joke"',
        'Example output: [{"type":"action","text":"Read table MARA","context":"sap-abap","dependency":"independent"},{"type":"chat","text":"Tell a joke","context":"general","dependency":"independent"}]',
      ].join('\n'),
    },
  })
    .withMainLlm(mainLlm)
    .withClassifierLlm(classifierLlm)
    .withMcpClients([mcpAdapter])
    .withRag(ragStores)
    .withRagTranslation(true)
    .withRagUpsert(true)
    .withPipeline(pipelineDefinition)
    .withStageHandler('classify', new CustomClassifyHandler())
    .withStageHandler('rag-upsert', new CustomRagUpsertHandler())
    .withStageHandler('tool-select', new CustomToolSelectHandler())
    .withStageHandler('tool-loop', new CustomToolLoopHandler())
    .withToolCache(new ToolCache())
    .withMetrics(metrics)
    .withSessionManager(new SessionManager({ tokenBudget: 8000 }))
    .withHistorySummarization(20)
    .withClientAdapter(new ClineClientAdapter());

  const handle = await builder.build();

  // Diagnostic: confirm structured pipeline is active
  // biome-ignore lint/suspicious/noExplicitAny: diagnostic access to private fields
  const agentObj = handle.agent as any;
  log.info('SmartAgent pipeline diagnostic', {
    hasPipelineExecutor: !!agentObj.pipelineExecutor,
    hasPipelineStages: !!agentObj.pipelineStages,
    stageCount: agentObj.pipelineStages?.length ?? 0,
    stageIds: agentObj.pipelineStages?.map((s: { id: string }) => s.id) ?? [],
    ragStoreKeys: Object.keys(handle.ragStores),
  });

  return handle;
}

/**
 * Get SmartAgent handle for a destination.
 *
 * Each destination has its own SmartAgent with isolated MCP connection.
 * Shared resources: LLM, embedder, facts/feedback/state RAG, metrics.
 */
export async function getSmartAgent(
  requestedModel?: string,
  requestedDestination?: string,
): Promise<SmartAgentHandle> {
  const log = cds.log('agent-manager');
  const config = getAgentConfig();

  // --- Model hot-swap (updates all agents — LLM is stateless) ---
  const activeModel = getCurrentModel();
  if (
    requestedModel &&
    requestedModel !== activeModel &&
    agentHandles.size > 0
  ) {
    const newLlm = makeLlm(
      {
        provider: 'sap-ai-sdk',
        apiKey: 'sap-ai-sdk-managed',
        model: requestedModel,
        temperature: config.llm.temperature,
        maxTokens: config.llm.maxTokens,
        resourceGroup: config.llm.resourceGroup,
      },
      config.llm.temperature,
    );

    for (const handle of agentHandles.values()) {
      // biome-ignore lint/suspicious/noExplicitAny: accessing internal deps for model hot-swap
      (handle.agent as any).deps.mainLlm = newLlm;
    }
    sharedMainLlm = newLlm;
    currentModel = requestedModel;

    log.info('Model hot-swapped across all agents', {
      from: activeModel,
      to: requestedModel,
      agentCount: agentHandles.size,
    });
  }

  // --- Destination lookup (no hot-swap — each dest has its own agent) ---
  const destName = requestedDestination || config.mcp.destination;
  const handle = agentHandles.get(destName);

  if (handle) {
    return handle;
  }

  // Destination not ready — check why
  const destState = destinationStates.get(destName);
  const status = destState?.status ?? 'unknown';
  log.warn('Requested destination has no agent', {
    destination: destName,
    status,
  });
  throw new Error(
    `Destination "${destName}" is not ready (status: ${status}). Please wait for initialization to complete.`,
  );
}

/**
 * Initialize the primary destination and start background init for others.
 * Called once from server.ts on startup.
 */
export async function initSmartAgents(): Promise<void> {
  const log = cds.log('agent-manager');
  const config = getAgentConfig();
  const destName = config.mcp.destination;

  log.info('Initializing primary destination', {
    destination: destName,
    model: getCurrentModel(),
    embeddingModel:
      process.env.LLM_AGENT_EMBEDDING_MODEL || 'text-embedding-3-small',
    mode: config.agent.mode,
  });

  // Initialize primary destination (blocking — must be ready before serving)
  await initDestination(destName);

  const handle = agentHandles.get(destName);
  if (!handle) {
    throw new Error(`Primary destination "${destName}" failed to initialize`);
  }

  // Run health check in background
  (async () => {
    try {
      const res = await handle.agent.healthCheck();
      if (res.ok) {
        const v = res.value;
        const mcpStatus =
          v.mcp.length === 0
            ? 'NONE'
            : v.mcp.every((m) => m.ok)
              ? 'OK'
              : 'PARTIAL/FAIL';
        log.info('SmartAgent health check', {
          destination: destName,
          llm: v.llm ? 'OK' : 'FAIL',
          rag: v.rag ? 'OK' : 'FAIL',
          mcp: mcpStatus,
        });
      } else {
        log.warn('SmartAgent health check failed', {
          error: res.error.message,
        });
      }
    } catch (e) {
      log.warn('SmartAgent health check error', { error: String(e) });
    }
  })();

  log.info('SmartAgent ready', {
    destination: destName,
    model: getCurrentModel(),
  });

  // Background: initialize remaining SAP destinations (non-blocking)
  initBackgroundDestinations().catch((err) => {
    log.warn('Background destination init error', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Gracefully close all SmartAgents (call on shutdown)
 */
export async function closeSmartAgent(): Promise<void> {
  const log = cds.log('agent-manager');
  for (const [dest, handle] of agentHandles) {
    log.info('Closing SmartAgent', { destination: dest });
    await handle.close().catch((err) => {
      log.warn('Failed to close SmartAgent', {
        destination: dest,
        error: String(err),
      });
    });
  }
  agentHandles.clear();
}

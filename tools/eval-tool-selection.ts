import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryEmbedding, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import type { EmbedderConfig } from '../srv/agent-config';
import {
  getSharedCorpusDocs,
  type ToolEmbeddingBundle,
} from '../srv/agent-manager';
import { buildEmbedding, prefetchEmbedder } from '../srv/lib/providers';
import { createRagStoreFactory } from '../srv/lib/rag-store-factory';
import { collectionFor, fingerprintHash } from '../srv/lib/tool-corpus';
import { selectStepTools } from '../srv/lib/tool-selection';

type SelectionCase = { q: string; exp: string; writes: boolean };

async function main() {
  const args = process.argv.slice(2);
  const keyword = args.includes('--keyword');
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--'))
      throw new Error(`${flag} requires a value`);
    return args[index + 1];
  };
  const positive = (flag: string, fallback: number) => {
    const raw = option(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`${flag} must be a positive integer`);
    return value;
  };
  // Same defaults as the hub (LLM_AGENT_TOOLS_K_READER / _K_WRITER).
  const kReader = positive('--k-reader', 2);
  const kWriter = positive('--k-writer', 1);
  const file = option('--bundle') ?? 'srv/tool-embeddings.json';
  const bundle: ToolEmbeddingBundle = JSON.parse(
    readFileSync(resolve(file), 'utf8'),
  );
  const docs = getSharedCorpusDocs();
  const definitions = new Map(docs.map((doc) => [doc.id, doc]));
  const vectors = new Map(bundle.entries.map((entry) => [entry.id, entry]));
  const fp = bundle.header.embedderFingerprint;
  const backend = option('--store') ?? (keyword ? 'in-memory' : 'vector');
  if (backend !== 'in-memory' && backend !== 'vector' && backend !== 'qdrant')
    throw new Error('Invalid --store');
  const provider =
    option('--embedder') ??
    (keyword
      ? 'none'
      : fp.provider === 'sap-ai-sdk'
        ? 'sap-ai-core'
        : fp.provider);
  if (!['none', 'ollama', 'openai', 'sap-ai-core'].includes(provider))
    throw new Error('Invalid --embedder');
  const config: EmbedderConfig | null =
    provider === 'none'
      ? null
      : {
          kind: z.enum(['ollama', 'openai', 'sap-ai-core']).parse(provider),
          model: option('--model') ?? fp.embeddingModel,
          url: option('--embedder-url') ?? fp.baseURL,
          resourceGroup: fp.resourceGroup,
          apiKey: process.env.OPENAI_API_KEY,
        };
  await prefetchEmbedder(config);
  const embedding = buildEmbedding(config);
  const retrieval = embedding?.retrieval;
  const factory = createRagStoreFactory(
    {
      embedder: config,
      backends: {
        tools: backend,
        session: 'in-memory',
        persistent: 'in-memory',
      },
      qdrant: {
        url: option('--url') ?? 'http://127.0.0.1:6333',
        apiKey: process.env.QDRANT_API_KEY,
        prefix: `tool-selection-eval-${randomUUID()}`,
      },
    },
    embedding,
  );
  const stores = {
    reader: factory.create('tools', 'reader'),
    writer: factory.create('tools', 'writer'),
  };
  const precomputed =
    embedding && fingerprintHash(embedding.fingerprint) === fingerprintHash(fp);
  let precomputedCount = 0;
  try {
    for (const doc of docs) {
      const writer = stores[collectionFor(doc.readOnlyHint)].writer?.();
      if (!writer) throw new Error('Store is not writable');
      const metadata = {
        exposition: doc.exposition,
        readOnlyHint: doc.readOnlyHint,
        name: doc.name,
      };
      const bundled = vectors.get(doc.id);
      const writeVector =
        precomputed && bundled?.text === doc.text
          ? writer.upsertPrecomputedRaw
          : undefined;
      const result =
        !writeVector || !bundled
          ? await writer.upsertRaw(doc.id, doc.text, metadata)
          : await writeVector(doc.id, doc.text, bundled.vector, metadata);
      if (!result?.ok) throw new Error(`Cannot load ${doc.name}`);
      if (writeVector) precomputedCount++;
    }
    for (const role of ['reader', 'writer'] as const) {
      const ready = await factory.awaitWrites('tools', role);
      if (!ready.ok) throw new Error(`Store ${role}: ${ready.error}`);
    }
    const cases: SelectionCase[] = z
      .array(
        z.object({
          q: z.string(),
          exp: z.string(),
          writes: z.boolean(),
        }),
      )
      .length(91)
      .parse(
        JSON.parse(
          readFileSync(resolve('tools/eval/tool-selection-cases.json'), 'utf8'),
        ),
      );
    for (const item of cases) {
      const doc = definitions.get(`tool:${item.exp}`);
      if (
        !doc ||
        item.writes !== (collectionFor(doc.readOnlyHint) === 'writer')
      )
        throw new Error(
          `Case effect differs from tool definition: ${item.exp}`,
        );
    }
    console.log(
      `Bundle: ${file}; store: ${backend}; embedder: ${provider}; cases: ${cases.length}`,
    );
    console.log(
      `Corpus: ${docs.length}; precomputed: ${precomputedCount}; raw: ${docs.length - precomputedCount}. Step-kind uses oracle writes (no LLM).`,
    );
    const retrieved = new Map<
      string,
      import('@mcp-abap-adt/llm-agent').RagResult[]
    >();
    const summaries: {
      strategy: string;
      kind: string;
      hits: string;
      avg: string;
      max: number;
      count: number;
      hitCount: number;
      toolCount: number;
    }[] = [];
    for (const strategy of ['per-collection', 'step-kind'] as const) {
      console.log(`Strategy: ${strategy}`);
      for (const writes of [false, true]) {
        let hits = 0;
        const sizes: number[] = [];
        const misses: string[] = [];
        for (const item of cases.filter((item) => item.writes === writes)) {
          const embedding = retrieval
            ? new QueryEmbedding(item.q, retrieval)
            : new TextOnlyEmbedding(item.q);
          const parts = retrieved.has(item.q)
            ? []
            : await Promise.all([
                stores.reader.query(embedding, 6),
                stores.writer.query(embedding, 3),
              ]);
          const rows =
            retrieved.get(item.q) ??
            parts.flatMap((part) => {
              if (!part.ok) throw new Error('Query failed');
              return part.value;
            });
          retrieved.set(item.q, rows);
          const selected = selectStepTools(
            rows,
            docs,
            writes,
            true,
            () => true,
            kReader,
            kWriter,
            strategy,
          );
          sizes.push(selected.length);
          if (selected.some((row) => row.metadata.id === `tool:${item.exp}`))
            hits++;
          else
            misses.push(
              `${item.q} -> ${item.exp}; top hits: ${(
                ['reader', 'writer'] as const
              )
                .map(
                  (role) =>
                    `${role}: ${rows
                      .filter(
                        (row) =>
                          collectionFor(
                            typeof row.metadata.readOnlyHint === 'boolean'
                              ? row.metadata.readOnlyHint
                              : definitions.get(String(row.metadata.id))
                                  ?.readOnlyHint,
                          ) === role,
                      )
                      .sort((a, b) => b.score - a.score)
                      .slice(0, 3)
                      .map(
                        (row) => `${row.metadata.id} (${row.score.toFixed(3)})`,
                      )
                      .join(', ')}`,
                )
                .join('; ')}`,
            );
        }
        summaries.push({
          strategy,
          kind: writes ? 'RW' : 'RO',
          hits: `${hits}/${sizes.length}`,
          avg: (sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2),
          max: Math.max(...sizes),
          count: sizes.length,
          hitCount: hits,
          toolCount: sizes.reduce((a, b) => a + b, 0),
        });
        console.log(
          `${writes ? 'RW' : 'RO'}: hits ${hits}/${sizes.length}; avg tools ${(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2)}; max tools ${Math.max(...sizes)}`,
        );
        for (const miss of misses) console.log(`  MISS ${miss}`);
      }
      const parts = summaries.filter((row) => row.strategy === strategy);
      const count = parts.reduce((sum, row) => sum + row.count, 0);
      const hitCount = parts.reduce((sum, row) => sum + row.hitCount, 0);
      const toolCount = parts.reduce((sum, row) => sum + row.toolCount, 0);
      summaries.push({
        strategy,
        kind: 'TOTAL',
        hits: `${hitCount}/${count}`,
        avg: (toolCount / count).toFixed(2),
        max: Math.max(...parts.map((row) => row.max)),
        count,
        hitCount,
        toolCount,
      });
    }
    console.table(
      ['RO', 'RW', 'TOTAL'].map((kind) => {
        const perCollection = summaries.find(
          (row) => row.kind === kind && row.strategy === 'per-collection',
        );
        const stepKind = summaries.find(
          (row) => row.kind === kind && row.strategy === 'step-kind',
        );
        if (!perCollection || !stepKind)
          throw new Error('Incomplete evaluation');
        return {
          kind,
          'per-collection hits': perCollection.hits,
          'per-collection avg/max': `${perCollection.avg}/${perCollection.max}`,
          'step-kind hits': stepKind.hits,
          'step-kind avg/max': `${stepKind.avg}/${stepKind.max}`,
        };
      }),
    );
    const [winner] = summaries
      .filter((row) => row.kind === 'TOTAL')
      .sort(
        (a, b) =>
          b.hitCount - a.hitCount ||
          a.toolCount / a.count - b.toolCount / b.count,
      );
    console.log(
      `Measured choice (total hits, then average tools): ${winner.strategy}`,
    );
  } finally {
    // A unique prefix confines cleanup to this evaluation's stores.
    if (factory.backendOf('tools') === 'qdrant') {
      for (const role of ['reader', 'writer'] as const) {
        const removed = await factory.deleteStore('tools', role);
        if (!removed.ok)
          console.error(`Cannot remove evaluation store: ${removed.error}`);
      }
    }
  }
}
main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

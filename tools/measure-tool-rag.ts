/**
 * Tool retrieval: hit rate and latency for the configured tools backend.
 * Run twice — LLM_AGENT_TOOLS_RAG_BACKEND=vector, then =qdrant — after the build
 * step for each, and compare. Spec §6 "Speed".
 *
 * Queries are issued exactly as `ExpositionFilteringRag.query` (srv/agent-manager.ts)
 * expects: `ragFilter.exposition` is the caller's GRANTED exposition levels
 * (`ExpositionLevel[]`, from `resolveExposition`), not a bare group name. Each
 * query round is run once per MCP role tier — `MCP_Reader` (reader collection
 * only) and `MCP_Developer` (reader + writer collections merged, the same way
 * `grantsWriteLevel` routes it in production) — so the measurement exercises
 * both role-scoped stores the way a real request does.
 *
 * Both backends are measured WITHOUT a query preprocessor: `qdrant` has none
 * (it relies on a multilingual embedder, spec §4.7), so `vector` is loaded
 * with `translateQueries: false` too — otherwise its non-ASCII queries would
 * each pay an LLM translation call and the two would not be comparable.
 * Results are reported for the whole set and for the ASCII and non-ASCII
 * query subsets separately.
 *
 *   npx tsx tools/measure-tool-rag.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QueryEmbedding } from '@mcp-abap-adt/llm-agent';
import { loadAgentConfig } from '../srv/agent-config';
import {
  getSharedCorpusDocs,
  initProviders,
  loadToolCorpus,
} from '../srv/agent-manager';
import { resolveExposition } from '../srv/lib/exposition';
import { startProviders } from '../srv/lib/providers';

const K = 15;
type Q = { q: string; expect: string[] };

// Same two tiers `resolveExposition` produces in production (srv/lib/exposition.ts):
// MCP_Reader/MCP_Analyst grant only the reader collection; MCP_Developer/MCP_Full
// additionally grant the writer collection (merged with reader in the result).
const ROLE_TIERS = ['MCP_Reader', 'MCP_Developer'] as const;

async function main() {
  const queries = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'tool-rag-queries.json'), 'utf8'),
  ) as Q[];
  const config = loadAgentConfig();
  const p = await startProviders(config);
  initProviders(p);
  if (!p.embedding)
    throw new Error(
      'measure needs an embedder (tools backend vector or qdrant)',
    );
  const { store } = await loadToolCorpus(p, getSharedCorpusDocs(), {
    translateQueries: false,
  });
  const runs: { ascii: boolean; ms: number; hit: boolean }[] = [];
  const misses: { q: string; role: string; expect: string[] }[] = [];
  for (const { q, expect } of queries) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range
    const ascii = /^[\x00-\x7f]*$/.test(q);
    for (const role of ROLE_TIERS) {
      const exposition = resolveExposition([role]);
      const t0 = performance.now();
      const r = await store.query(
        new QueryEmbedding(q, p.embedding.retrieval),
        K,
        {
          ragFilter: { exposition },
        },
      );
      const ms = performance.now() - t0;
      if (!r.ok) throw r.error;
      const names = r.value.map((x) =>
        String(x.metadata.id ?? '').replace(/^tool:/, ''),
      );
      const hit = names.some((n) => expect.includes(n));
      runs.push({ ascii, ms, hit });
      if (!hit) misses.push({ q, role, expect });
    }
  }
  const summary = (set: string, rows: typeof runs) => {
    const times = rows.map((r) => r.ms).sort((a, b) => a - b);
    const pct = (x: number) =>
      times.length
        ? times[
            Math.min(times.length - 1, Math.floor(x * times.length))
          ].toFixed(1)
        : null;
    return {
      backend: config.rag.backends.tools,
      set,
      queries: rows.length,
      hits: rows.filter((r) => r.hit).length,
      p50ms: pct(0.5),
      p95ms: pct(0.95),
    };
  };
  for (const [set, rows] of [
    ['whole', runs],
    ['ascii', runs.filter((r) => r.ascii)],
    ['non-ascii', runs.filter((r) => !r.ascii)],
  ] as const)
    console.log(JSON.stringify(summary(set, rows)));
  if (misses.length) {
    console.error(`misses (${misses.length}):`);
    for (const m of misses) {
      console.error(
        `  [${m.role}] "${m.q}" expected one of: ${m.expect.join(', ')}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * Tool retrieval: accuracy and latency for the configured tools backend.
 *
 * Queries are issued exactly as `ExpositionFilteringRag.query` (srv/agent-manager.ts)
 * expects: `ragFilter.exposition` is the caller's GRANTED exposition levels
 * (`ExpositionLevel[]`, from `resolveExposition`), not a bare group name. Each
 * query round is run once per MCP role tier — `MCP_Reader` (reader collection
 * only) and `MCP_Developer` (reader + writer collections, each capped at k and
 * concatenated, the same way `capPerCollection` builds it in production).
 *
 * Every backend is measured WITHOUT a query preprocessor (`translateQueries:
 * false`), so non-ASCII queries test the embedder, not an LLM translation.
 *
 * Labels (tools/tool-rag-queries.json), per query:
 *   - `relevant`: every tool that is a correct/useful answer.
 *   - `required`: AND of OR-groups — each group is one step the query needs,
 *     listing the interchangeable tools for it (e.g. ReadClass | GetClass).
 *   - `expect`: legacy any-one-of list, kept for compatibility, unused here.
 * A (query, role) pair where some required group has NO tool the role can see
 * is STRUCTURAL: no retrieval can answer it, so it is counted apart and left
 * out of every quality metric.
 *
 * Cut-offs:
 *   - K5/K10/K15: one production query per k (the store caps each collection
 *     at k and concatenates, so a deep query cannot be re-cut afterwards).
 *   - thresholds: the K15 result, keeping only rows with score >= t. The three
 *     t are the 25th/50th/75th percentiles of the scores of RELEVANT tools in
 *     the K15 results (non-structural rows), i.e. derived per embedder.
 *
 * Metrics per cut and set (whole / ascii / non-ascii), non-structural rows only:
 *   hit = >=1 relevant returned; reqRecall = every required group satisfied;
 *   recall = relevant returned / relevant visible to the role;
 *   precision = relevant returned / returned, over rows that returned any;
 *   empty = share of rows that returned nothing; avgRet = tools returned;
 *   MRR = 1/rank of the first relevant tool in the returned list ordered by
 *   score (0 when none); p50/p95 latency of the query that produced the cut.
 *
 *   npx tsx tools/measure-tool-rag.ts
 *   TOOL_RAG_MEASURE_OUT=/path/detail.json npx tsx tools/measure-tool-rag.ts
 *   TOOL_RAG_QUERIES=/path/other-queries.json npx tsx tools/measure-tool-rag.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QueryEmbedding, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { loadAgentConfig } from '../srv/agent-config';
import {
  getSharedCorpusDocs,
  initProviders,
  loadToolCorpus,
} from '../srv/agent-manager';
import { resolveExposition } from '../srv/lib/exposition';
import { startProviders } from '../srv/lib/providers';

const CUTS = [5, 10, 15] as const;
const THRESHOLD_PCTS = [0.25, 0.5, 0.75] as const;
type Q = {
  q: string;
  expect: string[];
  relevant: string[];
  required: string[][];
  multi?: boolean;
};

// Same two tiers `resolveExposition` produces in production (srv/lib/exposition.ts):
// MCP_Reader/MCP_Analyst grant only the reader collection; MCP_Developer/MCP_Full
// additionally grant the writer collection.
const ROLE_TIERS = ['MCP_Reader', 'MCP_Developer'] as const;

type Hit = { id: string; score: number };
type Row = {
  q: string;
  role: string;
  ascii: boolean;
  multi: boolean;
  structural: boolean;
  relevant: string[];
  required: string[][];
  visibleRelevant: string[];
  /** Tools returned per cut, in production order (reader first, then writer). */
  byK: Record<number, { hits: Hit[]; ms: number }>;
};
type CutMetrics = {
  hit: number;
  reqRecall: number;
  recall: number;
  precision: number;
  empty: number;
  avgRet: number;
  mrr: number;
  p50ms: number | null;
  p95ms: number | null;
};

const toolName = (id: unknown) => String(id ?? '').replace(/^tool:/, '');
const pctOf = (sorted: number[], p: number) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    : null;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function metrics(
  rows: Row[],
  pick: (r: Row) => { hits: Hit[]; ms: number },
): CutMetrics {
  let hit = 0;
  let req = 0;
  let recall = 0;
  let precision = 0;
  let nonEmpty = 0;
  let ret = 0;
  let mrr = 0;
  const times: number[] = [];
  for (const r of rows) {
    const { hits, ms } = pick(r);
    times.push(ms);
    const got = new Set(hits.map((h) => h.id));
    const rel = new Set(r.relevant);
    const relGot = [...got].filter((id) => rel.has(id)).length;
    if (relGot > 0) hit++;
    if (r.required.every((g) => g.some((id) => got.has(id)))) req++;
    recall += r.visibleRelevant.length ? relGot / r.visibleRelevant.length : 0;
    if (hits.length) {
      precision += relGot / hits.length;
      nonEmpty++;
    }
    ret += hits.length;
    const ranked = [...hits].sort((a, b) => b.score - a.score);
    const first = ranked.findIndex((h) => rel.has(h.id));
    mrr += first >= 0 ? 1 / (first + 1) : 0;
  }
  const n = rows.length || 1;
  times.sort((a, b) => a - b);
  const p50 = pctOf(times, 0.5);
  const p95 = pctOf(times, 0.95);
  return {
    hit: r3(hit / n),
    reqRecall: r3(req / n),
    recall: r3(recall / n),
    precision: r3(precision / (nonEmpty || 1)),
    empty: r3((rows.length - nonEmpty) / n),
    avgRet: Math.round((ret / n) * 10) / 10,
    mrr: r3(mrr / n),
    p50ms: p50 === null ? null : Math.round(p50 * 10) / 10,
    p95ms: p95 === null ? null : Math.round(p95 * 10) / 10,
  };
}

async function main() {
  const queries = JSON.parse(
    fs.readFileSync(
      process.env.TOOL_RAG_QUERIES ??
        path.join(__dirname, 'tool-rag-queries.json'),
      'utf8',
    ),
  ) as Q[];
  const config = loadAgentConfig();
  const p = await startProviders(config);
  initProviders(p);
  // in-memory (keyword) has no embedder: queries go in as text only.
  const embedding = p.embedding;
  const asQuery = (q: string) =>
    embedding
      ? new QueryEmbedding(q, embedding.retrieval)
      : new TextOnlyEmbedding(q);
  const docs = getSharedCorpusDocs();
  const exposition = new Map(docs.map((d) => [d.name, d.exposition]));
  // A label naming a tool the corpus does not have can never be satisfied —
  // fail loudly instead of reporting it as a retrieval miss.
  const unknown = queries.flatMap(({ q, relevant, required }) =>
    [...relevant, ...required.flat()]
      .filter((t) => !exposition.has(t))
      .map((t) => `${t} (in "${q}")`),
  );
  const notRelevant = queries.flatMap(({ q, relevant, required }) =>
    required
      .flat()
      .filter((t) => !relevant.includes(t))
      .map((t) => `${t} (in "${q}")`),
  );
  if (unknown.length || notRelevant.length)
    throw new Error(
      `bad labels — unknown tools: ${unknown.join(', ') || 'none'}; ` +
        `required but not relevant: ${notRelevant.join(', ') || 'none'}`,
    );
  const { store } = await loadToolCorpus(p, docs, { translateQueries: false });

  const rows: Row[] = [];
  for (const { q, relevant, required, multi } of queries) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range
    const ascii = /^[\x00-\x7f]*$/.test(q);
    for (const role of ROLE_TIERS) {
      const granted = resolveExposition([role]);
      const visible = (t: string) =>
        granted.includes(exposition.get(t) as (typeof granted)[number]);
      const byK: Row['byK'] = {};
      for (const k of CUTS) {
        const t0 = performance.now();
        const r = await store.query(asQuery(q), k, {
          ragFilter: { exposition: granted },
        });
        const ms = performance.now() - t0;
        if (!r.ok) throw r.error;
        byK[k] = {
          ms,
          hits: r.value
            .filter((x) => !String(x.metadata.id ?? '').startsWith('skill:'))
            .map((x) => ({ id: toolName(x.metadata.id), score: x.score })),
        };
      }
      rows.push({
        q,
        role,
        ascii,
        multi: !!multi,
        structural: !required.every((g) => g.some(visible)),
        relevant,
        required,
        visibleRelevant: relevant.filter(visible),
        byK,
      });
    }
  }

  const quality = rows.filter((r) => !r.structural);
  const relScores = quality
    .flatMap((r) =>
      r.byK[15].hits
        .filter((h) => r.relevant.includes(h.id))
        .map((h) => h.score),
    )
    .sort((a, b) => a - b);
  const allScores = quality
    .flatMap((r) => r.byK[15].hits.map((h) => h.score))
    .sort((a, b) => a - b);
  const thresholds = THRESHOLD_PCTS.map((p) => pctOf(relScores, p) ?? 0);

  const cuts: [string, (r: Row) => { hits: Hit[]; ms: number }][] = [
    ...CUTS.map(
      (k) =>
        [`K${k}`, (r: Row) => r.byK[k]] as [
          string,
          (r: Row) => Row['byK'][number],
        ],
    ),
    ...thresholds.map(
      (t, i) =>
        [
          `t${THRESHOLD_PCTS[i] * 100}`,
          (r: Row) => ({
            ms: r.byK[15].ms,
            hits: r.byK[15].hits.filter((h) => h.score >= t),
          }),
        ] as [string, (r: Row) => Row['byK'][number]],
    ),
  ];

  const embedder = config.rag.embedder
    ? `${config.rag.embedder.kind}:${config.rag.embedder.model}`
    : 'none (keyword)';
  const sets: [string, (r: Row) => boolean][] = [
    ['whole', () => true],
    ['ascii', (r) => r.ascii],
    ['non-ascii', (r) => !r.ascii],
    ['single', (r) => !r.multi],
    ['multi', (r) => r.multi],
  ];
  const report = {
    backend: config.rag.backends.tools,
    embedder,
    queries: rows.length,
    structural: rows.filter((r) => r.structural).length,
    thresholds: Object.fromEntries(
      thresholds.map((t, i) => [`t${THRESHOLD_PCTS[i] * 100}`, r3(t)]),
    ),
    relevantScoreRange: [r3(relScores[0] ?? 0), r3(relScores.at(-1) ?? 0)],
    returnedScorePercentiles: Object.fromEntries(
      [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => [
        `p${p * 100}`,
        r3(pctOf(allScores, p) ?? 0),
      ]),
    ),
    sets: Object.fromEntries(
      sets.map(([name, inSet]) => {
        const subset = quality.filter(inSet);
        return [
          name,
          {
            n: subset.length,
            structural: rows.filter((r) => r.structural && inSet(r)).length,
            cuts: Object.fromEntries(
              cuts.map(([label, pick]) => [label, metrics(subset, pick)]),
            ),
          },
        ];
      }),
    ),
  };
  console.log(JSON.stringify(report, null, 2));

  // Per-query failures at K15: a required group nothing satisfied.
  const failures = quality.filter(
    (r) =>
      !r.required.every((g) =>
        g.some((id) => r.byK[15].hits.some((h) => h.id === id)),
      ),
  );
  if (failures.length) {
    console.error(`required-recall misses at K15 (${failures.length}):`);
    for (const r of failures) {
      const got = new Set(r.byK[15].hits.map((h) => h.id));
      const missing = r.required
        .filter((g) => !g.some((id) => got.has(id)))
        .map((g) => g.join('|'));
      console.error(`  [${r.role}] "${r.q}" missing: ${missing.join(', ')}`);
    }
  }
  const out = process.env.TOOL_RAG_MEASURE_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify({ report, rows }, null, 1));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

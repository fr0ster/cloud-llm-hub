import type { IRagProvider, RunRecord } from '@mcp-abap-adt/llm-agent';
import type { RagConfig } from '../../srv/agent-config';
import type { RagCtors } from '../../srv/lib/rag-provider-factory';
import {
  createRunRecordStore,
  MemoryRunRecordStore,
  ProviderRunRecordStore,
  RUN_OUTPUT_CHAR_LIMIT,
} from '../../srv/lib/run-record-store';
import { loadSessionConfig } from '../../srv/lib/session-config';
import { scopedStore } from './helpers/scoped-run-store';

const record = (runId = 'r'): RunRecord => ({
  runId,
  request: 'hello',
  plan: { steps: [], createdAt: 1 },
  steps: [
    {
      stepId: 's',
      kind: 'work',
      run: 1,
      status: 'done',
      output: 'x'.repeat(5000),
      durationMs: 1,
    },
  ],
  outcome: 'answered',
  finishedAt: 2,
});
it('memory store keeps only the last record per session', async () => {
  const s = scopedStore(new MemoryRunRecordStore(2));
  await s.save('a', record());
  await s.save('a', record('last'));
  expect((await s.load('a'))?.runId).toBe('last');
  expect(await s.load('other')).toBeUndefined();
});
it('outputs are cut to 4000 chars on save without mutating the caller', async () => {
  const s = scopedStore(new MemoryRunRecordStore(2));
  const r = record();
  await s.save('a', r);
  expect((await s.load('a'))?.steps[0].output).toHaveLength(
    RUN_OUTPUT_CHAR_LIMIT,
  );
  expect(r.steps[0].output).toHaveLength(5000);
  const loaded = await s.load('a');
  loaded?.plan.steps.push({ id: 'changed', kind: 'answer' });
  expect((await s.load('a'))?.plan.steps).toEqual([]);
});
it('delete removes the record', async () => {
  const s = scopedStore(new MemoryRunRecordStore(2));
  await s.save('a', record());
  await s.delete('a');
  expect(await s.load('a')).toBeUndefined();
});
it('memory store is bounded and evicts the oldest saved record', async () => {
  const s = scopedStore(new MemoryRunRecordStore(2));
  await s.save('a', record());
  await s.save('b', record());
  await s.save('a', record());
  await s.save('c', record());
  expect(await s.load('b')).toBeUndefined();
  expect(await s.load('a')).toBeDefined();
  expect(await s.load('c')).toBeDefined();
});

it.each(['none', 'sqlite'])(
  'factory uses bounded memory for %s',
  async (store) => {
    const cfg = loadSessionConfig({
      LLM_AGENT_SESSION_STORE: store,
      LLM_AGENT_MAX_SESSIONS: '1',
      LLM_AGENT_MAX_SESSIONS_PER_USER: '1',
    });
    const s = scopedStore(createRunRecordStore(cfg));
    expect(createRunRecordStore(cfg)).toBeInstanceOf(MemoryRunRecordStore);
    await s.save('first', record());
    await s.save('second', record());
    expect(await s.load('first')).toBeUndefined();
  },
);
it.each(['pg-vector', 'hana-vector'])(
  'factory selects %s provider without an embedder call',
  async (store) => {
    const constructed: {
      kind: string;
      cfg: { embedder: { embedDocument(t: string): Promise<unknown> } };
    }[] = [];
    const ctor = (kind: string) =>
      function (this: unknown, cfg: never) {
        constructed.push({ kind, cfg });
      };
    const ctors = {
      PgVectorRagProvider: ctor('pg-vector'),
      HanaVectorRagProvider: ctor('hana-vector'),
      QdrantRagProvider: ctor('qdrant'),
    } as unknown as RagCtors;
    const rag: RagConfig = {
      embedder: null,
      backends: {
        tools: 'in-memory',
        session: 'in-memory',
        persistent: 'in-memory',
      },
      pg: { url: 'postgres://localhost/db', user: 'u', password: 'p' },
    };
    const cfg = loadSessionConfig({ LLM_AGENT_SESSION_STORE: store });
    const env =
      store === 'hana-vector'
        ? {
            VCAP_SERVICES: JSON.stringify({
              hana: [
                {
                  name: 'hana',
                  credentials: {
                    schema: 'TEST',
                    host: 'localhost',
                    port: '30015',
                    user: 'u',
                    password: 'p',
                  },
                },
              ],
            }),
          }
        : {};
    expect(createRunRecordStore(cfg, rag, env, ctors)).toBeInstanceOf(
      ProviderRunRecordStore,
    );
    expect(constructed[0].kind).toBe(store);
    await expect(
      constructed[0].cfg.embedder.embedDocument('x'),
    ).rejects.toThrow('run records are never embedded');
  },
);
it('provider refuses a writer that cannot write zero vectors', async () => {
  const upsertRaw = jest.fn();
  const rag = {
    query: jest.fn(),
    getById: jest.fn(),
    healthCheck: jest.fn(),
    scan: jest.fn(),
    writer: () => ({ upsertRaw, deleteByIdRaw: jest.fn() }),
  };
  const p = {
    name: 'bad',
    createCollection: async () => ({ ok: true, value: { rag, editor: {} } }),
  } as unknown as IRagProvider;
  await expect(
    scopedStore(new ProviderRunRecordStore(p, { dimension: 4 })).save(
      'a',
      record(),
    ),
  ).rejects.toThrow('upsertPrecomputedRaw');
  expect(upsertRaw).not.toHaveBeenCalled();
});

it('startup schedules a guarded non-blocking durable sweep', async () => {
  const { initializeRunRecordStore, sweepRunRecords } = await import(
    '../../srv/lib/run-record-store'
  );
  const sweep = jest
    .spyOn(ProviderRunRecordStore.prototype, 'sweepExpired')
    .mockRejectedValue(new Error('offline'));
  const rag: RagConfig = {
    embedder: null,
    backends: {
      tools: 'in-memory',
      session: 'in-memory',
      persistent: 'in-memory',
    },
    pg: { url: 'postgres://localhost/db', user: 'u', password: 'p' },
  };
  try {
    expect(() =>
      initializeRunRecordStore(
        loadSessionConfig({ LLM_AGENT_SESSION_STORE: 'pg-vector' }),
        rag,
      ),
    ).not.toThrow();
    expect(sweep).toHaveBeenCalledWith(expect.any(Number));
    await new Promise<void>((resolve) => setImmediate(resolve));
    sweep.mockResolvedValue();
    await sweepRunRecords();
    expect(sweep).toHaveBeenCalledTimes(2);
  } finally {
    sweep.mockRestore();
    initializeRunRecordStore(
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: 'none' }),
    );
  }
});

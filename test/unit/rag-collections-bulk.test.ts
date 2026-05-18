jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      })),
    },
  }),
  // jest.config.ts maps @sap/cds to a types-only package. Keep this mock
  // virtual so Jest does not try to resolve that package at runtime.
  { virtual: true },
);

import cds from '@sap/cds';
import { CollectionRegistry } from '../../srv/rag-collections';

type WriterScript = Array<{ ok: true } | { ok: false; error: Error }>;

/**
 * Build a CollectionRegistry whose RAG backend is a tiny scripted stub.
 * Each call to upsertRaw consumes the next entry from `script` (last entry
 * is reused if exhausted). Counters of upsertRaw calls are exposed for
 * assertions.
 */
async function makeRegistry(
  script: WriterScript,
  byId?: Map<string, WriterScript>,
) {
  const callsById = new Map<string, number>();
  const writer = {
    upsertRaw: async (id: string, _text: string, _meta: unknown) => {
      callsById.set(id, (callsById.get(id) ?? 0) + 1);
      // Per-id script wins over global script
      const perId = byId?.get(id);
      const s = perId ?? script;
      const idx = Math.min((callsById.get(id) ?? 1) - 1, s.length - 1);
      const next = s[idx];
      if (next.ok) return { ok: true as const, value: undefined };
      return { ok: false as const, error: next.error };
    },
    deleteByIdRaw: async () => ({ ok: true as const, value: true }),
  };
  const ragStub = {
    writer: () => writer,
    upsert: async (text: string, metadata: any) => {
      const { id, ...rest } = metadata;
      const r = await writer.upsertRaw(id, text, rest);
      return r.ok ? { ok: true as const, value: { id } } : r;
    },
    query: async () => ({ ok: true as const, value: [] }),
    getById: async () => ({ ok: true as const, value: null }),
    healthCheck: async () => ({ ok: true as const, value: undefined }),
    deleteById: async () => ({ ok: true as const, value: true }),
  };
  const registry = new CollectionRegistry(undefined as any);
  (registry as any).createRagStore = () => ragStub;
  registry.createCollection({
    id: 'test',
    displayName: 'Test',
    description: 'Test collection',
    scope: 'user',
    backend: 'mem',
  } as any);
  return { registry, callsById };
}

import { isTransient, tryWithRetry } from '../../srv/rag-collections';

describe('addDocument (Result-aware)', () => {
  it('persists the document when upsert succeeds', async () => {
    const { registry } = await makeRegistry([{ ok: true }]);
    const doc = await (registry as any).addDocument('test', {
      id: 'a-0',
      text: 'hello',
      metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
    });
    expect(doc.id).toBe('a-0');
    expect(doc.createdAt).toBeDefined();
  });

  it('throws when upsert returns Result.ok=false', async () => {
    const { registry } = await makeRegistry([
      {
        ok: false,
        error: new Error('Qdrant upsert failed: 503 Service Unavailable'),
      },
    ]);
    await expect(
      (registry as any).addDocument('test', {
        id: 'a-0',
        text: 'hello',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
      }),
    ).rejects.toThrow(/503/);
  });

  it('does NOT persist the document when upsert fails', async () => {
    const { registry } = await makeRegistry([
      { ok: false, error: new Error('Qdrant upsert failed: 401') },
    ]);
    await expect(
      (registry as any).addDocument('test', {
        id: 'a-0',
        text: 'hello',
        metadata: { source: 'a.md', chunkIndex: 0, totalChunks: 1 },
      }),
    ).rejects.toThrow();
    // The stored.documents map must not contain a-0
    const stored = (registry as any).collections.get('test');
    expect(stored.documents.has('a-0')).toBe(false);
  });
});

describe('isTransient', () => {
  it('classifies HTTP 429 as transient', () => {
    expect(
      isTransient(new Error('Qdrant upsert failed: 429 Too Many Requests')),
    ).toBe(true);
  });
  it('classifies HTTP 503/504 as transient', () => {
    expect(
      isTransient(new Error('Qdrant upsert failed: 503 Service Unavailable')),
    ).toBe(true);
    expect(
      isTransient(new Error('Qdrant upsert failed: 504 Gateway Timeout')),
    ).toBe(true);
  });
  it('classifies ECONNRESET / ETIMEDOUT / timeout as transient', () => {
    expect(isTransient(new Error('connect ECONNRESET 10.0.0.1:443'))).toBe(
      true,
    );
    expect(isTransient(new Error('request ETIMEDOUT'))).toBe(true);
    expect(isTransient(new Error('upstream timeout'))).toBe(true);
  });
  it('classifies "rate limit" / "rate-limit" phrases as transient', () => {
    expect(isTransient(new Error('OpenAI: rate limit exceeded'))).toBe(true);
    expect(isTransient(new Error('AI Core: rate-limit hit'))).toBe(true);
  });
  it('treats HTTP 4xx (non-429) as permanent', () => {
    expect(
      isTransient(new Error('Qdrant upsert failed: 400 Bad Request')),
    ).toBe(false);
    expect(
      isTransient(new Error('Qdrant upsert failed: 401 Unauthorized')),
    ).toBe(false);
    expect(isTransient(new Error('Qdrant upsert failed: 404 Not Found'))).toBe(
      false,
    );
  });
  it('treats unrecognized errors as permanent (conservative)', () => {
    expect(isTransient(new Error('something opaque'))).toBe(false);
    expect(isTransient(null as unknown as Error)).toBe(false);
    expect(isTransient(undefined as unknown as Error)).toBe(false);
  });
  it('considers err.code / err.status / err.statusCode fields', () => {
    const e1 = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
    expect(isTransient(e1)).toBe(true);
    const e2 = Object.assign(new Error('boom'), { status: 503 });
    expect(isTransient(e2)).toBe(true);
    const e3 = Object.assign(new Error('boom'), { statusCode: 429 });
    expect(isTransient(e3)).toBe(true);
  });
  it('classifies wrapped RagError by message — UPSERT_ERROR code alone is not enough', () => {
    // The UPSERT_ERROR code covers both transient (HTTP 5xx in body) and
    // permanent (validation) cases — classification must come from message.
    const t1 = Object.assign(
      new Error('Error: Request failed with status code 503'),
      { code: 'UPSERT_ERROR' },
    );
    const t2 = Object.assign(
      new Error('Error: Request failed with status code 500'),
      { code: 'UPSERT_ERROR' },
    );
    const t3 = Object.assign(new Error('502 Bad Gateway'), {
      code: 'UPSERT_ERROR',
    });
    expect(isTransient(t1)).toBe(true);
    expect(isTransient(t2)).toBe(true);
    expect(isTransient(t3)).toBe(true);

    const p1 = Object.assign(new Error('validation failed: max length 500'), {
      code: 'UPSERT_ERROR',
    });
    const p2 = Object.assign(new Error('validation failed'), {
      code: 'UPSERT_ERROR',
    });
    expect(isTransient(p1)).toBe(false);
    expect(isTransient(p2)).toBe(false);
  });
});

describe('tryWithRetry', () => {
  function sleeper() {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    return { sleep, sleeps };
  }

  it('succeeds on first attempt — no sleep', async () => {
    const { sleep, sleeps } = sleeper();
    const fn = jest.fn().mockResolvedValue('ok');
    const res = await tryWithRetry(fn, { sleep });
    expect(res).toEqual({ ok: true, value: 'ok' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('retries on transient then succeeds — records backoffs', async () => {
    const { sleep, sleeps } = sleeper();
    let n = 0;
    const fn = jest.fn().mockImplementation(async () => {
      n += 1;
      if (n < 3)
        throw new Error('Qdrant upsert failed: 503 Service Unavailable');
      return 'ok';
    });
    const res = await tryWithRetry(fn, { sleep });
    expect(res).toEqual({ ok: true, value: 'ok' });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([200, 500]);
  });

  it('exhausts retries on persistent transient — returns failure', async () => {
    const { sleep, sleeps } = sleeper();
    const fn = jest
      .fn()
      .mockRejectedValue(
        new Error('Qdrant upsert failed: 503 Service Unavailable'),
      );
    const res = await tryWithRetry(fn, { sleep });
    expect(res.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([200, 500, 1500]);
  });

  it('does not retry permanent errors', async () => {
    const { sleep, sleeps } = sleeper();
    const fn = jest
      .fn()
      .mockRejectedValue(new Error('Qdrant upsert failed: 401'));
    const res = await tryWithRetry(fn, { sleep });
    expect(res.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('canSleep=false blocks further retry without calling onSleep', async () => {
    const { sleep, sleeps } = sleeper();
    const onSleep = jest.fn();
    const fn = jest
      .fn()
      .mockRejectedValue(
        new Error('Qdrant upsert failed: 503 Service Unavailable'),
      );
    const res = await tryWithRetry(fn, {
      sleep,
      canSleep: () => false,
      onSleep,
    });
    expect(res.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1); // only initial attempt
    expect(sleeps).toEqual([]);
    expect(onSleep).not.toHaveBeenCalled();
  });

  it('onSleep is called before each backoff sleep', async () => {
    const { sleep, sleeps } = sleeper();
    const onSleepCalls: number[] = [];
    const onSleep = (ms: number) => onSleepCalls.push(ms);
    const fn = jest
      .fn()
      .mockRejectedValue(
        new Error('Qdrant upsert failed: 503 Service Unavailable'),
      );
    const res = await tryWithRetry(fn, { sleep, onSleep });
    expect(res.ok).toBe(false);
    expect(onSleepCalls).toEqual([200, 500, 1500]);
    expect(sleeps).toEqual([200, 500, 1500]);
  });
});

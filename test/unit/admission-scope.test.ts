import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  createCallRegister,
  currentAdmission,
  runWithAdmission,
  trackCall,
} from '../../srv/lib/admission-scope';
import { trackedLlm } from '../../srv/lib/tracked-llm';

function register() {
  const set = new Set<Promise<unknown>>();
  return {
    set,
    track<T>(p: Promise<T>): Promise<T> {
      set.add(p);
      p.then(
        () => set.delete(p),
        () => set.delete(p),
      );
      return p;
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('trackCall', () => {
  it('registers a call started inside the scope, before it is awaited', async () => {
    const reg = register();
    const call = deferred<string>();
    await runWithAdmission(reg, async () => {
      void trackCall(call.promise);
    });
    // Registered at dispatch. Written after the await, an aborted caller would
    // free the slot on top of a call still running.
    expect(reg.set.size).toBe(1);
    call.resolve('done');
    await tick();
    expect(reg.set.size).toBe(0);
  });

  it('registers nothing with no scope', async () => {
    expect(currentAdmission()).toBeUndefined();
    await expect(trackCall(Promise.resolve(1))).resolves.toBe(1);
  });

  it('keeps two pipelines apart', async () => {
    const a = register();
    const b = register();
    const call = deferred<void>();
    await runWithAdmission(a, async () => {
      void trackCall(call.promise);
    });
    expect(a.set.size).toBe(1);
    expect(b.set.size).toBe(0);
    call.resolve();
  });
});

describe('createCallRegister', () => {
  it('drains only after every tracked call settles, rejected ones included', async () => {
    const reg = createCallRegister();
    const ok = deferred<void>();
    let fail!: (e: Error) => void;
    void reg.track(ok.promise);
    reg.track(new Promise<void>((_, j) => (fail = j))).catch(() => {});
    expect(reg.outstanding).toBe(2);
    let drained = false;
    void reg.drain().then(() => (drained = true));
    ok.resolve();
    await tick();
    expect(drained).toBe(false);
    fail(new Error('x'));
    await tick();
    expect(drained).toBe(true);
  });

  it('drains at once when empty', async () => {
    await expect(createCallRegister().drain()).resolves.toBeUndefined();
  });
});

describe('trackedLlm', () => {
  function fakeLlm(chat: Promise<unknown>, chunks: unknown[] = []): ILlm {
    return {
      model: 'm',
      chat: () => chat as ReturnType<ILlm['chat']>,
      async *streamChat() {
        for (const c of chunks) yield c as never;
      },
    };
  }

  it('registers a model call for as long as it is pending', async () => {
    const reg = register();
    const call = deferred<unknown>();
    const llm = trackedLlm(fakeLlm(call.promise));
    await runWithAdmission(reg, async () => {
      void llm.chat([]);
    });
    expect(reg.set.size).toBe(1);
    call.resolve({ ok: true, value: { content: '' } });
    await tick();
    expect(reg.set.size).toBe(0);
  });

  it('registers a stream until it ends, and when the reader stops early', async () => {
    const reg = register();
    const llm = trackedLlm(fakeLlm(Promise.resolve(), [1, 2, 3]));
    await runWithAdmission(reg, async () => {
      for await (const _ of llm.streamChat([])) {
        expect(reg.set.size).toBe(1);
        break;
      }
    });
    await tick();
    expect(reg.set.size).toBe(0);
  });

  it('keeps the model name', () => {
    expect(trackedLlm(fakeLlm(Promise.resolve())).model).toBe('m');
  });
});

describe('the calls that dispatch are the ones that register', () => {
  const src = readFileSync(
    join(__dirname, '../../srv/agent-manager.ts'),
    'utf8',
  );

  it('wraps every LLM this service constructs', () => {
    const made = src.match(/makeLlm\(/g)?.length ?? 0;
    const wrapped = src.match(/trackedLlm\(/g)?.length ?? 0;
    expect(made).toBeGreaterThan(0);
    // Each construction site passes its result through trackedLlm: directly, or
    // via `.then(trackedLlm)` which the second pattern counts.
    const thenWrapped = src.match(/\.then\(\s*trackedLlm\s*\)/g)?.length ?? 0;
    expect(wrapped + thenWrapped).toBe(made);
  });

  it('tracks the embedded tool dispatch', () => {
    expect(src).toMatch(
      /await\s+trackCall\(\s*Promise\.resolve\(\s*toolCall\s*\)\s*\)/,
    );
  });
});

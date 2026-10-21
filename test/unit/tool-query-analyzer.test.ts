import { QueryEmbedding, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { ExpositionFilteringRag } from '../../srv/agent-manager';
import {
  createCallRegister,
  runWithAdmission,
} from '../../srv/lib/admission-scope';
import { ToolQueryAnalyzer } from '../../srv/lib/tool-query-analyzer';

const original = 'Створи домен для таблиці';
const translated = 'Create a domain for the table';
const llmWith = (chat: jest.Mock) => ({ chat }) as any;

describe('ToolQueryAnalyzer', () => {
  it('constructs the classifier LLM only when needed and reuses it', async () => {
    const chat = jest.fn().mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          translation: translated,
          needsAbapSystem: true,
        }),
      },
    });
    const factory = jest.fn().mockResolvedValue(llmWith(chat));
    const translator = new ToolQueryAnalyzer(factory);
    expect(factory).not.toHaveBeenCalled();
    await translator.analyze('Create a domain');
    expect(factory).toHaveBeenCalledTimes(1);
    await translator.analyze(original);
    await translator.analyze(`${original}?`);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('skips requests shorter than three characters', async () => {
    const chat = jest.fn();
    expect(await new ToolQueryAnalyzer(llmWith(chat)).analyze('hi')).toEqual({
      text: 'hi',
      needsAbapSystem: true,
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it.each([
    'abc',
    'Zeige die Felder der Tabelle MARA',
    'pokazhy polya tablytsi MARA',
  ])('uses the single model call translation for %s', async (text) => {
    const chat = jest.fn().mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          translation: translated,
          needsAbapSystem: true,
        }),
      },
    });
    expect(await new ToolQueryAnalyzer(llmWith(chat)).analyze(text)).toEqual({
      text: translated,
      needsAbapSystem: true,
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('trims and caches translations, sharing concurrent calls', async () => {
    const chat = jest.fn().mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          translation: ` ${translated} `,
          needsAbapSystem: true,
        }),
      },
    });
    const translator = new ToolQueryAnalyzer(llmWith(chat));
    expect(
      await Promise.all([
        translator.analyze(original),
        translator.analyze(original),
      ]),
    ).toEqual([
      { text: translated, needsAbapSystem: true },
      { text: translated, needsAbapSystem: true },
    ]);
    expect(await translator.analyze(original)).toEqual({
      text: translated,
      needsAbapSystem: true,
    });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'error', 'empty'])(
    'falls back to original text on %s',
    async (kind) => {
      const chat =
        kind === 'throw'
          ? jest.fn().mockRejectedValue(new Error('offline'))
          : jest
              .fn()
              .mockResolvedValue(
                kind === 'error'
                  ? { ok: false, error: new Error('offline') }
                  : { ok: true, value: { content: '  ' } },
              );
      expect(
        await new ToolQueryAnalyzer(llmWith(chat)).analyze(original),
      ).toEqual({ text: original, needsAbapSystem: true });
    },
  );

  it('does not cache a failed translation: the next query tries again', async () => {
    const chat = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        ok: true,
        value: {
          content: JSON.stringify({
            translation: translated,
            needsAbapSystem: true,
          }),
        },
      });
    const translator = new ToolQueryAnalyzer(llmWith(chat));
    expect(await translator.analyze(original)).toEqual({
      text: original,
      needsAbapSystem: true,
    });
    expect(await translator.analyze(original)).toEqual({
      text: translated,
      needsAbapSystem: true,
    });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('asks a failed LLM factory again on the next query', async () => {
    const chat = jest.fn().mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          translation: translated,
          needsAbapSystem: true,
        }),
      },
    });
    const factory = jest
      .fn()
      .mockRejectedValueOnce(new Error('no credentials yet'))
      .mockResolvedValue(llmWith(chat));
    const translator = new ToolQueryAnalyzer(factory);
    expect(await translator.analyze(original)).toEqual({
      text: original,
      needsAbapSystem: true,
    });
    expect(await translator.analyze(original)).toEqual({
      text: translated,
      needsAbapSystem: true,
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used translation after 500 entries', async () => {
    const chat = jest.fn().mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          translation: translated,
          needsAbapSystem: true,
        }),
      },
    });
    const translator = new ToolQueryAnalyzer(llmWith(chat));
    for (let i = 0; i < 500; i++) await translator.analyze(`${original}${i}`);
    await translator.analyze(`${original}0`);
    await translator.analyze(`${original}500`);
    await translator.analyze(`${original}0`);
    expect(chat).toHaveBeenCalledTimes(501);
    await translator.analyze(`${original}1`);
    expect(chat).toHaveBeenCalledTimes(502);
  });
});

describe('tool-only query translation', () => {
  const store = () => ({
    query: jest.fn().mockResolvedValue({ ok: true, value: [] }),
  });

  it.each([false, true])(
    'translates every tool collection and preserves history and collection text (embedder: %s)',
    async (vectors) => {
      const reader = store();
      const writer = store();
      const skills = store();
      const history = store();
      const collection = store();
      const chat = jest.fn().mockResolvedValue({
        ok: true,
        value: {
          content: JSON.stringify({
            translation: translated,
            needsAbapSystem: true,
          }),
        },
      });
      const embedder = {
        embedQuery: jest.fn().mockResolvedValue({ vector: [1] }),
      };
      const rag = new ExpositionFilteringRag(
        reader as any,
        writer as any,
        skills as any,
        3,
        new ToolQueryAnalyzer(llmWith(chat)),
        vectors ? embedder : undefined,
      );
      const embedding = new TextOnlyEmbedding(original);
      await Promise.all([
        rag.query(embedding, 10, { ragFilter: { exposition: ['high'] } }),
        history.query(embedding),
        collection.query(embedding),
      ]);
      for (const backend of [reader, writer, skills]) {
        const searched = backend.query.mock.calls[0][0];
        expect(searched.text).toBe(translated);
        expect(searched).toBeInstanceOf(
          vectors ? QueryEmbedding : TextOnlyEmbedding,
        );
        if (vectors) expect(await searched.toVector()).toEqual([1]);
      }
      expect(embedding.text).toBe(original);
      expect(history.query.mock.calls[0][0].text).toBe(original);
      expect(collection.query.mock.calls[0][0].text).toBe(original);
      expect(embedder.embedQuery).toHaveBeenCalledTimes(vectors ? 1 : 0);
    },
  );
});

describe('analyzer deadline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it.each(['factory', 'chat'])(
    'bounds unresolved %s and clears pending for retry',
    async (stage) => {
      const chat = jest.fn(
        (_messages?: any, _tools?: any, _options?: any) =>
          new Promise<any>(() => {}),
      );
      const factory = jest.fn(() =>
        stage === 'factory'
          ? new Promise<any>(() => {})
          : Promise.resolve(llmWith(chat)),
      );
      const analyzer = new ToolQueryAnalyzer(factory, 4000);
      for (let attempt = 0; attempt < 2; attempt++) {
        const pending = analyzer.analyze('original request');
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await jest.advanceTimersByTimeAsync(3999);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual({
          text: 'original request',
          needsAbapSystem: true,
        });
        expect((analyzer as any).pending.size).toBe(0);
      }
      expect(factory).toHaveBeenCalledTimes(2);
      if (stage === 'chat') {
        expect(chat).toHaveBeenCalledTimes(2);
        expect(chat.mock.calls[0][2].signal.aborted).toBe(true);
      }
    },
  );
  it('drains admission at the deadline when chat ignores abort', async () => {
    const chat = jest.fn(() => new Promise<any>(() => {}));
    const analyzer = new ToolQueryAnalyzer(llmWith(chat), 4000);
    const admission = createCallRegister();
    const pending = runWithAdmission(admission, () =>
      analyzer.analyze(original),
    );
    let drained = false;
    const drain = admission.drain().then(() => {
      drained = true;
    });
    await jest.advanceTimersByTimeAsync(3999);
    expect(drained).toBe(false);
    expect(admission.outstanding).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ text: original, needsAbapSystem: true });
    await drain;
    expect(admission.outstanding).toBe(0);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])(
    'isolates abort of waiter %s from shared work',
    async (index) => {
      let complete!: (value: any) => void;
      const chat = jest.fn(
        () =>
          new Promise<any>((resolve) => {
            complete = resolve;
          }),
      );
      const analyzer = new ToolQueryAnalyzer(llmWith(chat));
      const controllers = [new AbortController(), new AbortController()];
      const requests = controllers.map((controller) =>
        analyzer.analyze(original, [], {
          signal: controller.signal,
        }),
      );
      await jest.advanceTimersByTimeAsync(0);
      controllers[index].abort();
      expect(await requests[index]).toEqual({
        text: original,
        needsAbapSystem: true,
      });
      complete({
        ok: true,
        value: {
          content: JSON.stringify({
            translation: translated,
            needsAbapSystem: false,
          }),
        },
      });
      expect(await requests[1 - index]).toEqual({
        text: translated,
        needsAbapSystem: false,
      });
      expect(chat).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['factory', 'chat'])(
    'settles external abort during %s',
    async (stage) => {
      const chat = jest.fn(
        (_messages?: any, _tools?: any, _options?: any) =>
          new Promise<any>(() => {}),
      );
      const factory = jest.fn(() =>
        stage === 'factory'
          ? new Promise<any>(() => {})
          : Promise.resolve(llmWith(chat)),
      );
      const analyzer = new ToolQueryAnalyzer(factory);
      const controller = new AbortController();
      const pending = analyzer.analyze('original request', [], {
        signal: controller.signal,
      });
      await jest.advanceTimersByTimeAsync(0);
      controller.abort();
      expect(await pending).toEqual({
        text: 'original request',
        needsAbapSystem: true,
      });
      // Detaching the only waiter leaves shared work bounded by its deadline.
      expect((analyzer as any).pending.size).toBe(1);
      await jest.advanceTimersByTimeAsync(4000);
      expect((analyzer as any).pending.size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      if (stage === 'chat')
        expect(chat.mock.calls[0][2].signal.aborted).toBe(true);
    },
  );
});

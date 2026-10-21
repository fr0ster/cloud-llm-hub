import { QueryEmbedding, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import { ExpositionFilteringRag } from '../../srv/agent-manager';
import { ToolQueryTranslator } from '../../srv/lib/tool-query-translator';

const original = 'Створи домен для таблиці';
const translated = 'Create a domain for the table';
const llmWith = (chat: jest.Mock) => ({ chat }) as any;

describe('ToolQueryTranslator', () => {
  it('constructs the classifier LLM only when needed and reuses it', async () => {
    const chat = jest.fn().mockResolvedValue({
      ok: true,
      value: { content: translated },
    });
    const factory = jest.fn().mockResolvedValue(llmWith(chat));
    const translator = new ToolQueryTranslator(factory);
    expect(factory).not.toHaveBeenCalled();
    await translator.translate('Create a domain');
    expect(factory).not.toHaveBeenCalled();
    await translator.translate(original);
    await translator.translate(`${original}?`);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('skips ASCII and short queries without calling the LLM', async () => {
    const chat = jest.fn();
    const translator = new ToolQueryTranslator(llmWith(chat));
    for (const text of ['Create a domain for the table', 'Привіт']) {
      expect(await translator.translate(text)).toBe(text);
    }
    expect(chat).not.toHaveBeenCalled();
  });

  it('trims and caches translations, sharing concurrent calls', async () => {
    const chat = jest
      .fn()
      .mockResolvedValue({ ok: true, value: { content: ` ${translated} ` } });
    const translator = new ToolQueryTranslator(llmWith(chat));
    expect(
      await Promise.all([
        translator.translate(original),
        translator.translate(original),
      ]),
    ).toEqual([translated, translated]);
    expect(await translator.translate(original)).toBe(translated);
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
        await new ToolQueryTranslator(llmWith(chat)).translate(original),
      ).toBe(original);
    },
  );

  it('does not cache a failed translation: the next query tries again', async () => {
    const chat = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, value: { content: translated } });
    const translator = new ToolQueryTranslator(llmWith(chat));
    expect(await translator.translate(original)).toBe(original);
    expect(await translator.translate(original)).toBe(translated);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('asks a failed LLM factory again on the next query', async () => {
    const chat = jest
      .fn()
      .mockResolvedValue({ ok: true, value: { content: translated } });
    const factory = jest
      .fn()
      .mockRejectedValueOnce(new Error('no credentials yet'))
      .mockResolvedValue(llmWith(chat));
    const translator = new ToolQueryTranslator(factory);
    expect(await translator.translate(original)).toBe(original);
    expect(await translator.translate(original)).toBe(translated);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used translation after 500 entries', async () => {
    const chat = jest
      .fn()
      .mockResolvedValue({ ok: true, value: { content: translated } });
    const translator = new ToolQueryTranslator(llmWith(chat));
    for (let i = 0; i < 500; i++) await translator.translate(`${original}${i}`);
    await translator.translate(`${original}0`);
    await translator.translate(`${original}500`);
    await translator.translate(`${original}0`);
    expect(chat).toHaveBeenCalledTimes(501);
    await translator.translate(`${original}1`);
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
      const chat = jest
        .fn()
        .mockResolvedValue({ ok: true, value: { content: translated } });
      const embedder = {
        embedQuery: jest.fn().mockResolvedValue({ vector: [1] }),
      };
      const rag = new ExpositionFilteringRag(
        reader as any,
        writer as any,
        skills as any,
        3,
        new ToolQueryTranslator(llmWith(chat)),
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

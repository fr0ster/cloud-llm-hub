import type { CallOptions, ILlm } from '@mcp-abap-adt/llm-agent';

// Copied from llm-agent's TranslatePreprocessor (not exported).
const TRANSLATE_SYSTEM_PROMPT =
  'Translate the user request to English for tool search. Focus on the ACTION verb — use specific verbs (search, list, create, read, delete, execute, check) rather than generic ones (find, get, show). Preserve technical terms, object names, and abbreviations. Reply with only the English text, no explanation.';

export class ToolQueryTranslator {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();
  private llmPromise?: Promise<ILlm>;

  constructor(private readonly llm: ILlm | (() => Promise<ILlm>)) {}

  async translate(text: string, options?: CallOptions): Promise<string> {
    if (/^[\p{ASCII}]*$/u.test(text) || text.length < 15) return text;
    const cached = this.cache.get(text);
    if (cached !== undefined) {
      this.cache.delete(text);
      this.cache.set(text, cached);
      return cached;
    }
    const pending = this.pending.get(text);
    if (pending) return pending;
    const result = this.request(text, options).then((translated) => {
      this.pending.delete(text);
      // A failed call answers with the original text; it is not cached, so the
      // next query of this text tries again instead of staying untranslated.
      if (translated === undefined) return text;
      this.cache.set(text, translated);
      if (this.cache.size > 500) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      return translated;
    });
    this.pending.set(text, result);
    return result;
  }

  /** The translation, or `undefined` when the call failed or answered nothing. */
  private async request(
    text: string,
    options?: CallOptions,
  ): Promise<string | undefined> {
    try {
      const llm = await this.resolveLlm();
      const result = await llm.chat(
        [
          { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        [],
        options,
      );
      return result.ok ? result.value.content.trim() || undefined : undefined;
    } catch {
      return undefined;
    }
  }

  private resolveLlm(): Promise<ILlm> {
    if (typeof this.llm !== 'function') return Promise.resolve(this.llm);
    // A factory that failed is asked again next time, not remembered.
    this.llmPromise ??= this.llm().catch((err) => {
      this.llmPromise = undefined;
      throw err;
    });
    return this.llmPromise;
  }
}

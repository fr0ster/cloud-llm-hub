import {
  InMemoryRag,
  type IRag,
  type IRagProvider,
  normalizeTrust,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { ensureTrustStore } from './collection-persistence';
import { type TrustHistoryEntry, trustHistorySchema } from './trust';

const rowSchema = z.object({
  value: z.number().nullable(),
  history: trustHistorySchema,
});
type TrustRow = z.infer<typeof rowSchema>;
/** Persistence facade; resolved values are never cached outside the provider. */
export class TrustStore {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly rag: IRag,
    private readonly dimension: number | (() => number),
  ) {}
  static async open(
    provider: IRagProvider,
    dimension: number,
    prefix?: string,
  ): Promise<TrustStore> {
    const result = await ensureTrustStore(provider, prefix);
    if (!result.ok) throw result.error;
    return new TrustStore(result.value, dimension);
  }
  private key(source: 'skills', record?: string): string {
    return record === undefined
      ? `source:${source}`
      : `record:${source}:${record}`;
  }
  private async read(key: string): Promise<TrustRow> {
    const result = await this.rag.getById(key);
    if (!result.ok) throw result.error;
    if (!result.value) return { value: null, history: [] };
    const parsed = rowSchema.parse(JSON.parse(result.value.text));
    return { ...parsed, history: parsed.history.slice(-20) };
  }
  private write(
    key: string,
    trust: number | null,
    actor: string,
  ): Promise<void> {
    if (trust !== null && normalizeTrust(trust) === undefined)
      return Promise.reject(new Error('INVALID_TRUST'));
    const run = this.tail.then(async () => {
      const previous = await this.read(key);
      const history = [
        ...previous.history,
        {
          from: previous.value,
          to: trust,
          actor,
          at: new Date().toISOString(),
        },
      ].slice(-20);
      const writer = this.rag.writer?.();
      const text = JSON.stringify({ value: trust, history });
      if (this.rag instanceof InMemoryRag) {
        const result = await this.rag.upsert(text, { id: key });
        if (!result.ok) throw result.error;
        return;
      }
      if (!writer?.upsertPrecomputedRaw)
        throw new Error('Trust store requires upsertPrecomputedRaw');
      const result = await writer.upsertPrecomputedRaw(
        key,
        text,
        new Array<number>(
          typeof this.dimension === 'function'
            ? this.dimension()
            : this.dimension,
        ).fill(0),
        {},
      );
      if (!result.ok) throw result.error;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async getSource(source: 'skills'): Promise<number | undefined> {
    return (await this.read(this.key(source))).value ?? undefined;
  }
  setSource(source: 'skills', trust: number, actor: string): Promise<void> {
    return this.write(this.key(source), trust, actor);
  }
  async getRecord(
    source: 'skills',
    record: string,
  ): Promise<number | undefined> {
    return (await this.read(this.key(source, record))).value ?? undefined;
  }
  setRecord(
    source: 'skills',
    record: string,
    trust: number | null,
    actor: string,
  ): Promise<void> {
    return this.write(this.key(source, record), trust, actor);
  }
  async getSourceHistory(source: 'skills'): Promise<TrustHistoryEntry[]> {
    return (await this.read(this.key(source))).history;
  }
  async getRecordHistory(
    source: 'skills',
    record: string,
  ): Promise<TrustHistoryEntry[]> {
    return (await this.read(this.key(source, record))).history;
  }
}

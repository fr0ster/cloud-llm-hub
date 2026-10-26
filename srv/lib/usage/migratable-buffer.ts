import {
  type IUsageSink,
  UsageDeliveryError,
  type UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import {
  type IUsageReader,
  selectUsage,
  type UsageQuery,
} from '@mcp-abap-adt/llm-usage';

/** One mutex covers writes and the entire copy/commit, including failed copies. */
export class MigratableBuffer implements IUsageSink, IUsageReader {
  private closed = false;
  private records = new Map<string, UsageRecord>();
  private target?: IUsageSink & IUsageReader;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly limit: number,
    private readonly resource?: IUsageSink,
  ) {}
  get size(): number {
    return this.records.size;
  }
  get migrated(): boolean {
    return this.target !== undefined;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run);
    this.tail = next.catch(() => undefined);
    return next;
  }
  write(batch: readonly UsageRecord[]): Promise<void> {
    return this.serial(async () => {
      if (this.closed)
        throw new UsageDeliveryError('Usage buffer closed', false, 'CLOSED');
      if (this.target) return this.target.write(batch);
      const added = new Set(
        batch.filter((r) => !this.records.has(r.id)).map((r) => r.id),
      ).size;
      if (this.records.size + added > this.limit)
        throw new UsageDeliveryError(
          'Usage fallback buffer full',
          false,
          'BUFFER_FULL',
        );
      for (const r of batch) this.records.set(r.id, r);
    });
  }
  async *read(query: UsageQuery): AsyncIterable<UsageRecord> {
    const target = this.target;
    if (target) yield* target.read(query);
    else yield* selectUsage([...this.records.values()], query);
  }
  close(): Promise<void> {
    return this.serial(async () => {
      this.closed = true;
      await this.resource?.close?.();
    });
  }
  migrate(target: IUsageSink & IUsageReader, batchSize = 500): Promise<void> {
    return this.serial(async () => {
      if (this.closed || this.target) return;
      const records = [...this.records.values()];
      for (let i = 0; i < records.length; i += batchSize)
        await target.write(records.slice(i, i + batchSize));
      this.target = target;
      this.records.clear();
    });
  }
}

import { randomUUID } from 'node:crypto';
import type { PlannerMessage } from '@mcp-abap-adt/llm-agent';

import { stripNoMessage } from './no-message';

/** Remove boundary sentinel tokens before persistence or delivery. */
function cleanMessages(messages: PlannerMessage[]): PlannerMessage[] {
  return messages.flatMap((message) => {
    const text = stripNoMessage(message.text);
    return text.trim() ? [{ ...message, text }] : [];
  });
}

export type OutboxEntry = PlannerMessage & { confirmed?: boolean };

export interface Delivery {
  readonly id: string;
  carried(messageId: string): void;
  has(messageId: string): boolean;
  ended(): void;
}

/** Delivery ownership belongs to the hub, independently of library pending. */
export class DialogueOutbox {
  private subscribers = new Set<{
    fn: (message: PlannerMessage) => void;
    cursor?: string;
  }>();
  subscribe(
    fn: (message: PlannerMessage) => void,
    cursor?: string,
  ): () => void {
    const subscriber = { fn, cursor };
    this.subscribers.add(subscriber);
    this.emit();
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
  private emit(): void {
    for (const subscriber of this.subscribers) {
      for (const message of this.history(subscriber.cursor)) {
        if (!this.subscribers.has(subscriber)) break;
        try {
          subscriber.fn(message);
          subscriber.cursor = message.id;
        } catch {
          break;
        }
      }
    }
  }
  private messages: OutboxEntry[];
  private writes = Promise.resolve();
  private seen = new Set<string>();
  private deliveries: { carried: Set<string>; ended: boolean }[] = [];
  private acknowledgementMode: boolean;
  constructor(
    entries: OutboxEntry[],
    private persist: (
      entries: OutboxEntry[],
      ackMode: boolean,
    ) => Promise<void>,
    ackMode = false,
  ) {
    this.messages = cleanMessages(entries);
    for (const message of this.messages) this.seen.add(message.id);
    this.messages = this.retain(this.messages);
    this.acknowledgementMode = ackMode;
  }
  get ackMode(): boolean {
    return this.acknowledgementMode;
  }
  pending(): PlannerMessage[] {
    return this.messages.filter((m) => !m.confirmed).map(this.message);
  }
  history(after?: string): PlannerMessage[] {
    const index = after ? this.messages.findIndex((m) => m.id === after) : -1;
    return this.messages.slice(index + 1).map(this.message);
  }
  private message({
    confirmed: _confirmed,
    ...message
  }: OutboxEntry): PlannerMessage {
    return message;
  }
  private retain(entries: OutboxEntry[]): OutboxEntry[] {
    let excess = entries.filter((m) => m.confirmed).length - 200;
    return entries.filter((m) => !m.confirmed || excess-- <= 0);
  }
  beginDelivery(): Delivery {
    const record = { carried: new Set<string>(), ended: false };
    this.deliveries.push(record);
    this.trimDeliveries();
    return {
      id: randomUUID(),
      carried: (id) => {
        if (!record.ended) record.carried.add(id);
      },
      has: (id) => record.carried.has(id),
      ended: () => {
        record.ended = true;
        this.trimDeliveries();
      },
    };
  }
  private trimDeliveries(): void {
    while (this.deliveries.length > 20) {
      const index = this.deliveries.findIndex((record) => record.ended);
      // If every response is open, evict the oldest conservatively: it can
      // no longer confirm anything, so its messages will be delivered again.
      this.deliveries.splice(index < 0 ? 0 : index, 1);
    }
  }
  private write(run: () => Promise<void>): Promise<void> {
    const result = this.writes
      .catch(() => {})
      .then(run)
      .finally(() => this.emit());
    this.writes = result;
    return result;
  }
  async flushed(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.writes;
      // Flushing waits for publication even when persistence failed. Callers
      // of the individual write still receive its error.
      await pending.catch(() => {});
    } while (pending !== this.writes);
  }
  /** Replace only unconfirmed replies, preserving their delivery identity. */
  upsert(
    messages: PlannerMessage[],
    pending: PlannerMessage[] = [],
  ): Promise<void> {
    return this.addEntries(pending, messages);
  }
  add(messages: PlannerMessage[]): Promise<void> {
    return this.addEntries(messages, []);
  }
  private addEntries(
    messages: PlannerMessage[],
    replacements: PlannerMessage[],
  ): Promise<void> {
    return this.write(async () => {
      for (const message of cleanMessages(messages)) {
        if (!this.seen.has(message.id)) {
          this.messages.push(message);
          this.seen.add(message.id);
        }
      }
      for (const message of cleanMessages(replacements)) {
        const existing = this.messages.find((entry) => entry.id === message.id);
        if (existing) {
          if (!existing.confirmed) existing.text = message.text;
        } else if (!this.seen.has(message.id)) {
          this.messages.push(message);
          this.seen.add(message.id);
        }
      }
      await this.persist(
        this.messages.map((m) => ({ ...m })),
        this.ackMode,
      );
    });
  }
  confirmByArrival(): Promise<void> {
    return this.write(async () => {
      if (!this.ackMode) await this.confirm();
    });
  }
  confirmUpTo(id: string): Promise<void> {
    return this.write(() => this.confirm(id));
  }
  private async confirm(id?: string): Promise<void> {
    const limit =
      id === undefined
        ? this.messages.length - 1
        : this.messages.findIndex((m) => m.id === id);
    if (limit < 0) return;
    const entries = this.messages.map((m) => ({ ...m }));
    for (let i = 0; i <= limit; i++) {
      const entry = entries[i];
      if (entry.confirmed) continue;
      if (
        !this.deliveries.some(
          (record) => record.ended && record.carried.has(entry.id),
        )
      )
        break;
      entry.confirmed = true;
    }
    const retained = this.retain(entries);
    await this.persist(retained, this.ackMode);
    this.messages = retained;
  }
  enterAckMode(): Promise<void> {
    return this.write(async () => {
      if (this.ackMode) return;
      await this.persist(
        this.messages.map((m) => ({ ...m })),
        true,
      );
      this.acknowledgementMode = true;
    });
  }
}

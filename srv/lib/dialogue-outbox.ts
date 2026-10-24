import type { PlannerMessage } from '@mcp-abap-adt/llm-agent';

import { stripNoMessage } from './no-message';

/** Remove boundary sentinel tokens before persistence or delivery. */
function cleanMessages(messages: PlannerMessage[]): PlannerMessage[] {
  return messages.flatMap((message) => {
    const text = stripNoMessage(message.text);
    return text.trim() ? [{ ...message, text }] : [];
  });
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
      for (const message of this.replay(subscriber.cursor)) {
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
  private messages: PlannerMessage[];
  private writes = Promise.resolve();
  private seen = new Set<string>();
  constructor(
    messages: PlannerMessage[],
    private persist: (messages: PlannerMessage[]) => Promise<void>,
  ) {
    this.messages = cleanMessages(messages);
    for (const message of this.messages) this.seen.add(message.id);
  }
  replay(after?: string): PlannerMessage[] {
    const index = after ? this.messages.findIndex((m) => m.id === after) : -1;
    return this.messages.slice(index + 1);
  }
  private write(run: () => Promise<void>): Promise<void> {
    const result = this.writes
      .catch(() => {})
      .then(run)
      .finally(() => this.emit());
    this.writes = result;
    return result;
  }
  add(messages: PlannerMessage[]): Promise<void> {
    for (const message of cleanMessages(messages)) {
      if (!this.seen.has(message.id)) {
        this.messages.push(message);
        this.seen.add(message.id);
      }
    }
    this.emit();
    return this.write(() => this.persist(this.replay()));
  }
  ack(id: string): Promise<void> {
    return this.write(async () => {
      const index = this.messages.findIndex((m) => m.id === id);
      if (index < 0) return;
      const acknowledged = new Set(
        this.messages.slice(0, index + 1).map((m) => m.id),
      );
      await this.persist(this.messages.filter((m) => !acknowledged.has(m.id)));
      this.messages = this.messages.filter((m) => !acknowledged.has(m.id));
    });
  }
}

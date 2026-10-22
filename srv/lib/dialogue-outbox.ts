import type { PlannerMessage } from '@mcp-abap-adt/llm-agent';

/** Delivery ownership belongs to the hub, independently of library pending. */
export class DialogueOutbox {
  private messages: PlannerMessage[];
  private writes = Promise.resolve();
  private seen = new Set<string>();
  constructor(
    messages: PlannerMessage[],
    private persist: (messages: PlannerMessage[]) => Promise<void>,
  ) {
    this.messages = messages.slice();
    for (const message of messages) this.seen.add(message.id);
  }
  replay(after?: string): PlannerMessage[] {
    const index = after ? this.messages.findIndex((m) => m.id === after) : -1;
    return this.messages.slice(index + 1);
  }
  private write(run: () => Promise<void>): Promise<void> {
    const result = this.writes.catch(() => {}).then(run);
    this.writes = result;
    return result;
  }
  add(messages: PlannerMessage[]): Promise<void> {
    for (const message of messages) {
      if (!this.seen.has(message.id)) {
        this.messages.push(message);
        this.seen.add(message.id);
      }
    }
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

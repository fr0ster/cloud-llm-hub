/**
 * Semantic recall of earlier turns.
 *
 * The verbatim turns bound to the request cover the near context — "that
 * domain" means the one named a moment ago. They stop at the recency window
 * (20 messages), and the context assembler's own note says the older ones are
 * "available via RAG stores if needed". They were not: the pipeline queries a
 * `history` store on every request, and nothing ever wrote to it.
 *
 * This is the write half, plus the scoping the store needs to be safe. Two
 * mechanisms with different jobs — the recent turns resolve references
 * deterministically, this one answers "what was that domain called" many turns
 * later, when the exact wording is long gone.
 *
 * The answer is stored, not just the request. Storing the question alone would
 * recall that a domain was asked for and never what it was called, which is the
 * one fact worth keeping. It costs context, and that is the deliberate trade.
 */

import type {
  CallOptions,
  IQueryEmbedding,
  IRag,
  IRagBackendWriter,
  RagError,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

/** How much of the answer is kept. Tool output can run to tens of thousands of
 *  characters; the object names and the outcome are at the front. */
const ANSWER_CHARS = 1200;

/** ABAP object names: uppercase, underscored, at least four characters. */
const OBJECT_NAME = /\b[A-Z][A-Z0-9_]{3,}\b/g;
const MAX_NAMES = 20;

/** Turns held per conversation. Beyond this the oldest are forgotten. */
const MAX_TURNS_PER_OWNER = 200;

/**
 * A turn is recalled only inside the conversation that produced it. Two people
 * on the same destination must never see each other's turns, and neither
 * should the same person's unrelated session.
 *
 * A tuple, not a join: with a colon, ("alice:x", "y") and ("alice", "x:y") were
 * one owner. The store lives in memory, so no recorded owner outlives the
 * process in the old shape.
 */
export function turnOwner(userId: string, sessionId: string): string {
  return JSON.stringify([userId, sessionId]);
}

/**
 * Names worth surviving the clip.
 *
 * A created object's name is the fact a later turn asks for, and it can sit
 * past the cut in a long answer. Pulling the names out and appending them keeps
 * them findable whatever the clip removed.
 */
export function objectNames(text: string): string[] {
  return [...new Set(text.match(OBJECT_NAME) ?? [])].slice(0, MAX_NAMES);
}

/** One turn, rendered for embedding and recall. */
export function renderTurn(userText: string, assistantText: string): string {
  const answer =
    assistantText.length > ANSWER_CHARS
      ? `${assistantText.slice(0, ANSWER_CHARS)}…`
      : assistantText;
  const names = objectNames(assistantText);
  return [
    `User: ${userText}`,
    `Assistant: ${answer}`,
    ...(names.length ? [`Objects: ${names.join(', ')}`] : []),
  ].join('\n');
}

/**
 * The `history` store, scoped to the conversation asking.
 *
 * Upstream registers `history` with scope `global`, and the query handler adds
 * a session filter only for scope `session` — so an unscoped store would let
 * one person's turns surface in another's context. The filter here is not an
 * optimisation.
 */
export class SessionHistoryRag implements IRag {
  /**
   * Turn ids per conversation, newest last.
   *
   * The store outlives every request in the process, so without a bound it
   * grows for as long as the server runs. This is what lets the oldest turn of
   * a long conversation be dropped, and every turn of a finished one be
   * forgotten when its session is cleared.
   */
  private readonly ids = new Map<string, string[]>();

  constructor(
    private readonly inner: IRag,
    /** The conversation asking, or undefined outside a request. */
    private readonly currentOwner: () => string | undefined,
    private readonly maxTurnsPerOwner = MAX_TURNS_PER_OWNER,
  ) {}

  private async drop(ids: string[]): Promise<void> {
    const writer = this.writer();
    if (!writer) return;
    for (const id of ids) {
      try {
        await writer.deleteByIdRaw(id);
      } catch {
        // Best-effort: a turn that refuses to go is not worth an error on a
        // request that has already answered.
      }
    }
  }

  /** Forget a whole conversation — its session was cleared or reconnected. */
  async forgetOwner(owner: string): Promise<void> {
    const ids = this.ids.get(owner);
    if (!ids?.length) return;
    this.ids.delete(owner);
    await this.drop(ids);
  }

  /** How many turns are held for a conversation. */
  turnCount(owner: string): number {
    return this.ids.get(owner)?.length ?? 0;
  }

  private mine(rows: RagResult[]): RagResult[] {
    const owner = this.currentOwner();
    // No owner means no conversation to recall for. Fail closed: returning
    // everything here would hand one caller another's turns.
    if (!owner) return [];
    return rows.filter((r) => r.metadata.owner === owner);
  }

  async query(
    embedding: IQueryEmbedding,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    const res = await this.inner.query(embedding, k, options);
    if (!res.ok) return res;
    return { ok: true as const, value: this.mine(res.value) };
  }

  async getById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<RagResult | null, RagError>> {
    const res = await this.inner.getById(id, options);
    if (!res.ok) return res;
    if (!res.value) return res;
    return { ok: true as const, value: this.mine([res.value])[0] ?? null };
  }

  healthCheck(options?: CallOptions): Promise<Result<void, RagError>> {
    return this.inner.healthCheck(options);
  }

  writer(): IRagBackendWriter | undefined {
    return this.inner.writer?.();
  }

  /**
   * Store one completed turn. Best-effort: recall is an improvement, never a
   * precondition, so a failure here must not touch the answer already sent.
   */
  async recordTurn(input: {
    owner: string;
    userText: string;
    assistantText: string;
    id?: string;
  }): Promise<boolean> {
    const writer = this.writer();
    if (!writer) return false;
    const id = input.id ?? `turn:${input.owner}:${Date.now()}`;
    try {
      const res = await writer.upsertRaw(
        id,
        renderTurn(input.userText, input.assistantText),
        { owner: input.owner },
      );
      if (!res.ok) return false;
      const ids = this.ids.get(input.owner) ?? [];
      ids.push(id);
      // Oldest first out: a conversation keeps its recent past, not all of it.
      const overflow = ids.splice(
        0,
        Math.max(0, ids.length - this.maxTurnsPerOwner),
      );
      this.ids.set(input.owner, ids);
      if (overflow.length) await this.drop(overflow);
      return true;
    } catch {
      return false;
    }
  }
}

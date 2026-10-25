# Protocol Turn/Follow, Delivery and WebUI Streaming Implementation Plan

<!-- docs-check:proposed-env: this plan introduces LLM_AGENT_DIALOGUE_FOLLOW_MAX_MS, which does not exist yet -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A streaming chat request in a dialogue session stays open until the plan really stops. Every planner message reaches the session at least once, by id. The WebUI is an ordinary streaming client of that protocol. All three ship in one release.

**Architecture:**
- **Two phases.** The request's planner turn runs under session admission as today. A follow phase then runs after admission is released and streams new outbox messages on the same response until a stop condition.
- **Outbox.** The outbox keeps every message, marking each as pending or confirmed. Per-response delivery records decide what a confirmation may remove from pending, either by a later arrival or by `x-clh-ack`.
- **SSE.** The SSE channel becomes a read-only view.
- **Library.** No llm-agent change. The hub assigns the user-turn reply's id itself when the turn starts.

**Tech Stack:** TypeScript, SAP CAP, Express, Jest (`--maxWorkers=1`), `@mcp-abap-adt/llm-agent(-libs)` 30.9.1, the WebUI single file `app/chat/webapp/index.html`.

**Spec:** `docs/superpowers/specs/2026-10-24-client-protocol-design.md`, sections 4 (streaming part), 5 and 6; rollout step 2. The non-streaming budget and queued status (rollout step 3) and the session key in the conversation (step 4) are out of scope.

## Global Constraints

**Headers and comments**
- Request header `x-clh-ack`: a message id or `none`.
- Non-streaming response header `x-clh-last-message`: the id of the last message in that response.
- Each message id goes out on the stream as the SSE comment line `: message-id <id>` immediately before that message's first content delta.

**Stream lifecycle**
- Keep-alive: an SSE comment `: keep-alive` every 10 000 ms in both handlers. It starts when the stream opens, and the stream opens before agent initialization and admission.
- Messages of one response are content deltas of one completion or text block, separated by a paragraph break `\n\n`. The `**Planner:** ` prefix goes away.
- One terminal sequence per stream:
  - OpenAI: `finish_reason: "stop"`, then the usage chunk when there is usage, then `data: [DONE]`.
  - Anthropic: `content_block_stop`, `message_delta` with `stop_reason: "end_turn"`, then `message_stop`.
  - A hub error after headers ends the stream with the error form (OpenAI `data: {"error":…}`, Anthropic `event: error`) and no success terminal.

**Follow**
- Maximum duration: new setting `LLM_AGENT_DIALOGUE_FOLLOW_MAX_MS`, positive integer, default `1800000`. Read with `readPositiveIntFrom` into `getAgentConfig().agent.dialogue.followMaxMs`.
- At the limit, the status line is exactly `still running: <done> of <total> steps done`, or `still running` without steps.
- When a new request in the same session closes an open follow, the note is exactly `A new message arrived; the work continues in its response.`

**Data and process**
- Usage: the dialogue path produces no usage today. The terminal carries usage only when chunks report it (as today); summing over turn and follow becomes real with the token ledger, which is not in this plan.
- Delivery records live in memory only. After a restart, every unconfirmed message is delivered again (at least once).
- No new model names; no customer details in docs; Biome style; CHANGELOG `## [Unreleased]` entries with LF line endings.

## Review Focus

1. **Disconnect then an immediate new request.** The messages that the cut stream carried are delivered again, and confirmed ones are not. Owned by Task 1 and Task 5 tests.
2. **Gap between a task ending and its event turn starting.** The follow must not end as idle in this gap. Owned by Task 3.
3. **Empty or `NO_MESSAGE` user-turn reply.** No outbox entry, no `: message-id` comment and no empty paragraph. Owned by Task 5.
4. **SDK parsing.** The official OpenAI and Anthropic SDKs must parse a stream with `: message-id` comments between events, and a stream cut before the terminal, without error. Owned by Task 6 (frame-level tests) and Task 10 (live SDK runs).
5. **Restart during an open follow.** The acknowledgement mode survives in the persisted row, and unconfirmed messages come again. Owned by Task 1.

---

### Task 1: Outbox keeps history, delivery records and the acknowledgement mode

**Files:**
- Modify: `srv/lib/dialogue-outbox.ts`
- Modify: `srv/lib/dialogue-store.ts` (schema: optional `confirmed` per outbox entry, optional `ackMode` on the row)
- Modify: `srv/lib/dialogue-sessions.ts:373-388` (persist row carries `ackMode`; construct the outbox from the saved row)
- Test: `test/unit/dialogue-outbox.test.ts`, `test/unit/dialogue-store.test.ts`

**Interfaces:**
- Produces, in `dialogue-outbox.ts`:
  - **Types:**
    - `type OutboxEntry = PlannerMessage & { confirmed?: boolean }`;
    - `interface Delivery { readonly id: string; carried(messageId: string): void; ended(): void }`.
  - **Constructor:** `constructor(entries: OutboxEntry[], persist: (entries: OutboxEntry[], ackMode: boolean) => Promise<void>, ackMode = false)`.
  - **Methods:**
    - `add(messages: PlannerMessage[]): Promise<void>`. Existing dedupe by id and `cleanMessages` are kept.
    - `pending(): PlannerMessage[]` returns the unconfirmed entries in outbox order.
    - `history(after?: string): PlannerMessage[]` returns all retained entries after the id. It replaces `replay` for the SSE view.
    - `beginDelivery(): Delivery`.
    - `confirmByArrival(): Promise<void>`. It does nothing when `ackMode` is true.
    - `confirmUpTo(id: string): Promise<void>`.
    - `enterAckMode(): Promise<void>`.
    - `get ackMode(): boolean`.
  - **Removed:** `subscribe` keeps its signature but delivers `history`. `ack()` and `replay()` are removed; update their callers in Tasks 5 and 7.
- **Confirmation rule:** walk the unconfirmed entries in order. Confirm each one that some ended delivery carried. Stop at the first entry that no ended delivery carried, and, for `confirmUpTo`, after the named id. An unknown id confirms nothing.
- **Retention:** keep at most 200 confirmed entries; drop the oldest confirmed first. Unconfirmed entries are never dropped.
- Keep at most 20 delivery records; drop the oldest ended record first.

- [ ] **Step 1: Write the failing tests** in `dialogue-outbox.test.ts`:
  - `confirms only messages carried by an ended delivery`: add m1, m2, m3; delivery A carries m1, m3 and ends; `confirmByArrival()` → `pending()` ids `['m2','m3']`.
  - `a delivery that did not end confirms nothing`: carried m1, not ended → `pending()` still has m1.
  - `confirmUpTo stops at the named id and at an uncarried message`.
  - `ack mode ignores arrival`: `enterAckMode()`, carried and ended m1 → `confirmByArrival()` leaves m1 pending; `confirmUpTo('m1')` confirms it.
  - `history keeps confirmed messages, bounded to 200 confirmed`.
  - `persist receives entries with confirmed flags and ackMode`.
- [ ] **Step 2:** `npx jest --maxWorkers=1 test/unit/dialogue-outbox.test.ts` → FAIL.
- [ ] **Step 3:** Implement the API above. All mutations go through the existing serialized `write`.
- [ ] **Step 4:** Add a `dialogue-store.test.ts` case: a row with `outbox[].confirmed` and `ackMode: true` round-trips through `stored()`, and an old row without these fields still loads.
- [ ] **Step 5:** Run both suites → PASS. Commit `feat(dialogue): outbox delivery records, history and ack mode`.

### Task 2: Session lifetime hold

**Files:**
- Modify: `srv/lib/long-session.ts` (Entry gets `holds: number`; `sweep` skips `holds > 0`)
- Modify: `srv/lib/dialogue-sessions.ts` (acquire and release from task state changes)
- Test: `test/unit/long-session.test.ts`, `test/unit/dialogue-sessions.test.ts`

**Interfaces:**
- Produces `LongSessionRegistry.hold(s: LongSession): () => void`. The returned release function is idempotent. It decrements the count and calls `touch(s.userId, s.key)`.
- In `dialogue-sessions.ts`, a session holds exactly one hold while any task in `snapshot().tasks` is `queued` or `running`. Recompute where `emitTask` runs (l.400, 445, 499): acquire on the 0→1 transition and release on 1→0. Release on close.

- [ ] **Step 1: Failing tests:**
  - `sweep keeps a held session past the TTL`;
  - `release touches, so the TTL counts from release`;
  - `double release is harmless`;
  - in `dialogue-sessions.test.ts`: `a running task holds the session; finishing all tasks releases it`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat(session): lifetime hold while dialogue tasks run`.

### Task 3: Settled turns and idle state on the dialogue handle

**Files:**
- Modify: `srv/lib/dialogue-sessions.ts`
- Test: `test/unit/dialogue-sessions.test.ts`

**Interfaces:**
- **New event kind:** `DialogueEvent` gains `{ kind: 'settled' }`. It is emitted to subscribers in the store's `save` after `await outbox.add(state.pending)` (after l.418). It is never sent to SSE clients (Task 7 filters it).
- **`DialogueHandle` gains `state(): { turnActive: boolean; running: number; total: number; done: number; status?: 'active' | 'waiting_user' | 'done'; idle: boolean }`:**
  - `turnActive`: a counter incremented around the planner `process` wrapper (l.387-401).
  - `running`: the number of `queued` or `running` tasks.
  - `total` and `done`: plan steps total, and plan steps with state `done`.
  - `idle` is true when all of these hold:
    - `!turnActive`;
    - `running === 0`;
    - status is `active`;
    - no task reached a terminal state after the start of the last settled planner turn. Track `lastTaskEndAt` in `wrapRun`'s final `finally` and `lastSettledTurnStartedAt`.
- **Plain replies:** an ordinary reply without a plan reports `status: undefined`. The follow (Task 4) does not start then.

- [ ] **Step 1: Failing tests:**
  - `settled is emitted after the outbox write of the turn`: a subscriber records the order of the `plan`, `message` and `settled` events. `settled` comes last, after the message.
  - `idle is false between a task end and its event turn`: finish a task with the planner blocked on a deferred → `idle === false`; let the event turn settle → `idle === true` if nothing else runs.
  - `waiting_user and done are reported`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat(dialogue): settled event and idle state`.

### Task 4: Follow engine

**Files:**
- Create: `srv/lib/dialogue-follow.ts`
- Modify: `srv/agent-config.ts:615-625` (`followMaxMs`)
- Test: `test/unit/dialogue-follow.test.ts`

**Interfaces:**
- Consumes: Task 1 `history`, `pending` and `Delivery`; Task 3 `state()` and the `settled` event; `DialogueHandle.subscribe`.
- **Produces:**
  - `followDialogue(handle: DialogueHandle, opts: { delivery: Delivery; after?: string; signal: AbortSignal; maxMs: number; now?: () => number }): AsyncIterable<FollowItem>`.
  - `type FollowItem = { kind: 'message'; message: PlannerMessage } | { kind: 'end'; reason: 'done' | 'waiting_user' | 'idle' | 'limit' | 'superseded' | 'disconnected'; note?: string }`.
  - `supersedeFollow(handle: DialogueHandle): Promise<void>`.
- **Behaviour:**
  - **Messages:** yield every outbox message after `after` (the last id this response already carried) as it arrives. Call `delivery.carried(id)` only after the consumer has written it; the handler calls back (see Task 6).
  - **Stop evaluation:** evaluate the stop on each `settled` event and once at start. End with `done`, `waiting_user` or `idle` from `state()`, and only after every message that the outbox holds at that moment has been yielded.
  - **Limit:** `limit` at `maxMs` from the follow start. Its note is `still running: <done> of <total> steps done`, or `still running` when `total === 0`.
  - **Disconnect:** `disconnected` when the signal aborts.
  - **One follow per session:** a new `followDialogue` or `supersedeFollow` call ends the previous follow with `superseded` and the note `A new message arrived; the work continues in its response.`, and resolves after that previous follow has yielded its end.

- [ ] **Step 1: Failing tests,** each with a fake handle and fake timers:
  - `streams messages and ends on done only after the turn's message`: emit the `plan(done)` event, then the message, then `settled`. The iterator yields the message, then end `done`.
  - `ends on waiting_user after the question message`.
  - `ends idle only on a settled state with nothing running`.
  - `limit ends with the exact status line`: 3 of 5 done → note `still running: 3 of 5 steps done`.
  - `supersede ends the old follow with the exact note before the new one starts`.
  - `abort ends with disconnected and yields nothing more`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat(dialogue): follow engine`.

### Task 5: dialogueChat: reply id, pending first, delivery and acknowledgement

**Files:**
- Modify: `srv/lib/dialogue-chat.ts`
- Test: `test/unit/dialogue-channel.test.ts` (update the `visible` fixture at l.110: no `**Planner:**` prefix)

**Interfaces:**
- **Consumes:** Task 1 and Task 4 (`supersedeFollow`).
- **Produces:** `dialogueChat(req, userId, session, destination, response)` returns `{ process, streamProcess, follow }`. Here `follow(signal: AbortSignal, maxMs: number): AsyncIterable<FollowItem> | undefined` is undefined when no follow is due.
- **Stream chunks** carry the internal extension `value.clhMessageId?: string`, a chunk with empty content that tells the handler to write `: message-id <id>` (Task 6).
- **On `open()`, in this order:**
  1. `await supersedeFollow(handle)`.
  2. Read `x-clh-ack`: `none` → `enterAckMode()`; an id → `enterAckMode()` then `confirmUpTo(id)`; absent → `confirmByArrival()`.
  3. `delivery = outbox.beginDelivery()`.
  4. Pending = `outbox.pending()`.
- **Remove:** the `hasSubscribers()` suppression and the `ack` on `finish`.
- **On `response.on('finish')`:** if the response completed successfully and the client did not disconnect, `delivery.ended()`.
- **The reply id:** `replyId = randomUUID()`, created before `send`.
- **Streaming order:**
  - For each pending message: chunk `clhMessageId`, then the message text, then `\n\n`. Call `delivery.carried(id)` after its text chunk was yielded.
  - Then `clhMessageId: replyId` before the reply's first non-empty delta.
  - When the turn ends with non-empty text, `outbox.add([{ id: replyId, text, createdAt, trigger: 'user' }])` and `delivery.carried(replyId)`.
- **Non-streaming:** the same order in one content, and `response.setHeader('x-clh-last-message', lastId)` when there is a last message.
- **`follow`:** returns `followDialogue(handle, { delivery, after: lastCarriedId, signal, maxMs })` only when the stream request ended its turn with `state().status` set (a plan exists). Otherwise it returns `undefined`.

- [ ] **Step 1: Failing tests:**
  - `streams pending messages then the reply, each preceded by its id chunk`;
  - `a NO_MESSAGE reply adds nothing and emits no id`;
  - `x-clh-ack none enters ack mode; an id confirms up to it`;
  - `without the header a later request confirms what an ended response carried`;
  - `a cut response confirms nothing; its messages come again`;
  - `non-streaming sets x-clh-last-message`;
  - `a new request supersedes an open follow before reading pending`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat(dialogue): ids, delivery records and x-clh-ack in chat`.

### Task 6: Handlers: early stream, id comments, follow after admission, one terminal

**Files:**
- Modify: `srv/openai-handler.ts` (`handleChatCompletions` l.222-294, streaming l.758-1096)
- Modify: `srv/anthropic-handler.ts` (l.100-124, streaming l.389-501)
- Test: `test/unit/openai-channel.test.ts`, `test/unit/anthropic-channel.test.ts`, `test/unit/dialogue-channel.test.ts`, `test/unit/sse-no-transform.test.ts`

**Interfaces:**
- Consumes: Task 5 `dialogueChat(...).follow` and the `clhMessageId` chunk.
- **`ensureStream()`** is created per streaming request in `handleChatCompletions` / `handleAnthropicMessages`. It is idempotent: it writes the 200 event-stream headers (unchanged values) and starts the keep-alive.
  - **Called:** when `longSessions().run` has to queue the request (new optional `onQueued` callback on `run`), and inside `serve*` right after the synchronous refusals (409 `DIALOGUE_PRINCIPAL_FIXED`, 409 `DIALOGUE_DESTINATION_FIXED`, 503 closed destination), before `getSmartAgent`.
  - **Refusals before `ensureStream`** stay HTTP statuses. After it, every refusal or initialization error uses the stream error form.
  - Admission refusals and collection refusals after the stream opened become the stream error form.
- **Turn and follow split:**
  - `serve*` returns `Promise<(() => Promise<void>) | void>`. The continuation runs after `longSessions().run` resolves and after `pipeline.release()`.
  - It iterates `follow(callerLeft.signal, followMaxMs)` and writes each message: id comment, `\n\n` separator, content delta. It calls `delivery.carried` through the iterator's contract.
  - It writes `note` as a final paragraph.
  - It touches the session on each keep-alive and then writes the one terminal.
  - Non-dialogue and non-streaming requests return no continuation and keep today's flow.
- **Terminal and errors:**
  - `[DONE]` / `message_stop` is written exactly once, by the code that ends the response.
  - After a stream error form nothing else is written, which fixes OpenAI writing `finish_reason` and `[DONE]` after an error chunk (l.859-862, 1000-1002).
- **Anthropic:** the `observed` generator writes `: message-id <id>\n\n` when it sees a `clhMessageId` chunk and does not pass that chunk to `transformStream`. Follow messages are fed through the same `transformStream` so they stay in one text block.
- **History:** OpenAI `appendToSession` / `recordTurn` records the accumulated content of turn plus follow when the response ends. Anthropic stays without history.

- [ ] **Step 1: Failing tests:**
  - `headers and a keep-alive go out before agent initialization`: getSmartAgent blocked on a deferred → `res.headersSent` true and the body contains `: keep-alive` after advancing 10 000 ms.
  - `an initialization failure after the stream opened is the stream error form with no [DONE]`.
  - `a closed destination before the stream is still HTTP 503 with Retry-After`.
  - `the follow runs after admission is released`: a second request of another session is admitted while the first follows.
  - `exactly one terminal sequence after turn + follow` (both handlers).
  - `an error during the follow writes the error form and no success terminal` (both handlers).
  - `id comments precede their message's first delta` (both handlers).
- [ ] **Steps 2–5:** FAIL → implement → PASS (full suite) → commit `feat(chat): early stream, follow phase and message ids in both handlers`.

### Task 7: SSE becomes a view

**Files:**
- Modify: `srv/lib/dialogue-events-handler.ts`
- Test: `test/unit/dialogue-events.test.ts`

**Interfaces:**
- `attach` sends `message` events from `outbox.history(lastEventId)`: confirmed and pending messages, complete only. It never sends `settled`.
- `POST /v1/session/events/ack` answers 204 and changes nothing. Keep the route so already open old WebUI tabs do not fail, and mark it deprecated in a comment.

- [ ] **Step 1: Failing tests:**
  - `the view shows confirmed messages too`;
  - `ack route changes nothing`;
  - `settled is not sent`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat(events): SSE is a read-only view of the session`.

### Task 8: WebUI as an ordinary streaming client

**Files:**
- Modify: `app/chat/webapp/index.html` (`sendMessage` l.1807-2140, SSE consumer l.530-613)
- Test: `test/unit/webui-dialogue.test.ts`

**Interfaces:**
- **One rendering per id:** a map `messageViews: Map<string, { node: Element; complete: boolean }>`, shared by the SSE consumer and `sendMessage`.
  - A complete version (an SSE `message`, or a stream segment that ended because the next `: message-id` came or the terminal came) replaces a partial one.
  - A partial version never replaces a complete one.
  - A segment cut by a broken stream stays partial until a complete version arrives.
- **Acknowledgement:**
  - `sendMessage` sends `x-clh-ack: none` on the first request of a session, and afterwards the id of the last message it received complete.
  - Remember the id per session key in memory; on a page reload start with `none`.
  - Remove the SSE ack call (l.595).
- **Stream segments:** `sendMessage` splits the stream into segments at `: message-id <id>` comments. Each segment renders into its own AGENT block keyed by id. Content before the first id comment keeps today's placeholder behaviour, for non-dialogue answers.

- [ ] **Step 1: Failing tests** (vm harness):
  - `renders each id once across stream and SSE, both orders`;
  - `a complete SSE message replaces a cut stream segment`;
  - `sends x-clh-ack none first, then the last complete id`;
  - `no SSE ack request is made`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → commit `feat(webui): render by message id, x-clh-ack, no SSE ack`.

### Task 9: Configuration, documentation, CHANGELOG

**Files:**
- Modify: `docs/llm-agent/CONFIG_USAGE.md` ("Chat coordinator" table l.199-212):
  - add `LLM_AGENT_DIALOGUE_FOLLOW_MAX_MS`;
  - rewrite the paragraph at l.212 for the follow, delivery and `x-clh-ack`.
- Modify: `docs/architecture/ARCHITECTURE.md:791`.
- Modify: `mta.yaml` and `docs/deployment/templates/*.mtaext.template`, but only if the setting is exposed as a deploy parameter. Default: do not expose it.
- Modify: `CHANGELOG.md` `### Added` / `### Changed` under `## [Unreleased]`.

- [ ] **Step 1:** Write the docs. Run `npm run docs:check` → no new errors (the known environmental package errors excepted). Commit `docs: follow phase, delivery and x-clh-ack`.

### Task 10: Live verification on the POC

No code. After release and deploy (with the user's go-ahead), run the spec's acceptance scenarios that this step covers, through the Playwright MCP browser and the OpenAI and Anthropic SDK scripts in `$TEMP/oai`:

- **Main flow:** 1, 2, 3.
- **Stream lifecycle:** 7, 8, 8a, 9, 10, 10a.
- **Delivery:** 14, 15, 15a, 16, 17.

Record the results in `docs/superpowers/verification/2026-10-25-protocol-follow-delivery.md`, without engagement details.

- [ ] **Step 1:** Run each scenario and record pass or fail with evidence (log lines, ids). Commit the record.

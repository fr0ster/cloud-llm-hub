# Client protocol: plain OpenAI and Anthropic clients get the WebUI behaviour

Status: draft (design only, no code yet)
Date: 2026-10-24

## Principle

The WebUI talks to the hub only through the OpenAI and Anthropic protocols.
Anything the WebUI can do, a third-party OpenAI or Anthropic client can do the
same way, with the same results. No outcome depends on a WebUI-only channel.

## Problem

A live test compared the WebUI with the official `openai` JS SDK on the same
dialogue-planner task: read a list of items from SAP, store one record per
item in a user-scope collection, and check the count with the checker.

With a long session, an SAP destination and SAP credentials in headers, the
SDK got the same result as the WebUI: every record stored with user scope,
checker `pass`, plan `done`. Getting there showed three gaps and one behaviour
that stays:

| # | Observation (default configuration) | What the client saw |
|---|---|---|
| 1 | A chat request with neither the `x-clh-session` header nor a valid `clh_session` cookie is refused while plain mode (`LLM_AGENT_PLAIN_API`) is off | `400 SESSION_REQUIRED`; the client must call `POST /v1/session` first, which is not part of either protocol |
| 2 | A session that resolves to no destination (none in the request, the session or the configuration) runs in LLM-only mode: no tools and no planner | The model answered "saved the records, the checker confirmed the count" within seconds. Nothing was saved; the collection does not exist |
| 3 | The destination and SAP credentials travel in `X-SAP-*` headers | Works; kept as is (section 3) |
| 4 | The turn ends as soon as the planner has started work ("I will let you know") | Progress and the final result went only to `/v1/session/events` (SSE), which a protocol client does not know; they reached the client only when it sent another message |

An unreachable destination that the request names is refused (`503` with
`Retry-After`) and is not part of gap 2. Gap 2 is the most dangerous one: a
confident, invented success.

## Design

### 1. Session without a custom header

The `x-clh-session` header stays and wins; the `clh_session` cookie comes
next, as today. Without either, an authenticated user's conversation is found
by its fingerprint.

**Who gets a fingerprint.** Only a named user (`technical: false`). A
technical caller (client credentials, user id `system`) shares one identity
across all its clients, so it keeps `SESSION_REQUIRED` and must use the
header. Plain mode, where enabled, is unchanged.

**What the fingerprint is.** A hash over:

- the user id;
- the resolved destination and the SAP login of the request (not the
  password); a different principal or destination is a different
  conversation;
- the system prompt and the first user message of the request history;
- the first assistant message of the history.

The first assistant message is the hub's own first reply. It makes two
conversations with the same opening differ, because each got its own reply.

**Lifecycle.**

- A request whose history has no assistant message is a new conversation: it
  always opens a new session, even when an earlier conversation had the same
  opening. A retried first request therefore opens a second session; the
  unused one expires as usual.
- The hub binds the fingerprint to the session when it finishes the first
  reply (that is when the first assistant message exists). The binding is
  created under the session lock and is unique: a second binding of the same
  value is refused, and that conversation answers `SESSION_REQUIRED` with a
  hint to use the header (an exact duplicate first reply is the only way to
  get there).
- The binding lives exactly as long as the session, including revival; a
  closed or expired session drops it, and the next request with that history
  gets `SESSION_NOT_FOUND`, as a header key would.
- A client that drops the first messages of the history (context trimming)
  loses the fingerprint and starts a new session. Such clients should use the
  header or the cookie; the documentation says so.
- Every response carries the key in `x-clh-session`, so a client that can
  read headers can switch to the explicit form.

### 2. No tools: refuse actions, never imitate them

In LLM-only mode no tool can run, so any claim of a performed action is
invented. Before generating the reply, the hub asks the LLM (the classifier
model when set, otherwise the main model) one structured question: does this
request ask to perform an action in a system (save, change, run, check,
delegate), or only for an answer? The LLM decides; there is no keyword list.

- An answer-only request is answered as today.
- An action request gets a plain reply, without a generation pass: it cannot
  be done in this session, and what is missing (an SAP destination).

The decision is made before any text is emitted, so it works the same for
streaming and non-streaming clients, and nothing has to be retracted. The
system prompt of LLM-only mode also states the rule, as a second line.

Dialogue sessions do not need this guard: their `[actions]` records come from
the hub's own task records, never from model text (llm-agent 30.9.x).

### 3. Destination and credentials stay in headers

No change. The destination (`X-SAP-Destination`) and the SAP credentials
(`X-SAP-Login`, `X-SAP-Password`, `X-SAP-Client`) arrive in request headers,
as today, and are never stored in the destination. A client that works with
SAP must be able to send these headers; this is a client requirement, not a
gap the hub works around.

### 4. The turn ends only at a real stop

**Phases of a request.** A chat request in a dialogue session has two phases:

1. **Turn**: the planner's turn runs under session admission
   (`longSessions().run()`), as today.
2. **Follow**: after the planner's turn, admission is released and the
   response stays open, waiting on the session outbox. It holds no lock and
   no connection lease.

At most one follow is open per session. A new request in the same session
(a correction, a cancellation, a question) is admitted at once, because the
follow holds no admission. It closes the previous follow, which ends with a
short note that a new message arrived. Its own response carries any messages
the previous follow had not delivered, followed by the planner's answer to
the new message. The planner sees the user's message while the workers keep
running, as today.

**When the follow ends.** The follow ends at the first of:

- the plan is `done`;
- the plan is `waiting_user` (the question is the end of the turn; the next
  user message answers it);
- the plan is idle: nothing is running, queued or ready, so no message will
  come without the user;
- a wait limit (below);
- the client disconnects.

The plan statuses are the existing `active`, `waiting_user` and `done`; a
failed step does not end the follow while other work runs, and a plan with
only failed steps left is idle. An ordinary reply without a plan has no
follow and ends as today.

**Streaming clients** (`stream: true`):

- planner messages from the outbox go out as content deltas of the same
  message, separated by a paragraph break: OpenAI `delta.content` chunks of
  one completion, Anthropic `content_block_delta` events of one text block;
- the existing keep-alives stay as they are (an SSE comment every 10 s in
  both handlers); there is no change of interval or framing;
- the end is exactly one terminal sequence: OpenAI a final chunk with
  `finish_reason: "stop"` and usage summed over the turn and the follow,
  then `data: [DONE]`; Anthropic `content_block_stop`, `message_delta` with
  `stop_reason: "end_turn"` and usage, then `message_stop`;
- a hub error during the follow ends the stream with the protocol's error
  form (OpenAI an error chunk, Anthropic an `error` event) and no success
  terminal;
- a follow has a maximum duration (configurable, default 30 minutes); at the
  limit the stream ends normally with a status line ("still running: N of M
  steps done") and the remaining messages wait for the next request.

**Non-streaming clients** (`stream: false`):

- the response is held during the follow and returned as one message: the
  planner's turn text, then the outbox messages, earlier progress in short
  form and the last message in full;
- a held non-streaming response sends no bytes, so it meets every idle
  timeout on the path (client, proxies, platform router; the code documents
  failures at about 22 s of silence). The wait limit must stay below the
  smallest of them: a configurable value with a start value of 15 s,
  raised only where the path is known to allow more;
- at the limit, the reply ends normally (OpenAI `finish_reason: "stop"`,
  Anthropic `stop_reason: "end_turn"`) with a status line ("still running:
  N of M steps done; send any message for the result");
- a timeout or a disconnect never stops the background work;
- the next request is any user message; the protocols have no empty turn.
  Its reply starts with every undelivered message, then the planner's answer
  to the message.

### 5. Delivery

The guarantee is **at least once, in order, per session**, with duplicates
avoided in the normal path.

- The protocol response is the delivery channel. Every planner message stays
  in the outbox until it is acknowledged.
- **Acknowledgement boundary.** A response that ended normally (the terminal
  sequence written and the response finished without an error) marks its
  messages as sent. The next request of the same session confirms them, and
  only then are they acknowledged. A response that was cut leaves its
  messages for replay in the next response.
- A message that was sent but whose confirming request never comes stays
  marked as sent; the next request of the session confirms it and does not
  replay it. A message whose response was cut is replayed once. For the
  WebUI, each message also carries its id as an SSE comment, so the WebUI
  can drop a duplicate. Plain clients may see a duplicate in rare cut-off
  cases; they never lose a message.
- The SSE channel `/v1/session/events` becomes a view. It shows the outbox
  and the plan and task panels to any number of tabs. It never acknowledges
  and never suppresses protocol delivery. The current `hasSubscribers()`
  replay suppression in `dialogue-chat.ts` goes, and so does the WebUI's SSE
  ack. Several tabs therefore cannot take messages away from each other.

### 6. The WebUI becomes an ordinary streaming client

The WebUI uses the streaming form of section 4. The SSE channel stays for
the panels (plan, tasks, active agents) and for several tabs, but everything
the user must see also arrives in the protocol response. Status comments
(`: status {json}`) remain an optional extension that plain clients ignore.

## Acceptance

Each scenario runs in the WebUI, with the official OpenAI and Anthropic SDKs
(streaming and non-streaming), and with one real third-party client. All must
give the same results. Fixtures are synthetic: a read-only SAP list (for
example the newest runtime errors of a test system) and test collections that
the run creates and removes.

**Main flow**

1. Read N items from SAP, store one record per item in a user-scope
   collection, check the count: N records with user scope, checker `pass`,
   plan `done`, with no message besides the task and the planner's
   questions.
2. A task where the planner must ask: the question ends the turn, the next
   user message answers it.
3. The user changes the task while a long stream is open: the new request is
   admitted at once, the old stream ends with the note, and the planner works
   with the change.

**No tools**

4. An action request in LLM-only mode: a plain refusal naming the missing
   destination; no invented result, streaming or not.
5. An answer-only request in LLM-only mode is answered normally.

**Stream lifecycle**

6. Silence longer than the idle timeouts, several planner messages, a failed
   step, and a hub error: exactly one terminal sequence each time, keep-alives
   during silence, the error form on error.
7. A disconnect in the middle of a stream: the work continues, and the next
   request replays the messages of the cut response.

**Non-streaming**

8. A run longer than the wait limit: the status reply, then the accumulated
   messages on the next request; a run that finishes between two polls;
   repeated polling; an early client disconnect and a retry.

**Delivery**

9. Two WebUI tabs and one SDK client on the same session: no message lost
   in the protocol channel, both tabs show the panels, no tab removes
   messages from the other.
10. A response that ended normally, then no request for a long time, then a
    new request: the earlier messages are confirmed, not replayed.

**Sessions**

11. Two conversations of the same user with the same system prompt and the
    same first message: two sessions.
12. Concurrent first requests with the same opening: separate sessions,
    no shared binding.
13. The same history with a different destination or SAP login: a different
    session.
14. A client that trims the first messages: a new session (documented).
15. A technical caller without the header: `SESSION_REQUIRED`.

## Rollout

1. Section 2 (refusal in LLM-only mode): it stops invented results today.
2. Sections 4 and 5 for streaming clients, together with the delivery change.
3. Section 4 for non-streaming clients.
4. Section 1 (fingerprint sessions).
5. The WebUI on the streaming form; the SSE channel becomes a view.

## Open questions

- The wait limit for non-streaming clients: the start value of 15 s, or a
  measured value per deployment.

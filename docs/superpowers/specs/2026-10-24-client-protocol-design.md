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
next, as today. Without either, the session key travels in the conversation
itself.

**Who gets it.** Only a named user (`technical: false`). A technical caller
(client credentials, user id `system`) shares one identity across all its
clients, so it keeps `SESSION_REQUIRED` and must use the header. Plain mode,
where enabled, is unchanged.

**How it works.**

- A request with no key (no header, no cookie, no key in the history) opens a
  new session. This includes every first request: two conversations with the
  same opening are always two sessions.
- A retried first request opens a second session, because the client has no
  key yet. When the first response was lost after the work had started, the
  work of the first session continues and the retry may do it again,
  including writes: an opening request that asks for an SAP change or a
  collection write can be carried out in its first turn. The hub cannot tell
  a retry from a new conversation without a key, so this is not
  deduplicated; it is a stated limit. A client that retries automatically
  should open the session explicitly (`POST /v1/session` and the header).
- The first reply of such a session ends with one reserved line that the
  hub appends after generation, as its own last line:
  `[clh-session: ls-<uuid>]`. Every protocol client sends the history back,
  so the key returns with every later request.
- Extraction is strict. The hub reads only the first assistant message of the
  history and only its last line, and that line must match the reserved form
  exactly. Keys anywhere else (quoted transcripts, examples, later replies,
  the model's own text) are ignored, so no text can redirect a conversation
  to another session. A first assistant message without a valid last line
  (missing or malformed) means no key. If the model's generated text happens
  to end with a line of the reserved form, the hub still appends its own
  line after it, so the last line is always the hub's.
- The key from the history is used exactly like a header key:
  `resolveSession(userId, key)` finds the session only for the same user
  (live or revived), and an unknown or expired key answers
  `SESSION_NOT_FOUND`. The header and the cookie win over it.
- The principal and destination checks are the existing ones for header keys:
  the effective SAP identity (`effectiveSapIdentity`, which covers incomplete
  credential headers and configured authentication), the destination and the
  SAP client are fixed for a dialogue session, and a change answers
  `DIALOGUE_PRINCIPAL_FIXED` or `DIALOGUE_DESTINATION_FIXED`, as today. The
  key in the history never widens what the header would allow.
- A history that has assistant messages but no key (the client trimmed the
  first reply) opens a new session. The rule is the same as for a request
  without a key, so there is nothing to tell apart. Clients that trim the
  history should use the header or the cookie; the documentation says so.
- Every response also carries the key in `x-clh-session`, so a client that
  can read headers can switch to the explicit form and the line can be
  hidden.

The key is not a secret on its own: a session is bound to its user, and
another user presenting the key gets `SESSION_NOT_FOUND`, as with the header
today.

### 2. No tools: refuse actions, never imitate them

In LLM-only mode no tool can run, so any claim of a performed action is
invented. This covers every action, not only SAP operations: storing or
changing collection documents, tool-driven collection searches, checks and
delegation are unavailable too, because LLM-only mode has no tools at all.
Tool-driven collection operations without a destination stay out of scope:
they need the dialogue workers, which need a destination.

Retrieval for answers is not an action. Today the OpenAI handler searches
the collections a request selects and adds the results to the context before
generation, with or without a destination. That path is the OpenAI handler's
own: the Anthropic handler has no collection selection, and in dialogue mode
the planner turn does not receive the injected context (the dialogue adapter
ignores the supplied messages).

For parity the retrieval becomes one shared step used by both handlers, and
its results reach the planner turn in dialogue mode as context of the user's
message. An answer from a selected collection is then an answer, not an
imitation, in every mode and in both protocols.

Before generating the reply, the hub asks the LLM (the classifier model when
set, otherwise the main model) one structured question: does this request ask
to perform an action (in SAP, in a collection, a check, a delegation), or
only for an answer? The question sees the recent history, so a follow-up such
as "do it now" after an answer is judged in context. The LLM decides; there
is no keyword list.

- An answer-only request is answered as today.
- An action request gets a fixed reply, without a generation pass: it cannot
  be done in this session, and why (no SAP destination, or the destination
  is unreachable).
- When the decision fails (an error or an unusable answer), the reply is the
  same fixed text with one more sentence: questions without actions can be
  asked again. No generation pass runs, so nothing can be imitated.

The decision is made before any text is emitted, so it works the same for
streaming and non-streaming clients, and nothing has to be retracted.

The LLM-only system prompt also changes. Today it says only "if the user asks
to perform SAP operations, explain that SAP connectivity is not available".
It will say that no action of any kind (SAP, collections, checks, delegation)
can run in this session, and that the reply must never report one as done.
This covers answer-only replies that drift into describing an action.

A tool that is not available because of the caller's role is a different
case: there is a destination, the tool exists, and the role does not allow
it. That is reported as a role denial by the existing exposition rules,
never as a missing destination.

Dialogue sessions are outside this section. Their `[actions]` records come
from the hub's task records, but the planner's free text can still claim
work that did not happen. That is handled by the planner prompt design
(no claims without a tool call that succeeded in this turn) and is not
solved here.

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

**Session lifetime.** Releasing admission must not let the session expire
under live work. While any task of the session is running or queued, the
session holds a lifetime hold in the session registry, which the expiry
sweep treats like an active request: it does not depend on events, so a
worker waiting silently on SAP, the LLM or admission is covered. An open
follow touches the session on every keep-alive, as the events channel does
today. Once nothing is running or queued (the plan is idle, done or waiting
for the user), the hold is released and the release touches the session, so
the TTL counts from the end of the work, not from an older activity; expiry
then closes the dialogue as today.

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

A stop takes effect only after the planner turn that produced it has
settled, its messages are in the outbox, and the follow has sent them. The
plan state is not enough on its own: today the persistence callback publishes
the plan (`emitPlan`) before it adds the turn's messages to the outbox, so the
follow waits for the outbox write of that turn, not for the plan event. The
final result or the question therefore always comes before the protocol
terminal.

The plan statuses are the existing `active`, `waiting_user` and `done`; a
failed step does not end the follow while other work runs, and a plan with
only failed steps left is idle. An ordinary reply without a plan has no
follow and ends as today.

**Streaming clients** (`stream: true`):

- planner messages from the outbox go out as content deltas of the same
  message, separated by a paragraph break: OpenAI `delta.content` chunks of
  one completion, Anthropic `content_block_delta` events of one text block;
- keep-alives keep their framing and interval (an SSE comment every 10 s in
  both handlers) but start when the request arrives, not after admission,
  connection set-up and agent initialization as today. Destination
  initialization alone can wait 90 s by default, far beyond the idle
  timeouts, so the stream headers and the first keep-alive go out at once;
- an error before the first content (admission, connection, initialization)
  ends the stream with the protocol's error form; a refusal that today is an
  HTTP status (for example `503` with `Retry-After`) stays an HTTP status
  when it is known before the stream starts;
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

- a held non-streaming response sends no bytes, so it meets every idle
  timeout on the path (client, proxies, platform router; the code documents
  failures at about 22 s of silence). Its budget therefore counts from the
  arrival of the request and covers everything: the admission wait, the
  connection set-up, the planner's turn and the follow. The budget is
  configurable with a start value of 15 s and is raised only where the path
  is known to allow more;
- within the budget the reply is one message assembled by one rule: every
  complete pending outbox message once, by id, in outbox order, in full. The
  current planner reply is an outbox message too (section 5), so it appears
  once in its place, after the messages pending from earlier requests.
  Nothing is shortened, so every message the reply carries counts as
  delivered complete. Streaming follows the same order;
- at the budget, the reply ends normally (OpenAI `finish_reason: "stop"`,
  Anthropic `stop_reason: "end_turn"`) with what is ready and a status line
  ("still running: N of M steps done; send any message for the result").
  When the planner's turn itself is still running, it continues in the
  background under its admission, and its text is delivered like an outbox
  message;
- a request that arrives while a turn of its session still runs is queued
  for admission. At the budget it gets a status reply that says its message
  is accepted and waits for the current turn ("your message is queued and
  will be handled next"), instead of `SESSION_BUSY`. The queued message stays
  queued and runs exactly once, after the current turn; its answer is
  delivered like an outbox message;
- one queued message per session: a further request while a message is
  already queued is refused with a status reply that names the waiting
  message ("a message is already waiting; send this again after it is
  handled"). This only prevents piling up while the slot is taken. A request
  that arrives when the slot is free is an ordinary user message: the
  protocols have no separate poll, so "status?" is a message to the planner,
  which answers it as a question and does not treat it as a new task;
- a timeout or a disconnect never stops the background work;
- the next request is any user message; the protocols have no empty turn.
  Its reply follows the same assembly rule, so the messages pending from
  earlier requests come first and the planner's answer to the new message
  after them.

### 5. Delivery

Neither protocol has a receipt: the hub knows that it finished a response,
never that the client stored it. The guarantee is therefore stated for what
the hub can see:

- **Every planner message is delivered at least once to the session.** It
  stays pending in the outbox until a response that carried it has ended
  normally (its terminal sequence written and the response finished without
  an error) and a later request of the session has arrived, or until a
  request names it in `x-clh-ack: <message id>`. A response that was cut
  before its terminal sequence never counts; its messages are delivered
  again in the next response.
- **Nothing is deleted with the pending mark.** Every delivered message stays
  in the session history, which the hub already keeps for server-managed
  sessions. The WebUI shows that history in every tab through the SSE view,
  so a tab that missed a response still sees its messages.
- **Limits, stated plainly.** For a plain client:
  - a response that the server finished but the client lost, followed by a
    new request from the same client, is not delivered again;
  - with several plain clients on one session, a message is delivered to the
    first of them that sends a request; the others do not get it.
- **Explicit acknowledgement mode** removes the first limit for a client that
  can send a header:
  - a session enters it when a request carries `x-clh-ack`, with a message id
    or `none`; a client sends `x-clh-ack: none` with its first request to be
    in this mode from the start. The mode lasts for the session;
  - in this mode only the ack confirms: a later request no longer confirms
    anything by arriving. A request without the header confirms nothing; a
    request whose ack names an older message confirms up to that message,
    and everything after it is delivered again;
  - confirmation follows what was delivered, not the current state of the
    outbox. Each response's delivery record lists the messages it carried in
    complete form. A confirmation (by ack or by arrival) covers only messages
    in the delivery records of responses that ended normally, and only up to
    the named message in outbox order, over a contiguous run: a message that
    no such response carried complete stops it, even if it has completed
    since. It is delivered complete in a later response. This replaces
    today's `DialogueOutbox.ack()`, which removes the whole prefix whatever
    was delivered;
  - message ids reach both forms: a streaming response carries each id as an
    SSE comment before the message; a non-streaming response carries the id
    of its last message in the `x-clh-last-message` response header.
  Clients that use neither mode should keep one client per session, which the
  key in the conversation (section 1) gives by default.
- **Message identity while streaming.** The planner's reply in a turn gets
  its outbox id when the turn starts. Its partial deltas carry that id (the
  SSE comment precedes the first delta), and the outbox record is completed
  with the full text when the turn ends. The SSE view shows a message only
  when it is complete. The WebUI keeps one rendering per id: a complete
  version, from either channel, replaces whatever partial text it showed for
  that id; a partial never replaces a complete one. A stream cut after
  partial content delivers nothing for that id; the next response delivers
  the complete message, which replaces the partial rendering.
- The SSE channel `/v1/session/events` becomes a view of the session history,
  the plan and the tasks for any number of tabs. It never marks anything
  delivered and never suppresses protocol delivery: the current
  `hasSubscribers()` replay suppression in `dialogue-chat.ts` goes, and so
  does the WebUI's SSE ack. The WebUI renders each message once by its id,
  whichever channel shows it first.

### 6. The WebUI becomes an ordinary streaming client

The WebUI uses the streaming form of section 4 in explicit acknowledgement
mode (`x-clh-ack`). The SSE
channel stays for the panels (plan, tasks, active agents) and for several
tabs, but everything the user must see also arrives in the protocol response.
Status comments (`: status {json}`) remain an optional extension that plain
clients ignore.

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
5. An answer-only request in LLM-only mode is answered normally; a follow-up
   "do it" after it is refused.
6. The decision call fails or returns an unusable answer: the fixed reply,
   no generation pass.
6a. Collection writes, tool-driven searches and a checker request without a
   destination: the fixed refusal, no invented result.
6c. A question answered from a selected collection, in both protocols:
   without a destination, and in dialogue mode with a destination; the
   answer uses the retrieved documents each time.
6b. With a destination, a Reader caller asks for an operation only a
   Developer may run: a role denial, not a missing-destination reply; a
   Developer caller gets the operation.

**Stream lifecycle**

7. Normal completion after silence longer than the idle timeouts, during
   the admission wait, the destination initialization and the follow, and
   several planner messages: keep-alives from arrival and exactly one
   success terminal sequence. An initialization error before the first
   content: the protocol's error form.
8. A failed step while other work runs: the follow continues; a plan with
   only failed steps left ends the follow with one success terminal.
8a. A pause between the plan becoming `done` or `waiting_user` and the
   outbox write of that turn, in both protocols and both response forms: the
   result or the question arrives before the terminal.
9. A hub error after partial follow content, for both protocols: the error
   chunk or event and no success terminal.
10. A disconnect in the middle of a stream: the work continues, and the next
    request receives the messages of the cut response.
10a. A session TTL shorter than the run, with no `/v1/session/events`
    connection, including a task that waits silently (a slow SAP or LLM call,
    an admission wait) longer than the TTL: an open follow and, after a
    disconnect, the hold keep the session alive to the end of the plan; the
    session expires one TTL after nothing is running or queued, and a request
    just after a disconnected, silent run still gets its result.

**Non-streaming**

11. A slow planner turn that alone exceeds the budget: the status reply
    within the budget, the turn's text on the next request.
12. A run longer than the budget: the status reply, then the accumulated
    messages on the next request; a run that finishes between two polls;
    repeated polling; an early client disconnect and a retry.
12a. Results pending from a previous request, then a new non-streaming turn:
    the pending results once, then the new reply once, in outbox order.
13. A request while a turn of the session still runs: the "queued" status
    reply at the budget, never `SESSION_BUSY`; the message runs once after
    the turn.
13a. A correction queued and timed out, then repeated polls across the
    queued, running and completed states: the correction runs exactly once;
    polls while it waits get the "already waiting" reply; polls after it
    started reach the planner as ordinary messages, and a "status?" poll
    starts no new work.

**Delivery**

14. Two WebUI tabs on one session: every message rendered once in each tab,
    including in a tab whose stream was cut. Both orderings: the protocol
    stream first and the SSE view first; a cut after partial content ends
    with the complete message rendered once.
15. A stream cut after the last content delta but before `[DONE]` or
    `message_stop`: the messages are delivered again in the next response.
15a. A planner reply still streaming while a background message completes,
    and another tab acks the background message: the streaming reply is not
    confirmed and arrives complete in a later response. The same when the
    reply completes before the ack arrives, for both response forms (the ack
    in a stream comment and in `x-clh-last-message`): the reply was never
    carried complete, so it is not confirmed.
15b. Several pending progress messages, repeated non-streaming requests, and
    an ack of the last id each time: every message arrives in full once and
    the acknowledgement advances to the last id.
16. Explicit acknowledgement mode, streaming and non-streaming: a response
    lost after the server finished it, then a request without the header,
    then one with an older ack: nothing is confirmed by the first, the second
    confirms up to its id, and the lost messages are delivered again. The
    non-streaming client takes the ids from `x-clh-last-message`.
17. Without explicit mode: the documented limit, no duplicates in the normal
    path.

**Sessions**

18. Two conversations of the same user with the same system prompt, the same
    first message and the same first reply (for example the fixed refusal):
    two sessions, each with its own key in its first reply.
19. Concurrent first requests with the same opening: separate sessions.
19a. The first response is lost after the work started (including a
    disconnect before the session line): the retry opens a second session;
    the first session's work continues to its end.
20. A key in the history with a different SAP client, an incomplete
    credential header, or configured authentication: the same principal
    checks as for a header key.
21. A key of an expired session: `SESSION_NOT_FOUND`, or revival where the
    record allows it, as for a header key.
22. A client that trims the first reply: a new session (documented); a
    client that trims older messages but keeps the first reply: the same
    session.
23. A technical caller without the header: `SESSION_REQUIRED`; another user
    presenting a key: `SESSION_NOT_FOUND`.
24. Marker cases: a key quoted in a later reply or in the user's text, two
    keys in the history, a malformed reserved line, and a model reply that
    ends with a reserved-looking line: only the hub's last line of the first
    reply counts; a header or cookie wins over it.

## Rollout

1. Section 2 (refusal in LLM-only mode): it stops invented results today.
   The shared retrieval step for both handlers and dialogue mode follows in
   the same section's second change.
2. Sections 4 (streaming), 5 and 6 together: the delivery change and the
   WebUI change (no SSE ack, `x-clh-ack`, rendering by message id) ship in
   one release, so the WebUI never sees duplicates or loses messages during
   the transition.
3. Section 4 for non-streaming clients.
4. Section 1 (the key in the conversation).

## Open questions

- The budget for non-streaming clients: the start value of 15 s, or a
  measured value per deployment.

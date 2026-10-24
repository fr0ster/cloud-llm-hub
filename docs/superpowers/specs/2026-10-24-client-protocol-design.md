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
  same opening are always two sessions, and a retried first request opens a
  second session whose unused copy expires as usual.
- The first reply of such a session ends with one short visible line naming
  the session, for example `Session: ls-…`. Every protocol client sends the
  history back, so the key returns with every later request.
- A later request carries the key in an assistant message of its history.
  The hub takes the key from the most recent assistant message that has one
  and treats it exactly like a header key: `resolveSession(userId, key)`
  finds the session only for the same user (live or revived), and an unknown
  or expired key answers `SESSION_NOT_FOUND`.
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
invented. Before generating the reply, the hub asks the LLM (the classifier
model when set, otherwise the main model) one structured question: does this
request ask to perform an action in a system (save, change, run, check,
delegate), or only for an answer? The LLM decides; there is no keyword list.

- An answer-only request is answered as today.
- An action request gets a plain reply, without a generation pass: it cannot
  be done in this session, and what is missing (an SAP destination).

The decision is made before any text is emitted, so it works the same for
streaming and non-streaming clients, and nothing has to be retracted. The
question sees the recent history, so a follow-up such as "do it now" after an
answer is judged in context. When the decision fails (an error or an
unusable answer), the reply is generated as today under the LLM-only system
prompt, which also states the rule: it is the second line, not a bypass.

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

- a held non-streaming response sends no bytes, so it meets every idle
  timeout on the path (client, proxies, platform router; the code documents
  failures at about 22 s of silence). Its budget therefore counts from the
  arrival of the request and covers everything: the admission wait, the
  connection set-up, the planner's turn and the follow. The budget is
  configurable with a start value of 15 s and is raised only where the path
  is known to allow more;
- within the budget the reply is one message: the planner's turn text, then
  the outbox messages, earlier progress in short form and the last message
  in full;
- at the budget, the reply ends normally (OpenAI `finish_reason: "stop"`,
  Anthropic `stop_reason: "end_turn"`) with what is ready and a status line
  ("still running: N of M steps done; send any message for the result").
  When the planner's turn itself is still running, it continues in the
  background under its admission, and its text is delivered like an outbox
  message;
- a request that arrives while a turn of its session still runs waits for
  admission within its own budget; at the budget it gets the status reply
  instead of `SESSION_BUSY`;
- a timeout or a disconnect never stops the background work;
- the next request is any user message; the protocols have no empty turn.
  Its reply starts with every undelivered message, then the planner's answer
  to the message.

### 5. Delivery

The guarantee is **no loss, in order, per session**. Duplicates are avoided
whenever the client gives proof of receipt.

- The protocol response is the delivery channel. Every planner message stays
  in the outbox until a proof of receipt confirms it. A response records the
  messages it carried (its delivery record).
- **Proof of receipt** is tied to the response that carried the messages, not
  to the session:
  - the next request's history contains the assistant text of that response
    (every OpenAI and Anthropic client that sends the history gives this
    proof); or
  - the request carries `x-clh-ack: <last message id>` (the WebUI, and any
    client that wants to).
- Without proof, the messages stay unconfirmed and the next response of the
  session carries them again. A request from another tab or client whose
  history lacks a response therefore does not confirm it: it receives those
  messages itself. A client that sends neither history nor the ack may see a
  duplicate; no client loses a message because another one asked.
- A response that was cut before its terminal sequence is never a delivery,
  whatever the server wrote.
- The SSE channel `/v1/session/events` becomes a view. It shows the outbox
  and the plan and task panels to any number of tabs. It never acknowledges
  and never suppresses protocol delivery: the current `hasSubscribers()`
  replay suppression in `dialogue-chat.ts` goes, and so does the WebUI's SSE
  ack. Each message also carries its id as an SSE comment in the protocol
  stream, so the WebUI renders it once whichever channel shows it first.

### 6. The WebUI becomes an ordinary streaming client

The WebUI uses the streaming form of section 4 and sends `x-clh-ack`. The SSE
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
6. The decision call fails or returns an unusable answer: the reply is
   generated under the LLM-only system prompt and claims no action.

**Stream lifecycle**

7. Normal completion after silence longer than the idle timeouts and several
   planner messages: keep-alives during silence and exactly one success
   terminal sequence.
8. A failed step while other work runs: the follow continues; a plan with
   only failed steps left ends the follow with one success terminal.
9. A hub error after partial follow content, for both protocols: the error
   chunk or event and no success terminal.
10. A disconnect in the middle of a stream: the work continues, and the next
    request receives the messages of the cut response.

**Non-streaming**

11. A slow planner turn that alone exceeds the budget: the status reply
    within the budget, the turn's text on the next request.
12. A run longer than the budget: the status reply, then the accumulated
    messages on the next request; a run that finishes between two polls;
    repeated polling; an early client disconnect and a retry.
13. A request while a turn of the session still runs: the status reply at
    the budget, never `SESSION_BUSY`.

**Delivery**

14. Two WebUI tabs and one SDK client on the same session: no message lost
    in any of them, both tabs show the panels, each message rendered once
    per tab.
15. A response lost downstream after the server finished it, then a request
    from another tab: that request does not confirm the lost response and
    receives its messages.
16. A client that sends the history: no duplicates. A client that sends
    neither history nor the ack: duplicates allowed, no loss.

**Sessions**

17. Two conversations of the same user with the same system prompt, the same
    first message and the same first reply (for example the fixed refusal):
    two sessions, each with its own key in its first reply.
18. Concurrent first requests with the same opening: separate sessions.
19. A key in the history with a different SAP client, an incomplete
    credential header, or configured authentication: the same principal
    checks as for a header key.
20. A key of an expired session: `SESSION_NOT_FOUND`, or revival where the
    record allows it, as for a header key.
21. A client that trims the first reply: a new session (documented); a
    client that trims older messages but keeps the first reply: the same
    session.
22. A technical caller without the header: `SESSION_REQUIRED`; another user
    presenting a key: `SESSION_NOT_FOUND`.

## Rollout

1. Section 2 (refusal in LLM-only mode): it stops invented results today.
2. Sections 4 (streaming), 5 and 6 together: the delivery change and the
   WebUI change (no SSE ack, `x-clh-ack`, rendering by message id) ship in
   one release, so the WebUI never sees duplicates or loses messages during
   the transition.
3. Section 4 for non-streaming clients.
4. Section 1 (the key in the conversation).

## Open questions

- The budget for non-streaming clients: the start value of 15 s, or a
  measured value per deployment.

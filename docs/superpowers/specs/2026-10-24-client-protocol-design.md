# Client protocol: plain OpenAI and Anthropic clients get the WebUI behaviour

Status: draft (design only, no code yet)
Date: 2026-10-24

## Principle

The WebUI talks to the hub only through the OpenAI and Anthropic protocols.
Anything the WebUI can do, a third-party OpenAI or Anthropic client can do the
same way, with the same results. There is no WebUI-only channel the outcome
depends on.

## Problem

A live test on the POC (hub 9.3.0, executor Sonnet 4.5, planner Opus 4.6)
compared the WebUI with the official `openai` JS SDK on the same task: analyse
the ten newest ST22 dumps of the last 24 hours, store one record per dump in a
user-scope collection, and check the count with the checker.

With a session, an SAP destination and SAP credentials in headers, the SDK got
the same result as the WebUI: ten records, user scope, checker `pass`, plan
`done`, in about five minutes. Getting there showed three gaps (and one
behaviour that stays):

| # | Gap | What the client saw |
|---|---|---|
| 1 | A request without `x-clh-session` is refused | `400 SESSION_REQUIRED`; the client must call `POST /v1/session` first, which is not part of either protocol |
| 2 | A session without a destination has no tools at all, not even RAG, and no planner | The model answered "saved 5 records, the checker confirmed 5" in under ten seconds. Nothing was saved; the collection does not exist |
| 3 | The destination and SAP credentials travel in `X-SAP-*` headers | Works; kept as is (section 3) |
| 4 | The turn ends as soon as the planner has started work ("I will let you know") | Progress and the final result went only to `/v1/session/events` (SSE), which a protocol client does not know. About ten planner messages reached the client only when it sent another message |

Gap 2 is the most dangerous one: a confident, invented success.

## Design

### 1. Session without a custom header

The `x-clh-session` header stays and wins when present. Without it, the hub
identifies the session itself:

- the `clh_session` cookie, when the client keeps cookies;
- otherwise a conversation fingerprint: the user plus a hash of the first
  user message and the system prompt of the request history. A protocol
  client sends the whole history every turn, so the fingerprint is stable
  across the turns of one conversation and differs between conversations.

A fingerprint with no live session opens one. The response carries the key in
`x-clh-session`, so a client that can read headers can switch to the explicit
form. `SESSION_REQUIRED` remains only for callers that disable the
fingerprint (configuration).

### 2. No tools: refuse actions, never imitate them

When a turn has no tools (no destination, destination unreachable), the
system prompt says so, and the reply must not claim an action. The rule:

- questions and explanations are answered as today;
- a request to save, change, run, check or delegate gets a plain answer that
  it cannot be done in this session, and what is missing (a destination, a
  role);
- RAG tools that do not need SAP (collections, search) stay available without
  a destination, so tasks like gap 2's planets example actually run.

A guard after the reply rejects text that reports tool results (`[actions]`
lines, "saved", "the checker confirmed") when no tool ran in the turn, and
replaces it with the refusal. The guard is a safety net; the prompt is the
first line.

### 3. Destination and credentials stay in headers

No change. The destination (`X-SAP-Destination`) and the SAP credentials
(`X-SAP-Login`, `X-SAP-Password`, `X-SAP-Client`) arrive in request headers,
as today, and are never stored in the destination. A client that works with
SAP must be able to send these headers; this is a client requirement, not a
gap the hub works around.

### 4. The turn ends only at a real stop

The client's turn ends only when one of these holds:

- the plan is finished (`done` or `failed`);
- the planner needs the user (`waiting_user`); the question is the answer;
- a wait limit is reached (non-streaming clients only, see below).

"I will let you know" is not a stop.

**Streaming clients** (`stream: true`):

- the response stays open while the plan runs; planner messages go out as
  ordinary content deltas (OpenAI `delta.content`, Anthropic `content_block_delta`);
- during silence the hub sends keep-alives every 15–20 s so proxies and the
  platform router do not close the stream: an SSE comment `: ping` for OpenAI,
  the protocol `ping` event for Anthropic;
- the stream ends with the final summary and `finish_reason: stop`
  (`stop_reason: end_turn`).

**Non-streaming clients** (`stream: false`):

- the response is held until a stop and returned as one message: earlier
  progress messages in short form, the last message in full;
- HTTP timeouts (client, proxy, platform router) limit the hold. A
  configurable wait limit (default about five minutes) ends the turn with
  "still running: N of M steps done" and `finish_reason: stop`;
- the next request in the session, even an empty "continue" or "status",
  first gets every message delivered since, then waits again.

**Both:**

- each planner message is delivered exactly once, in a stream or in the next
  reply; the existing outbox acknowledgement (`/v1/session/events/ack`) marks
  it delivered when the protocol response has carried it;
- a user message while the plan runs is a new turn of the same session, as
  today.

### 5. The WebUI becomes an ordinary streaming client

The WebUI uses the streaming form of section 4. The `/v1/session/events` SSE
channel stays for extra views (plan and task panels, several tabs), but no
outcome depends on it: everything the user must see also arrives in the
protocol response. Status comments (`: status {json}`) remain an optional
extension that plain clients ignore.

## Acceptance

The same scenarios run in the WebUI, with the official OpenAI and Anthropic
SDKs (streaming and non-streaming), and with one real third-party client.
They must give the same results:

1. The dump task above: ten user-scope records, checker `pass`, plan `done`,
   with no message other than the task (and the planner's questions).
2. A task without a destination that needs SAP: a plain refusal naming the
   missing destination, no invented result.
3. The same task with RAG only (no SAP): it runs and stores the records.
4. A task where the planner must ask: the question ends the turn, the next
   user message answers it.
5. A non-streaming run longer than the wait limit: the status reply, then the
   accumulated messages on the next request.

## Rollout

1. Gap 2 first (refusal and guard): it stops invented results today.
2. Section 4 for streaming, then for non-streaming.
3. Section 1 (fingerprint sessions).
4. The WebUI on the streaming form; the SSE channel becomes optional.

## Open questions

- The default wait limit for non-streaming clients.

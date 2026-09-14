# Gatekeeper: admission control for sessions

**Status:** design, superseding the rate-limit version of the same name
**Date:** 2026-09-13, rewritten 2026-09-14

## TL;DR

One counter of live sessions, shared by every channel, and one queue in front of
it. A session is admitted or it is turned away at the door; once admitted it is
carried to the end, however slowly. One session runs one pipeline, so a single
number answers both. The queue's depth is the only pressure signal we have and
the only one we need: three quarters full means the resource is running out.

## What this replaces, and why

An earlier version of this document gated on the provider's rate limit: a
sliding window of request starts per model per minute, a permit for every HTTP
attempt, a quota key per model.

It answered the wrong question. A rate limit is the same number whether two
sessions are live or two hundred, so it cannot say whether there is room for one
more. The failure it misses is the ordinary one: sessions accumulate slowly,
each holds its history and its context, each runs long — and the rate stays
comfortably inside the limit right up to the moment the container dies. Quota
available, resource gone.

It was also somebody else's constraint. We are not the tenant's only consumer,
so our window could never be authoritative about the provider's limit, and the
document admitted as much in its own known limits. What a rate limit produces
when exceeded is a `429` with an interval, and that is already handled where it
belongs: the provider reports it, the configured strategy waits it out, the
pipeline is slowed and not killed. Nothing above needs to predict it.

So the gatekeeper measures only what this service owns: how many sessions are
alive, and how much room is left.

## Three roles, and who knows what

**Whoever deploys** knows the memory the service was given, because they bought
it. They set the capacity.

**The service** knows how many sessions are live and how deep the queue is. It
decides admission.

**The caller** is one of two things, and neither can be asked anything:

- a person on the WebUI, who waits or gives up
- a program — Claude Code, Cline, a script. It has its own timeout, gives up
  silently, and may retry on its own

Neither is asked about capacity and neither could be told before it calls. So a
refusal has to be legible to both — a sentence for the person, a field for the
program — and final enough to act on. The per-channel formatters in
`srv/lib/throttle-surfacing.ts` exist for exactly that split.

## The problem

Memory is the binding resource, and two things spend it.

**Work in flight.** A pipeline at its peak: the tool corpus, skill injection,
32k-token buffers, accumulated iteration context. We learned this number
painfully — one heavy agent step was killing a gigabyte, which is why the
container is at 2 GB.

**State at rest.** A session holds its history between turns, and keeps holding
it for thirty minutes after the last one (`SESSION_TTL_MS` in
`srv/openai-handler.ts`). Nothing bounds how many sessions exist.

Only the first was ever capped, and only on one channel: `execute_step` holds a
semaphore of two (`EXEC_STEP_MAX_CONCURRENCY`), for exactly this reason, after
exactly this failure. The chat channels cap nothing at all.

So the service can be killed two ways and watches for neither: a burst of
concurrent heavy work, or a slow accumulation of sessions that are individually
harmless.

## The gatekeeper

**One session is one pipeline, and the slot is the session.** Admission is
keyed by the session, not counted anonymously: a request for a session that
already holds a slot waits for *that* slot rather than taking a second one, and
only a session with no slot competes for a free one. Without that key the rule
is a claim and not a mechanism — with two slots free, two concurrent requests
carrying the same session id would both be admitted, both run, and both read
and write the same history.

**The identity the door keys on is the authenticated user with the session.**
The user comes from the token and never from anything the caller writes, so no
caller can pass for another whatever it sends. That is the guarantee, and it is
the one that can be enforced today.

The service also issues the session half rather than reading it from a header:
between a consumer and MCP and ABAP there is no reason for a consumer to name a
chat session, so `resolveSessionId`'s `x-session-id` and `mcp-session-id` stop
being read for **this** purpose.

**But issuing is not the same as proving, and it would be dishonest to claim
otherwise.** `clh_session` is a plain cookie — `HttpOnly; SameSite=Lax`, no
signature, no registry of what was issued (`srv/session-id.ts`) — so a caller
can send any value in it as easily as in a header. Dropping the headers removes
the obvious way to aim at somebody; it does not make the identifier
unforgeable.

What makes that harmless is the other half of the key. With the user taken from
the token, a chosen session id can only collide with its own author's other
requests, which serialises that caller against itself and nobody else. Making
the identifier itself unforgeable would need a signed cookie or a server-side
record of what was issued — real work, with key management or eviction of its
own, and worth doing only if something later depends on the id being
unguessable. Nothing here does.

Our own chat UI is the only client sending that header for chat, and it invents
the value in the browser — `"chat-" + Date.now() + "-" + Math.random()` in
`app/chat/webapp/controller/Chat.controller.js`. It moves to the cookie the
middleware already sets for it. An API client sending its full history never had
a chat session and still does not; each of its requests is admitted on its own.

**The header itself does not disappear, and an earlier draft of this section
wrongly said it could.** `srv/rag-handler.ts` reads the same resolver to scope a
RAG collection to a session, and `rag-handler.test.ts` and
`cross-user-isolation.test.ts` cover it. That use is not an identity claim: a
session-scoped collection already lives inside one user's space
(`srv/collection-ids.ts` keys it by user **and** session for exactly that
reason), so a colliding id there collides only with its own author, and naming
one is how a caller addresses its own namespace. It stays as it is.

The distinction is worth stating once, because the same header is doing two
unrelated jobs: as a **namespace** inside a user's own data it is the caller's
to choose, and as the **key that schedules work** between callers it is ours to
issue.

The slot is keyed on the issued identity, and the store keys on
`${userId}\u0000${sessionId}` as it already does, so the two cannot drift apart.

So live sessions and live pipelines are the same number by construction rather
than by assertion. `execute_step` needs no special case: each of its calls
already mints its own session id, so its parallel steps are parallel sessions,
which is what they have always been.

**One counter, every channel.** `/v1/chat/completions`, `/v1/messages` and
`execute_step` spend the same memory, so they share one count. Two independent
caps on one resource would each be wrong about the other.

**A queue in front, not a refusal at the edge.** A caller arriving when every
slot is taken waits in a bounded FIFO queue rather than being turned away at
once. Most contention is brief, and a caller that waits two seconds got served;
a caller refused at two seconds retries and arrives again.

**One queue, and everyone waiting is in it** — including a caller waiting for a
session that is already working, even when slots are free. Two queues would
leave the second unbounded, and unbounded is what it would be: one session id
repeated is the easiest backlog to build by accident, a browser tab retrying or
a script in a loop, and every waiter is an HTTP request held open. So the length
bounds all waiting, whatever it is waiting for, and the eleventh caller is
refused whether it wants a free slot or a busy session.

**Order is arrival order among those who can be served.** Strict arrival order
with no exception sounds fairer and is worse: with a capacity of two, sessions A
and C running, a second request for A first in the queue and a fresh B behind
it, C finishing frees a slot that A's waiter cannot take — A is still busy — and
that B is forbidden to take, because B arrived later. A slot sits empty while
someone is waiting for it, and if A hangs, B waits for ever.

So the dispatcher takes the **oldest eligible** waiter: one whose session is
free, or which needs no particular session. A waiter blocked on a busy session
is passed over for as long as that session is busy and keeps its place
otherwise, so it is never starved by later arrivals that are also eligible. Two
rules would need a reason; this is one rule — first come, first served, among
those it is possible to serve.

**The queue's depth is the pressure signal.** Not a second configured number:
when the queue passes three quarters of its length the service is running out of
room, and that is the point to notice rather than the moment the last slot
happens to fill. A queue that deep means arrivals are outrunning completions,
and the arithmetic only gets worse from there.

**Strictly first come, first served.** No priorities and no lanes. The session
that has waited longest goes next.

**A waiter that leaves is removed.** The caller's own timeout may fire while it
is queued, and a waiter nobody is behind must not later be handed a slot and
start a pipeline for nobody: that spends the capacity the queue exists to
ration and contradicts the refusal's own promise that nothing was started. So a
queued caller carries its request's abort, and leaving the queue costs nothing —
no slot was taken, no session was created, no teardown is owed. This is the one
place where a disconnect *does* end something, and it can be, precisely because
nothing has begun.

## What the caller sees

Two outcomes and no third.

**Turned away at the door.** Every slot is taken and the queue is full. Nothing
was started, so nothing is half-done.

**Without a time to come back at.** How long a session runs is not something we
measure: a chat turn and a twenty-iteration tool loop differ by orders of
magnitude, and a session may be waiting on ABAP rather than on us. So this
refusal carries no `Retry-After` and no number in its text. Inventing one would
be the guess this document refuses everywhere.

**Let in.** From here the session is carried to the end. It may be slow — its
model calls may be throttled, its ABAP calls may take as long as they take — but
nothing of ours will stop it. If the caller's own timeout fires first, that is
the caller's decision and not our failure.

**The guarantee: an admitted session is never refused by us.** Only a shutdown
ends one. A dependency that disappears still fails the work that needed it, and
that is the work failing rather than a refusal. What the door buys is that
congestion stops being a way to die: a refusal at the door declines a whole
request cleanly instead of killing one halfway with an ADT lock still held.

That guarantee rests on one property of a `429`: **it delays, it does not
interrupt.** A refusal with an interval is a statement about when, not about
whether. So an admitted session waits out exactly what the server named,
however long — `WaitAsTold`, with no ceiling, because the ceiling in
`WaitIfShortEnough` protected a caller's connection from an unpredictable wait
and the door now protects capacity instead. A ceiling behind the door would
only kill work in flight, which is the failure the door exists to prevent.

**And the one case it cannot cover, named rather than glossed.** A `429` that
names no interval leaves nothing to wait out. The old design paced such a call
against its own window; with no window there is no schedule of ours to pace
against, so the call fails and takes its session with it. That is the price of
dropping the rate limit, it is small — the header is documented and its absence
usually means a spend cap, which waiting would not have fixed either — and it
is the only hole in the guarantee.

## Sizing

**The knob is how many sessions may live at once.** Everything else follows: the
queue, the waits, the refusals.

That number is bought. Memory on BTP is a price, and the chain runs money,
memory, live sessions, backlog held, callers turned away. Nothing in the code
fixes any link of it.

Memory buys two different things and only the second is capacity.

**The floor** is what it takes to do the work at all. Ours is 2 GB, found
painfully: below it one heavy step cannot run, and 256 MB is not a smaller
capacity but a different service.

**Above the floor** is how many sessions fit, and that is the `.mtaext` setting,
beside the memory it depends on. 2 GB against 4 GB is the decision that actually
buys capacity.

**The estimate to make, and to re-make.** Peak memory is live sessions times a
pipeline's peak, **plus** retained sessions times their history. Two terms, two
lifetimes, and one bound does not cover both.

The door bounds the first. It does not bound the second, and an earlier draft
of this section claimed it did: a slot is released when the work ends, while
the history stays in `sessionStore` for thirty minutes after the last turn. A
service with four slots can therefore hold four hundred retained sessions, and
that is the accumulation this rewrite was written to stop.

So the second term gets its own bound, and a different kind of one. Capacity is
a **refusal**; retention is an **eviction**. When the store is full the least
recently used idle session is dropped to make room — losing an idle
conversation's history is a cost a caller can recover from by asking again, and
refusing a new caller because someone stopped typing half an hour ago is not.
Nothing is ever evicted while it holds a slot.

### Why the queue's length is derived

The queue absorbs brief contention; it does not store work. Sized to the
capacity — as many waiting sessions as running ones — it holds a burst without
pretending to hold a backlog, and the three-quarters mark arrives early enough
to be worth reporting.

Longer would be worse, not better: a deep queue converts a refusal the caller
could act on into a wait it cannot see the end of, and every waiting caller is
still holding an HTTP request.

## Entrances

A door with one way around it is not a door. Four channels start a pipeline:

| channel | file |
|---|---|
| `/v1/chat/completions` | `srv/openai-handler.ts` |
| `/v1/messages` | `srv/anthropic-handler.ts` |
| `execute_step` | `srv/agent-mcp.ts` |
| `AgentService.Chat` | `srv/agent-service.ts` |

The fourth is easy to miss because it is not an Express route. It calls
`agent.process` straight through, takes no destination and no per-request
credentials, establishes no connection and calls no `safeStop` — the one
entrance with neither a door nor a session lifecycle. It is dead surface, and
the plan removes it rather than gating it.

`AgentService.Health` is **not** an entrance and stays: it probes and returns,
starting no pipeline and opening no session.

**Admission happens after the agent is resolved.** A caller waiting for a
destination to warm, or for the shared tool corpus to build, waits *outside* the
door holding an HTTP request and no session. That wait is already bounded by
`LLM_AGENT_DESTINATION_INIT_WAIT_MS`.

## Cancellation, and who frees the slot

Only shutdown ends an admitted session. Everything here follows from that.

**One controller per admitted session.** The door creates it at admission.
Exactly one thing aborts it: shutdown, aborting every live controller at once.

**Its signal travels as `CallOptions.signal`** — to the provider's transport, to
the throttle waits, to the tool loop's per-iteration check, to the MCP calls,
and to the reviewer and finalizer roles. Since llm-agent 25.0.0 it reaches the
wire rather than merely the waiting around it.

**A client disconnect ends nothing.** The handlers tear the session down on
`res.close` today, and that is the recorded root cause of the orphaned ADT locks
this service has cleaned out of SM12 by hand: a write chain cut between `create`
and `activate` leaves the object inactive and locked by a session nobody will
unlock. Nobody is waiting for the answer; SAP is still waiting for the rest of
the chain. So the listener becomes a note — the caller is gone — and the output
sink is **detached**, not guarded: after it, every chunk and closing envelope is
dropped before the socket, and no write error can be raised into the pipeline.

**The slot is released when the last call this session started has settled**,
not when the caller was answered. An abort answers the caller; an ADT write
underneath keeps running, because an ADT call is asynchronous in substance —
cutting it discards our knowledge of the work rather than the work. So every
dispatched call, model or tool, is registered against the admission handle
before it leaves and deregistered when it settles.

**Teardown order**, and it is this order because `safeStop` closes the ADT
session and then resets the connection:

1. Stop starting new calls.
2. Wait for the register to empty.
3. `safeStop`.
4. Release the slot, last.

Running `safeStop` first would tear the session out from under a live write.
Holding the slot does not help: the slot was never what the write was using.

**Shutdown is the same path, aborted at once**, and the one place this ordering
may be best-effort: it does not wait for the register before the process exits.

## When a dependency is down

The door refuses because we are full. This is the other refusal: we are not
full, we are not able.

**The connector already catches it and writes the verdict down.**
`CloudSdkAbapConnection` puts its failures through `classifyProbe` and appends
`[tunnel_timeout]`, `[dns_or_network]` and the rest to the message. That tag is
the fact; nothing here re-derives it.

Which verdicts close a destination:

| `ProbeStatus` | Outage? |
|---|---|
| `tunnel_timeout`, `no_scc_registration`, `wrong_location_id`, `dns_or_network` | **yes** — nothing reached SAP |
| `backend_auth_failed` | no — the system answered, and said no |
| `backend_reachable_path_error`, `backend_error` | no — SAP ran something |

**Two things are called "the SAP system" and only one is a destination.** The
ABAP system is reached through the connector and closed as a destination. BTP is
the platform underneath — AI Core, XSUAA, the destination service, the
connectivity service — and a failure there belongs to no destination: AI Core
going down affects every one equally and none is at fault. Closing destinations
on a platform failure would mark healthy systems broken and hide one cause
behind many symptoms.

**Scope.** A failure closes a destination, not the service. Without MCP a
destination has no tools and is closed; without RAG it has every tool and
chooses among them worse, which is logged and carried.

**New arrivals are refused; admitted sessions are not killed by us.** One that
actually calls the missing server fails on that call, like any tool failure. The
refusal is a `503` carrying the time remaining until that destination's next
probe — not the probe interval, which says nothing about when we will next look.

**An unanswered write is reported, never repeated.** A write that was sent and
whose answer never came cannot be told from one that applied. Retrying is a
second attempt at the same change; assuming success is worse. It is reported,
with the tool named, and the ADT session released. The record must be opened at
**dispatch** for that to be possible, since a thrown transport error otherwise
leaves no trace that anything was sent.

## The configuration contract

This repository owns the shape; whoever deploys owns the values.

| Variable | Meaning | Absent |
|---|---|---|
| `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` | positive integer: how many sessions may be live at once, across every channel | no door on the chat channels; `execute_step` keeps its existing semaphore of two |
| `LLM_GATEKEEPER_QUEUE_LENGTH` | positive integer: how many callers may wait for a slot | the capacity, which absorbs a burst without storing a backlog |
| `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` | positive integer: how many sessions may hold history. The least recently used **idle** one is evicted to make room; a session holding a slot is never evicted. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`, and may not be smaller than it | unbounded, as today |

**Absent means off, malformed means refuse to start.** An unset variable
disables what it configures and the service behaves exactly as today. A value
that will not parse, or is not a positive integer, fails at startup naming the
variable: somebody intending a limit and not getting one is the failure this
design exists to make visible. The precedent is
`LLM_AGENT_THROTTLE_MAX_WAIT_MS`, which already does this.

**Retention requires a capacity, and may not be smaller than it.** Both are
checked at startup. A retention cap on its own is the same broken arithmetic
seen from the other side: with chat concurrency unbounded, any number of
sessions can be live at once, all of them ineligible for eviction, and the cap
is exceeded by sessions the design forbids touching. So `retained` without
`capacity` is refused, and so is `retained < capacity`. The two numbers bound different resources and are otherwise independent,
but a retention cap below the capacity is a configuration with no correct
behaviour: with five slots and room for two histories, three admitted sessions
would each need a history while none is idle, and the implementation would have
to either exceed the bound it was given or evict a session that is running —
breaking the guarantee to honour a number. Requiring a capacity, and `retained >= capacity`, makes the situation
impossible rather than resolved: every live session has a retention place by
construction, so eviction only ever has idle candidates to choose from. It also
reads as what it is — you cannot retain fewer conversations than you can hold
at once, and you cannot bound retention at all without bounding how many run.

The values in force are logged at startup. A limit only shows itself under load,
and by then nobody remembers what was configured.

## Not in scope

- **Rate limiting.** Deliberately removed; see "What this replaces".
- **Token budgets.** A different limit again, measurable only after a response,
  and not something admission can act on.
- **Sharing state between instances.** `instances: 1` holds.
- **Prioritising one caller over another.**

## Known limits of this design

**The counter is per process.** Today `instances: 1`. A second instance means
two independent doors, each against its own container's memory — which is
consistent, because memory is per container.

**A caller who leaves still costs a slot.** The session runs to the end for an
answer nobody will read. Deliberate: the alternative is paid by a human in
SM12. Capacity is therefore sized for work that is started, not for work anyone
is still waiting on.

**A session that will never finish costs a slot until shutdown.** Nothing below
us can tell a permanent refusal from a busy minute, and neither can we. With
capacity N, N such sessions close the door until a restart. That is the accepted
cost of having no clock over running work, and it is visible: door refusals
rising with a shallow queue is exactly this shape.

**Eviction loses a conversation's history, silently.** A caller whose session
was evicted while they were reading asks their next question without the
context of the previous ones, and nothing tells them so. That is the trade
against refusing a new caller to preserve an idle one's memory, and it is the
right way round — but it is a real cost and it will look like the agent
forgetting.

**The thirty-minute TTL is untouched.** `MAX_RETAINED_SESSIONS` bounds how many
sessions may be held; it does not shorten how long each is held. A deployment
whose memory is spent on idle history can also lower the TTL, which is a
separate knob and a separate decision.

**The session identifier is not unforgeable.** The cookie carrying it is
unsigned and there is no record of what was issued, so a caller can present a
value we never gave it. Harmless as long as the key's other half is the
authenticated user, and it is — but anything built later that treats the
session id as a secret would be building on sand.

**A platform outage looks like many system outages.** When the connectivity
service fails, every on-premise destination closes on its own account. Correct
per destination and useless as a diagnosis; the shared cause is invisible.

**Throttling is now unmanaged by us.** We no longer try to stay inside the
provider's rate, so a busy tenant will produce more `429`s and slower work. That
is the trade this rewrite makes deliberately: slower is survivable and
mis-measuring capacity is not.

## Observability

Four scopes, because they answer different questions and adding them up answers
none.

**The door** — live sessions, capacity, queue depth, the queue's high-water
mark, refusals, and waiters that left before admission. A deep queue with few
refusals means the capacity is nearly right; refusals with a shallow queue mean
arrivals come in bursts the queue cannot absorb; and waiters leaving in numbers
means the queue is longer than callers will tolerate, which is the argument for
shortening it rather than growing it.

**Retention** — sessions held, the cap, and evictions. Separate from the door
because they are separate resources with separate lifetimes: evictions climbing
while the door is quiet means memory is going to state at rest, and no amount
of capacity tuning will address it.

**Per destination** — whether it is closed, and refusals caused by that.
Availability, not capacity. Mixing it into the door's numbers would make an
unreachable SAP system look like a full container.

**Throttling** — the observer llm-agent already provides
(`setThrottleObserver`): how often the provider refused us, and for how long.
Since we no longer try to prevent it, watching it is how anyone would know the
tenant's limit has become the binding constraint.

## Testing

These properties, because they are what this shape gets wrong.

- **No lost wake-up.** The state "waiters present, no dispatch scheduled" must
  never exist.
- **Order.** First in, first out, under contention.
- **The limit holds under pressure.** Twenty simultaneous callers against a
  capacity of five produce exactly five live sessions.
- **A capacity of one admits one.** The degenerate setting is a setting.
- **The queue absorbs and then refuses.** With capacity five and a queue of
  five, callers six to ten wait and the eleventh is refused.
- **A repeated session id cannot build a backlog.** With capacity to spare, ten
  requests carrying one busy session's identity fill the same queue and the
  eleventh is refused — not held in a second, unbounded line.
- **A blocked waiter does not hold the queue.** Capacity two, sessions A and C
  running, a second request for A queued first and a fresh B second: when C
  ends, B is admitted rather than the slot sitting empty behind A. And with A
  never finishing, B is still served — the case that turns strict arrival order
  into a deadlock with capacity to spare.
- **And it is not starved either.** Once A finishes, its waiter goes before
  anyone who arrived after it.
- **Three quarters is reported before anyone is refused.** The high-water mark
  crosses first.
- **A full door refuses without a number.** No `Retry-After`, no seconds in the
  text.
- **An admitted session is never refused.** Fill the capacity, then drive every
  admitted session through a long tool loop: all complete.
- **And no `429` with an interval ends one.** A session meeting a throttled
  model call waits out exactly what the server named, past twenty seconds,
  which is where the old ceiling would have cut it — and finishes.
- **A `429` naming nothing fails the session.** Asserted so the one hole in the
  guarantee stays a decision rather than becoming a surprise.
- **One session, one pipeline, with slots to spare.** Two concurrent requests
  carrying the same session id **and the same user** against a capacity of
  five: the second waits for the first rather than taking a second slot.
  Written with capacity free, because a test that fills the door first would
  pass on the global queue alone and prove nothing about the key.
- **A chat request cannot name its session through a header.** One carrying
  `x-session-id` is admitted as a fresh session.
- **Two users cannot collide, whatever they send.** The same session id from
  two authenticated users — in headers, in cookies, anywhere — gives two
  independent sessions and neither waits for the other. This is the guarantee
  that is enforced; the issued identifier is convenience on top of it.
- **A caller colliding with itself is serialised, not broken.** The same id
  twice from one user runs one after the other and both complete.
- **The RAG API still takes one.** A session-scoped collection addressed by
  `x-session-id` resolves exactly as it does today, and two users sending the
  same value still reach different collections. Asserted alongside the above,
  because the two live one line apart and the obvious tidy-up breaks the second.
- **The browser's chat session survives without the header.** The chat UI,
  sending only the cookie, keeps its history across turns exactly as before.
- **A waiter that leaves takes no slot.** Queue a caller, abort it, then free a
  slot: it is gone from the queue and no pipeline starts for it.
- **Retention is bounded and eviction prefers the idle.** With the cap reached,
  a new session evicts the least recently used idle one, and never one holding
  a slot.
- **Retention below capacity, or without one, is refused at startup.** Naming
  both variables, because the alternative is a running service that must break
  one of them.
- **A cap filled entirely by live sessions evicts nothing.** With retention
  equal to capacity and every slot taken, no eviction happens and no admitted
  session loses its history — the case that has no correct answer if the two
  numbers are allowed to disagree.
- **Every entrance is counted.** Drive each channel to capacity in turn.
- **Absent means today.** With no capacity configured, `execute_step` still caps
  at two and the chat channels are unchanged.
- **Shutdown cancels admitted work** rather than waiting for it, and nothing
  else of ours ends an admitted session.
- **The slot outlives an aborted tool call.** Abort mid-write: the caller is
  answered and the door still refuses an arrival until the embedded promise
  settles.
- **The session outlives it too, and a disconnect ends nothing.** `closeSession`
  is not called until the registered promise has settled, and a client that
  disconnects mid-write leaves the pipeline running to its end.
- **A dead socket cannot fail the run.** Disconnect mid-stream, then let the
  pipeline emit more chunks and its closing envelope: all dropped, none throws.
- **A closed destination refuses arrivals and spares the admitted**, with a
  `503` carrying the time until that destination's next probe.
- **An unanswered write is reported, never repeated.** One notice naming the
  write, one call at the transport, the session released.
- **A shared corpus build holds no caller's slot.** A request arriving mid-build
  waits before admission.

## Relationship to what already exists

`execute_step`'s semaphore is the ancestor of this design and stays as the
fallback: with no capacity configured it is what "absent means off" means on
that channel. Configuring the door turns it off for that route, because two caps
on one resource would each be wrong about the other.

`WaitIfShortEnough` (`srv/lib/throttle-strategy.ts`) is **replaced for admitted
work** by `WaitAsTold`. Its twenty-second ceiling protected a caller's
connection from a wait we could not predict; with a door in front, a request is
either declined before it starts or carried to the end, and a ceiling behind
the door would only kill work in flight. Keeping it would have made the
guarantee false for any interval over twenty seconds, which is most of the ones
SAP AI Core actually names.

Whether it survives outside an admitted session depends on whether anything
calls a model there. Startup corpus vectorization is the candidate: it embeds
before any request exists, so there is no door in front of it and no caller to
protect. That is the implementation plan's decision, not this document's.

The blind reconnect-and-retry in `MCPClientWrapper` is not on our path — this
service uses the embedded transport, whose branch neither reconnects nor
retries. Removing it upstream is worth doing for other consumers and is not a
prerequisite here.

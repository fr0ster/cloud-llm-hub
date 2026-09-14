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

**One session is one pipeline.** A session does not run two pipelines at once; a
second request on a session that is already working waits for the first. That is
not a restriction invented here — each `execute_step` call already mints its own
session — and naming it makes the counter unambiguous: live sessions and live
pipelines are the same number.

**One counter, every channel.** `/v1/chat/completions`, `/v1/messages` and
`execute_step` spend the same memory, so they share one count. Two independent
caps on one resource would each be wrong about the other.

**A queue in front, not a refusal at the edge.** A caller arriving when every
slot is taken waits in a bounded FIFO queue rather than being turned away at
once. Most contention is brief, and a caller that waits two seconds got served;
a caller refused at two seconds retries and arrives again.

**The queue's depth is the pressure signal.** Not a second configured number:
when the queue passes three quarters of its length the service is running out of
room, and that is the point to notice rather than the moment the last slot
happens to fill. A queue that deep means arrivals are outrunning completions,
and the arithmetic only gets worse from there.

**Strictly first come, first served.** No priorities and no lanes. The session
that has waited longest goes next.

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

That guarantee is also why throttling is not our business. A `429` delays, it
does not interrupt: the provider reports the interval, the strategy waits it
out, the pipeline finishes late. Nothing in the gatekeeper needs to know a rate
for that to be true.

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
pipeline's peak, plus retained sessions times their history. The second term is
what surprised us into writing this, and the door bounds it for the first time:
a session that cannot be created cannot accumulate.

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

**Absent means off, malformed means refuse to start.** An unset variable
disables what it configures and the service behaves exactly as today. A value
that will not parse, or is not a positive integer, fails at startup naming the
variable: somebody intending a limit and not getting one is the failure this
design exists to make visible. The precedent is
`LLM_AGENT_THROTTLE_MAX_WAIT_MS`, which already does this.

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

**Retained sessions are bounded, not freed.** The door stops new sessions from
being created; it does not shorten the thirty-minute TTL of the ones that exist.
A deployment whose memory is spent on idle history should lower that TTL, which
is a separate knob and a separate decision.

**A platform outage looks like many system outages.** When the connectivity
service fails, every on-premise destination closes on its own account. Correct
per destination and useless as a diagnosis; the shared cause is invisible.

**Throttling is now unmanaged by us.** We no longer try to stay inside the
provider's rate, so a busy tenant will produce more `429`s and slower work. That
is the trade this rewrite makes deliberately: slower is survivable and
mis-measuring capacity is not.

## Observability

Three scopes, because they answer different questions and adding them up answers
none.

**The door** — live sessions, capacity, queue depth, the queue's high-water
mark, and refusals. A deep queue with few refusals means the capacity is nearly
right; refusals with a shallow queue mean arrivals come in bursts the queue
cannot absorb.

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
- **Three quarters is reported before anyone is refused.** The high-water mark
  crosses first.
- **A full door refuses without a number.** No `Retry-After`, no seconds in the
  text.
- **An admitted session is never refused.** Fill the capacity, then drive every
  admitted session through a long tool loop: all complete.
- **And no `429` ends one.** A session meeting a throttled model call waits it
  out and finishes.
- **One session, one pipeline.** A second request on a working session queues
  behind the first rather than running beside it.
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

`WaitIfShortEnough` (`srv/lib/throttle-strategy.ts`) survives, unchanged. Its
ceiling protects a caller's connection from a wait we cannot predict, and with
no rate window of our own it is the only such protection there is. Throttling
stays exactly where it was: at the provider, governed by the strategy this
service already configures.

The blind reconnect-and-retry in `MCPClientWrapper` is not on our path — this
service uses the embedded transport, whose branch neither reconnects nor
retries. Removing it upstream is worth doing for other consumers and is not a
prerequisite here.

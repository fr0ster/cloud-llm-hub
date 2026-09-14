# Gatekeeper: admission control for the LLM quota

**Status:** design approved, not implemented
**Date:** 2026-09-13

## TL;DR

One object per quota holds a FIFO queue and a sliding window of request starts.
Every model we call goes through it. If the window has room, the call goes. If
not, it waits its turn, for as long as that takes. A caller is turned away only
at the door, before any work starts, and that refusal carries no number,
because how long the pipelines ahead of it will run is not something we
measure. Once admitted, no rate limit ends the request; only a shutdown
does.

## Three roles, and who knows what

BTP separates these, and the design depends on the separation. Each knows
something the others do not, and each is powerless over what the others hold.

**Whoever writes the service** — this repository, Apache 2.0. Owns the
mechanism and the shape of the configuration. Knows nothing about any tenant's
quota and must not encode a guess about one.

**Whoever deploys it** — the subaccount holding the AI Core (or other) service
instance: ACME, acme, each their own. Owns the numbers. Is the only party who
knows what limits were ordered, whether resource groups have their own, and what
else in that subaccount spends the same minute. Values live in their `.mtaext`,
never here.

**Whoever calls it** — and this one has two shapes:

- a person in the WebUI, watching for an answer and able to read a sentence
- a program: Claude Code, Cline, a script. It has its own timeout, gives up
  silently, and may retry on its own

Neither is asked about quotas, waits or capacity, and neither can be: the person
has no idea, and the program has no way to be told before it calls. This is why
the caller never configures anything here, and why a refusal has to be legible
to both — a sentence for the person and, **whenever we honestly have one**, a
number in a field or header for the
program. The per-channel formatters in `srv/lib/throttle-surfacing.ts` exist for
exactly that split.

The qualifier is load-bearing. A throttled call carries the interval the server
named, so that refusal has a number. A full door does not: how long the
pipelines ahead will run is not something we measure, and inventing a figure
for the header would be the guess this document refuses everywhere else. The
rule is that we never withhold a number we have, not that we manufacture one
we lack.

## The problem

Many users share one LLM quota. We learn about the limit only by being refused,
which is always too late: the refusal is itself a spent request, and under load
every caller discovers the same closed limit separately.

Today the only defence is downstream. `@mcp-abap-adt/llm-agent` answers a `429`
inside the provider: it reads `Retry-After`, records that the quota is shut so
no other call spends a request discovering it, and hands the failure up. That is
**throttling** — reacting to a server that has already said no.

What is missing is the **limit**: knowing the budget and not exceeding it. The
library cannot hold that — not because it cannot see concurrent callers, since
its gate is shared across every provider instance in the process, but because
nobody tells it the budget. It learns the limit only by being refused, which is
learning after the fact and one spent request at a time.

## Where this belongs, and why

Two resources, opposite shapes.

| | ABAP | LLM provider |
|---|---|---|
| Unit | one user, stateful | shared, stateless |
| Constraint | concurrency — heavy parallel work exhausts memory and the backend | rate — requests per minute against one quota |
| Instrument | semaphore, already in place (`execute_step`, 2 permits) | a rate budget, which does not exist yet |

A semaphore bounds how many run at once; a quota bounds how many start per
minute. Two requests in a row break no semaphore and easily break a rate limit.
Twenty parallel long steps break no rate limit and kill ABAP. Using one
instrument for the other is wrong in both directions.

Neither layer below sees enough. The connector sees one user's session. The
provider sees one call. Only this service sees both "this user's step" and "our
share of the shared minute", so admission control lives here and nowhere else.

## The gatekeeper

**One object per quota.** What counts as a quota is configuration, not
inference: the deployment that ordered the limits says what they cover. A call
maps to a key by a rule the configuration supplies; with nothing configured the
key is the model name, which is how every provider we know of meters. Nothing in
this code names a provider, a model dimension or a resource group.

This is the opposite of how llm-agent keys its own pause, which infers a quota
from whatever it can observe including the resource group — an inference it has
no way to make, and which SAP's default contradicts, since resource groups share
the tenant limit unless separately configured. That gate stays a local safety
net; this is the record of what the limit actually is.

**It counts starts, not concurrency.** A rate measures how many requests begin
per window. A permit is taken on entry and expires by ageing out of the window,
never by the call ending — duration is not its business. This is why it is not
a semaphore.

There is one exception, and it is not a release: a call that never reached the
wire gives its permit back, because it was never a start (see "A refusal that
never reached the wire"). That is a correction of the record, not a return of
capacity, and it has to be cheap. So a permit is not a bare timestamp in a
deque: it is a node the holder keeps a reference to, and giving it back marks
that node dead in place — `O(1)`, no search. Dead nodes are skipped when the
window is trimmed from the head, and the count of live starts is maintained as
they are marked rather than recomputed. The dispatcher reads that count, so a
permit given back opens room for the next waiter immediately and correctly,
while the window's own ordering by timestamp is never disturbed.

**Sliding window.** A permit is free when fewer than `limit` starts fall inside
the last `window`. The oldest start leaves the window and a place opens.

**Strictly first come, first served.** No priorities, no lanes, no preference
for work already in flight. A pipeline that has made eight calls queues behind a
newcomer for its ninth. This was chosen deliberately: the cost is that long work
gets longer under load, and the effect is on resources, not correctness.

**Waiters decide nothing.** They join the tail and sleep. One dispatcher per
quota holds a single timer set to the moment the next place opens. On waking it
counts the free places, takes exactly that many from the head, and resolves
them. So the limit cannot be exceeded under contention, and twenty parked
callers never wake together to race.

**A place can also open early, and the timer will not know.** Giving a permit
back frees room now, not at the expiry the timer was set for, so `giveBack`
must run the dispatcher — the same one, immediately, rescheduling its timer
from the window as it stands afterwards. Without that a waiter sleeps until an
expiry that has nothing to do with the room it could already have had. It is
the lost-wake-up defect in a second costume, and it is tested as its own case
rather than left to the general one.

This is the defect that rules out `TokenBucketRateLimiter` from llm-agent, which
otherwise fits the seam: each waiter computes its own delay and, on waking,
records a start **without re-checking**, so N parked callers record N starts past
the limit. It is also not FIFO, and it re-filters the whole timestamp array on
every acquire.

### Cost on the hot path

The queue is a serialisation point, so everything on it is constant-time.

- Enqueue is a push to the tail. No ordering, no scan. (The dropped priorities
  would have made this logarithmic.)
- Window bookkeeping drops expired starts from the head and appends new ones.
  Timestamps are already sorted; nothing is re-scanned.
- One timer per quota, set to a known moment, re-armed after each dispatch. No
  polling.
- The dispatcher resolves promises and returns. It never awaits anything but its
  own timer. One `await` on someone else's promise inside it stalls the quota.

The gatekeeper is a bottleneck by construction, because the quota is one shared
resource and any correct admission control against it serialises. It is not a
throughput bottleneck: it admits on the order of one request per second and
spends microseconds doing it. Widening the neck is an administrative act — buy
more quota, or split it into separately limited groups — not a code change.

## What the caller sees

Two outcomes at the door, and one guarantee behind it. We cut none of them.

**Turned away at the door.** Too many pipelines are already live for the memory
this deployment bought. Nothing was started, so nothing is left half-done.

**Without a time to come back at.** The door is full because pipelines are
running, and how long a pipeline runs is not something we know: a chat turn and
a twenty-iteration tool loop differ by orders of magnitude, and a pipeline may
be waiting on ABAP or streaming its answer rather than on any quota. The queue
depth divided by the rate describes a different resource entirely and can be
zero while the door is shut. So this refusal carries no `Retry-After` and no
number in its text. Inventing one would be exactly the guess this design refuses
elsewhere.

**Let in.** From here no rate limit will turn the pipeline away. It may be
slow: its calls queue behind everyone else's, in order of arrival, with no
ceiling on the wait and none promised. Throttling costs speed, never the
request. A caller stays for as long as it stays, and if its own timeout fires
first that is its decision, not our failure.

**The guarantee: no `429` ends an admitted pipeline.** Not a promise that every
admitted pipeline finishes — a dependency that disappears still fails the work
that needs it, and a shutdown still stops everything. What the door buys is
that congestion stops being a way to die: a refusal at the door declines a
whole request cleanly, instead of killing one halfway with an ADT lock still
held.

The guarantee rests on one property of a `429`: **it delays, it does not
interrupt.** A refusal with an interval is a statement about when, not about
whether. So behind the door a `429` is never a reason to stop, and an admitted
pipeline finishes or fails for some other reason entirely.

That has to be built, not assumed. Two cases, and neither ends the pipeline:

**The server named an interval.** Wait it out, however long, and try again. No
attempt cap. This is `WaitAsTold`, not `WaitIfShortEnough`: the ceiling in the
latter protected a caller's connection from a wait we could not predict, the
door protects capacity now, and a ceiling behind the door would only kill work
in flight — the failure this section exists to prevent.

**The server named nothing.** We may not invent an interval; that rule holds
here as everywhere. But we do not have to, because we have a schedule of our
own: the call goes back to the tail of our own queue and is tried again when our
rate next allows. That is not a guess about their server, it is our own pacing,
and it turns an unanswerable question into an ordinary wait.

**One bound, and it is not a clock over the work.** An earlier draft put a
configured lifetime over each admitted pipeline and failed it when the time was
up. That is a timeout on work in progress, which is the instrument this whole
design refuses everywhere else: it fires *instead* of the decision being made
below it, and here the decision is a strategy waiting out an interval a server
named. A pipeline slowed by throttling is working, not stuck, and cutting it
mid-chain leaves an ABAP object created-but-inactive and locked by a session
nobody will unlock. So there is no lifetime cap.

**Shutdown cancels**, and it is the only thing of ours that ends admitted work.
Stopping cancels rather than waiting: the alternative is a restage that never
completes because something is retrying into a wall. Cancellation is a
mechanism, not a wish — see Cancellation below.

**And no clock is needed over a session either, because none is ever idle.**
Every channel that reaches SAP already ties the ADT session to one request.
`execute_step` closes it in the same `finally` that releases the slot, and
before releasing it (`srv/agent-mcp.ts`): request, work, teardown, slot. The
two chat channels establish a connection per request and call `safeStop` on
every exit path (`srv/openai-handler.ts`, `srv/anthropic-handler.ts`). One of
those paths changes under this design: today a genuine early client disconnect
runs `safeStop` at once, and it will instead only note that the caller is gone
— disconnect, finish the work, empty the register, `safeStop`, free the slot.
See Cancellation for why.

An idle bound was considered and dropped. It would be a clock over a *silent*
session rather than over running work, which is a different and defensible
instrument — but it has no user here. `execute_step` is how a subagent
connects, and a subagent's request is the whole unit: there is no gap between
steps for a session to sit through, so nothing would ever be idle for it to
collect. A session kept across steps would also carry a lock across them, which
is the failure this service already learned to avoid. One per request, and no
setting.

So the guarantee reads exactly as it did above: **no `429` ends an admitted
pipeline.** Only shutdown does, and a call to a dependency that is gone fails
on its own account. There are two outcomes at the door and no third one of
ours: turned away, or let in and carried.

The refusal travels the path already built for throttling
(`srv/lib/throttle-surfacing.ts`): the message as content on
`/v1/chat/completions`, an `overloaded_error` envelope with `529` on
`/v1/messages`, the step's error text for `execute_step`.

It differs from a throttle refusal in one way: there is no number. The
formatters already handle that — a throttled error whose server named no
interval produces "try again shortly" and omits the header — so the door's
refusal reuses that branch rather than needing a new one. What is needed is that
the formatters accept our own refusal as a source, not only the library's
marker.

The refusal says nothing about the caller. It is not "you sent too much"; it is
"we have no room". The knob is therefore how many pipelines may live at once —
see Sizing.

## Sizing

**The knob is how many pipelines may live at once.** Everything else follows
from it: the queue, the waits, the refusals.

That number is bought. Memory on BTP is a price, and the chain runs money,
memory, live pipelines, backlog held, callers turned away. Nothing in the code
fixes any link of it.

Memory buys two different things, and only the second is capacity.

**The floor** is what it takes to do the work at all. We found ours painfully:
the container was raised to 2 GB because one heavy agent step — the 258-tool
corpus, skill injection, 32k-token buffers, accumulated iteration context — was
killing a gigabyte. Below the floor the service does not run. 256 MB is not a
smaller capacity; it is a different service, one that cannot hold a single heavy
step.

**Above the floor** is how many live pipelines fit, and that is the setting
whoever deploys puts in their `.mtaext`, beside the memory it depends on. 2 GB
against 4 GB is the decision that actually buys capacity.

### Why the queue needs no size of its own

A pipeline's calls on one quota are bounded, so the queue's capacity is derived
rather than configured. With `P` live pipelines:

| quota | outstanding calls per pipeline | queue capacity |
|---|---|---|
| main model | 1 — the tool loop awaits each call before the next | `P` |
| embedding model | the parallel RAG fan-out, since `tool-select` and `skill-select` issue their queries through `Promise.all` | `P × fan-out` |

Sized that way the queue can never be full for a pipeline that was let in, which
is what turns the guarantee into arithmetic rather than hope. The reserve is not
a separate mechanism; it is the absence of a second limit.

The fan-out must be measured, not assumed to be one. If a future handler issues
LLM calls in parallel the same way RAG queries are issued, the capacity for that
quota changes with it, and the derivation is the thing to revisit.

### What the waiting looks like

The wait **inside** is worth knowing even though it is not promised, and it is
worth computing rather than estimating. A sliding window releases a permit when
a particular start ages out of it, so the caller at position *k* waits until the
*k*-th oldest start leaves — a time the window already knows exactly, because it
is holding that timestamp. The gate can therefore answer "how long" precisely,
and should, since that is the number worth logging.

Queue length divided by rate is the same answer **only when arrivals are
spread evenly**, and they are not: a burst that spends the whole window in two
seconds leaves everyone behind it waiting out the rest of the minute, not the
fraction the division suggests. At 78 requests per minute a queue of 39 is
about 30 seconds of wait if the traffic was smooth and close to 60 if it
arrived in a clump. Sizing should assume the clump.

If the wait is longer than callers tolerate, whoever deploys needs more quota,
not fewer pipelines — fewer pipelines converts waiting into refusals at the
same load.

This number describes the quota queue and says nothing about the door. A
pipeline slot frees when a pipeline finishes, which depends on work we do not
measure.

A capacity of one is a valid setting, not a misconfiguration: one pipeline at a
time, everyone else turned away at the door. It must behave, because it is the
honest choice for a small deployment that would rather answer quickly than
queue.

## The door

Admission is a separate act from queueing, and it happens once per request that
starts a pipeline.

Half of it already exists. `execute_step` holds a semaphore of two
(`EXEC_STEP_MAX_CONCURRENCY`), so that channel already caps live pipelines and
already parks the excess. Its reason was memory, and it is the same reason.

The chat channels have no door at all. `/v1/chat/completions` and `/v1/messages`
start a pipeline per request with nothing counting them. That is where the work
is: one counter of live pipelines, shared across every channel, with the
existing semaphore folded into it rather than left beside it. Two independent
caps on the same resource would each be wrong about the other.

**And there is a fourth channel, which is easy to miss because it is not an
Express route.** The CAP service exposes `AgentService.Chat` at `/agent`
(`srv/agent-service.cds`, `srv/agent-service.ts`), and its handler calls
`agent.process(message)` straight through. It starts a pipeline exactly like
the others and would be counted by none of them. Listing entrances by the
routes one remembers is how a door gets bypassed, so it is named here: either
it goes through admission with the rest, or it is deleted from the public API.
Deciding which belongs to the plan, and the evidence points one way. It takes
no destination and no per-request credentials, so it cannot reach a SAP system
the way the other three can. It also establishes no request connection and
calls no `safeStop`, while every other channel does — so it is the one entrance
with neither a door nor a session lifecycle. An endpoint that no path in this
design fits is more likely dead surface than a gap in the design.

A pipeline is counted as live from the moment it is admitted until it finishes
or fails. It is not released while it waits on a quota — waiting is exactly when
it still holds its context.

## Entrances

Every model we call goes through the gatekeeper. There are more of them than the
obvious one:

| caller | built where |
|---|---|
| main LLM, tool loop | `makeLlm` in `agent-manager` |
| step reviewer | `criticLlm`, ours |
| helper — query translation, intent enrichment | two sites, ours |
| classifier | `sharedClassifierLlm` |
| embedder | every RAG query |

`SmartAgentBuilder.withRateLimiter()` wraps **only the main LLM**. Relying on it
alone would gate roughly half our traffic while the documentation claimed
otherwise.

So the wrapping happens at our construction sites, and is made unavoidable
rather than remembered: one function returns an LLM and is the only caller of
`makeLlm`; one wrapper returns an embedder and the raw one never leaves the
module that built it. A sixth construction site cannot quietly bypass the
gatekeeper, because creating one means deliberately going around the single
door.

### One acquire per HTTP attempt

This is the invariant, and it rules out the obvious wiring.

`RateLimiterLlm` calls `acquire()` **once** and then hands off to the chain:

```ts
async chat(...) {
  await this.limiter.acquire();
  return this.inner.chat(...);   // retries happen in here, unaccounted
}
```

Its own header says the opposite — "rate limiter sits outermost so that retry
attempts also respect the limit" — and that is not what the code does. Every
retry inside `RetryLlm`, and every attempt of the provider's own
`runWithThrottleRetry` loop, is a request the window never saw. Under exactly
the conditions the gatekeeper exists for, the accounting would be quietly wrong.

So the retrying moves **above** the accounting. Ours is the outermost wrapper
*we* construct, and it takes the permit closest to the wire:

```
RetryLlm (the builder's, above us — see below)
  GatedLlm (ours)
    loop:
      await gatekeeper.acquire(quota)   ← every attempt, not every call
      result = await inner.chat(...)
      if throttled: wait as told, or re-queue when nothing was told; continue
      otherwise: return
```

The rule that follows, and that the plan must enforce, is about the span
between the permit and the wire: **nothing between the permit and the
transport may retry.** The provider's strategy is therefore
`ReportThrottling`, which surfaces the refusal instead of absorbing it. A retry
taken inside one gated call is a request we do not count.

#### `RetryLlm` stays, and stays above us

It is worth being exact about this, because the rule above reads at first like
"delete the retry decorator", and deleting it would be a regression that has
nothing to do with rate limits.

`RetryLlm` does not only retry `429`. The builder composes it by default with
`retryOn: [429, 500, 502, 503]`, so it is also what carries us over a
provider's transient gateway failure. Dropping it would turn a single `502`
into a failed pipeline.

Its `maxAttempts: 3` counts **retries, not attempts**: the loop starts at zero,
calls, and gives up once the counter reaches the maximum, which is the first
call plus three more. Four requests, therefore four permits — worth stating,
because a limit sized against the wrong number of them is off by a third.

It does not have to be dropped, because of where the builder puts it: it wraps
whatever main LLM is handed in, which is our gated wrapper. Every attempt it
makes therefore **re-enters** the gate and takes its own permit, and the
invariant holds without us reimplementing transport-failure retry. What must
not exist is a retry *inside* one gated call, which is the provider's own loop
and nothing else.

Two consequences the plan must respect:

- **Our own refusals must not look retryable.** A refusal from the door, or a
  destination we have closed, is our decision and not a server's; it carries no
  throttling marker and no retryable status, or `RetryLlm` would try three more
  times something we had already declined.
- **The other construction sites have no retry today.** The builder wraps only
  the main LLM, so the reviewer, helpers, classifier and embedder call their
  providers bare. Gating them removes nothing. Whether they deserve transport
  retry is a real question and a separate one; this design does not answer it.

On the embedder side the same shape, minus the seam: an `IEmbedder` wrapper with
the same loop. Both call the same gatekeeper.

The `ILlmRateLimiter` seam is then not what we use. It admits one call and
cannot see the attempts inside it, which is the whole problem.

### A refusal that never reached the wire returns its permit

The invariant has a second half, and it is the one easy to write down and then
break. A permit stands for a request the server was actually asked for. Below
us sits the library's own quota gate, and it can refuse **before** the
transport:

```ts
const shut = gate.remaining();
if (shut > 0) { /* strategy says no -> throw; fn() is never called */ }
```

With `ReportThrottling` under us that branch always throws, because that
strategy never waits. So a pipeline whose sibling met a `429` a moment ago is
turned back by a gate in our own process, having sent nothing. A permit taken
before that call would record a start that never happened, and a herd arriving
at a shut gate would spend the window's whole budget on requests nobody made —
the accounting wrong in the safe direction, but wrong, and wrong exactly under
the load this design exists for.

So the permit is returned when nothing was sent, and the refusal is told apart
from a real one by the count the library already keeps: the `attempts` field on
a throttled error is the number of transport attempts behind it, and a gate
refusal carries zero. Under our wiring the value is only ever 0 or 1, because
`ReportThrottling` makes at most one transport call per invocation.

```
loop:
  permit = await gatekeeper.acquire(quota)
  try { result = await inner.chat(...) }
  catch (e) if throttled(e):
     if e.attempts === 0: permit.giveBack()   ← nothing left the process
     wait as told, or re-queue when nothing was told; continue
```

We do not switch the library's gate off, and could not do so honestly: it is
keyed on something it infers, which is not ours to reach into. Nor would we want
to — it is the one thing that stops us spending a request on a quota a sibling
call has just been told is closed. What it must not do is take that refusal out
of our window.

## Cancellation

Shutdown is the one ending we own, so how it ends a pipeline has to be written
down. Otherwise "the pipeline stops" means a `Promise.race` that resolves
early: the caller is told, the slot is freed, and the work goes on underneath
with its ADT session still open. The memory bound the door was bought for would
be gone, and nothing would look wrong.

**One controller per admitted pipeline.** The door creates it at admission, and
it is part of what admission hands back. Exactly one thing aborts it: shutdown,
aborting every live controller at once. No timer holds it, and no other code
aborts it.

**Its signal travels as `CallOptions.signal`**, which is the path the library
already has. Along it the signal reaches:

- the throttle waits in llm-agent, where `waitUntilOpen(signal)` and the
  backoff sleeps take it and throw on abort
- the tool loop, which checks it at the top of every iteration
- the stepper's MCP calls, which take it as an argument
- the reviewer, finalizer and evaluator roles, which receive it in their
  diagnostic-only subset of the options

Two of our own waits must take it too, and they are where a deadline is most
likely to land: the wait in the gatekeeper's queue, and the wait-as-told
between attempts. A pipeline parked behind a quota is a pipeline doing nothing
but holding a slot.

**What it does not do is tear out a call in flight.** An ADT request already on
the wire runs to its answer; the tool loop's check is at an iteration boundary.
So cancellation means *no further work starts*, and the honest phrasing of the
cap is that it bounds when unwinding begins, not when it ends.

### The slot waits for the transport, not for the report

As of llm-agent 25.0.0 the signal does reach the wire. `makeLlm` returns
`LlmAdapter(LlmProviderBridge(provider))` on every branch, and that adapter
used to build the inner call's options from four fields with `signal` not among
them — it raced the promise instead, so an abort answered the caller while the
HTTP request ran on with nobody holding it. The same defect sat on
`McpClientAdapter`, and there it also missed the embedded transport, which is
the one this service uses. Both now pass the signal down, and the SAP AI Core
provider's own sixty- and hundred-and-twenty-second socket timeouts are gone
with it, since the caller's deadline had arrived to replace them.

That shortens the tail. It does not change the rule, and the rule is the part
this design depends on.

**The door's correctness cannot rest on how well anything below it cancels.**
A request already on the wire may still be running when we report — that is
how the ADT calls behave regardless of any fix, and an ADT call is
asynchronous in substance: the answer coming back does not mean the action
completed, and the call being cut does not mean it stopped. SAP goes on
creating the object and holding the enqueue. Cancellation there discards our
knowledge of the work, not the work. So the slot has to wait for the work to
settle in either case, and making that wait conditional on a library version
would leave the memory bound true of some deployments only.

**And what the door needs is not cancellation anyway.** It protects a count of
live pipelines against memory, so it needs to know a slot is free before
selling it again. An abandoned request is not an abandoned pipeline: a socket
and a response buffer, no ADT lock, no session, no retry, and its permit spent
before it left. That is a cost, not a leak — and a cost we can account for
without anyone's cooperation, because **we are the ones who started it.**

So the rule is accounting rather than cancellation: **the slot is released when
the last outstanding call this pipeline started has settled**, not when the
pipeline reported.

An earlier draft put that bookkeeping in the gated LLM wrapper, and that was
too narrow by exactly the calls that matter most. The wrapper sees model calls;
it never sees a tool call. Those go through `McpClientAdapter`, which races the
caller's signal around `client.callTool` — so on abort the pipeline is answered
while the embedded promise underneath keeps running an ADT write, and the
`finally` would run `safeStop` and free the slot on top of it. That is the
double-booking this section exists to rule out, arriving through the one path
the rule did not cover.

The register therefore belongs to the **admission handle**, not to any one
wrapper. Everything a pipeline starts is registered against it before the call
leaves and deregistered when it settles, whichever kind of call it is; the slot
is freed by the same `finally` only after that register is empty. One place,
because two would disagree.

Two consequences for the plan. The embedded handler must take the
`AbortSignal` the library now hands it — `callToolHandler` currently accepts
`(name, args)` and drops the third argument (`srv/agent-manager.ts`), so an
abort reaches the wrapper and stops there. And a tool call must be registered
at dispatch, which is the same moment the recording has to open for the
unverified-write case: one hook, two readers.

What 25.0.0 buys is how long that wait lasts. With the signal delivered, an
aborted LLM request ends rather than running to the provider's own answer, so
the tail on a model call is now short instead of bounded by a socket timeout —
and on the direct Anthropic, OpenAI and DeepSeek providers, which never set one,
not bounded at all. On the ABAP side nothing changes: the call finishes when it
finishes.

**Teardown order, and who frees the slot.** An earlier draft had safe-stop
first, and that is the wrong end. `safeStop` calls `closeSession` and then
`reset` (`srv/lib/request-connection.ts`), so running it while a registered
write is still on that connection tears the session out from under the call —
which is how an object ends up created-but-inactive with a lock nobody holds.
Holding the slot does not help: the slot was never what the write was using.

The order on an abort is therefore:

1. **Stop admitting new calls** on this pipeline. The signal fires; the tool
   loop starts nothing further.
2. **Wait for the register to empty** — every call already dispatched, model or
   tool, settles on its own.
3. **Then `safeStop`**, with nothing left using the connection.
4. **Then release the slot**, last, by the same `finally`.

**And a client disconnect ends nothing.** This needs saying plainly, because
the obvious move is wrong. `res.on('close')` today calls `safeStop` directly
(`srv/openai-handler.ts`, `srv/anthropic-handler.ts`), walking straight past
any register — the guard on `!res.writableEnded` narrows *when* it fires, not
*what* it cuts. The tempting fix is to make it fire the abort instead. It must
not.

A disconnected caller is not a reason to stop: the work is already inside SAP's
hands, and cutting a write chain between `create` and `activate` leaves the
object inactive and locked by a session nobody will unlock. That is not a
hypothetical — it is the recorded root cause of the orphaned locks this service
has already had to clean out of SM12 by hand, and the outstanding fix on that
issue is precisely that a disconnect must **not** kill in-flight work. Nobody
is waiting for the answer; SAP is still waiting for the rest of the chain.

So the listener stops tearing anything down and becomes a note: the caller is
gone. The pipeline runs to its natural end, the register empties, `safeStop`
runs, the slot is freed. Shutdown remains the one thing that aborts.

**"Stop writing" has to be built, not intended.** The handlers write to the
response unconditionally once streaming has begun
(`srv/openai-handler.ts`, `srv/anthropic-handler.ts`), and a write to a closed
socket throws. Caught by the pipeline, that throw ends the run — and the
guarantee this section just made would be undone by the very listener meant to
honour it. So the note detaches the output sink: after it, every chunk and
every closing envelope is dropped before it reaches the socket, and no write
error can be raised into the pipeline at all. Not "guarded", replaced.

**And the caller may come back while the first pipeline is still running.**
This document says at the top that a program has its own timeout and may retry
on its own, and carrying the first pipeline to the end makes that a real
collision: two runs of the same prompt against the same system, the second
starting while the first is midway through `create` / change / `activate`.

It matters how much of this the design creates and how much it inherits.
`execute_step` has no response object in scope and no reliable abort signal —
the code says so where the close hook would go — so a step already runs to
completion when its client gives up, and nothing here changes that. The chat
channels are where the change lands: today a disconnect tears the session down
at once, which is the orphaned-lock bug; tomorrow the work finishes, which is
correct and also widens the window in which a retry can overlap it.

*What SAP catches.* An ADT enqueue is held for the object being edited, so a
second run reaching **that same object** gets "currently editing" rather than a
silent second change. It is a real serialiser and a limited one: a replanned
retry that picks a different name, or an operation that takes no enqueue, walks
past it.

*What identity would catch, and does not.* An idempotency key is not available
— nothing that calls us sends one, and a key derived from the prompt cannot
tell a retry from a plan legitimately repeating a create. Nor is a session id a
substitute on the channels that matter. `/v1/chat/completions` mints a fresh
UUID when the client sends no `x-session-id`, `mcp-session-id` or cookie
(`srv/openai-handler.ts`), and `execute_step` mints `agent-step-<uuid>` on
every call by design (`srv/agent-mcp.ts`). Two retries from Cline, a script or
an MCP planner therefore share no session at all.

*So the guard is real but narrow, and the rest is a stated limit.* Where a
caller does identify itself, a request arriving while a caller-less pipeline of
the **same authenticated principal, same session and same destination** is
still running is refused, saying the earlier one is finishing.

**What that refusal looks like on the wire**, because reusing an existing
formatter would be wrong in both directions. It is not overload: `529`, a
retryable `503` or "try again shortly" invites an immediate retry into a guard
that is still closed. It is not a bad request either: the same call becomes
valid the moment the earlier pipeline ends. It is a conflict, and it is sent as
one — **`409`**, with a stable machine-readable `code` of ours,
`pipeline_in_flight`, and the nearest type each dialect already knows
(`invalid_request_error`), so no client meets a type it has never seen. **No
`Retry-After`**: when the orphan finishes is exactly as unknown as how long the
pipelines behind a full door will run, and the rule against manufacturing a
number holds here too.

It never appears mid-stream. The guard runs at admission, before a single byte
of response is written, so both chat channels answer it as an ordinary HTTP
error and there is no half-open stream to reconcile.

**And it exists on those two channels only.** `execute_step` is excluded, by
its own invariants two paragraphs above: it sees no disconnect, so no pipeline
of its is ever marked caller-less, and it mints a fresh `agent-step-<uuid>` per
call, so no two of its requests share a session. The guard has nothing to match
on there and would never fire. Saying otherwise would put an unreachable branch
in the plan and an unreachable assertion in the tests.

Should that channel ever be included, two things have to come first: the MCP
transport has to carry a stable caller identity and some notion of the caller
having gone, and the step's result has to be able to carry a machine-readable
code at all. It cannot today — `textResult` returns text content and `isError`
(`srv/agent-mcp.ts`), so a code would sit inside prose for a planner to find by
matching, which is the opposite of branching on it. That needs
`structuredContent` or `_meta`, and it is separate work. The principal is
in the key because the session id is client-supplied, and the codebase already
scopes session state by `(userId, sessionId)` for exactly that reason — without
it, one user could park a caller-less pipeline and block another who happened
to send the same session id.

Where a caller does not identify itself — the common case for programmatic
clients — nothing can match the two requests, and a retry runs as a second
pipeline. This is a **known limit, not a solved problem**: the collision is
bounded by SAP's enqueue where the object is the same, by the door where
capacity is short, and by nothing else. Closing it properly needs an
idempotency key on the wire, which is a change to what clients send and belongs
to a different piece of work.

Nothing frees a slot early. A slot freed while the pipeline still held memory
and a lock would let the door admit a replacement on top of it, which is the
double-booking this whole section exists to rule out.

**Shutdown is the same path, aborted all at once**, and the one place the
ordering above is allowed to be best-effort: it does not wait for the register
to empty or for the slots to come back before the process exits. What it
guarantees is that the abort was delivered and the ADT sessions were asked to
close, not that every socket closed first.

## The configuration contract

This repository owns the shape; whoever deploys owns the values. So the shape
has to be written down here, or the ownership is a claim rather than a fact.

### Variables

| Variable | Meaning | Absent |
|---|---|---|
| `LLM_GATEKEEPER_QUOTAS` | JSON: a map of quota key to `{ limit, windowMs }`. `limit` is a positive integer of request starts, `windowMs` a positive integer, defaulting to 60000 | no rate limiting; calls pass straight through |
| `LLM_GATEKEEPER_QUOTA_OF_MODEL` | JSON: a map of model name to quota key, for deployments where several models share one limit | each model is its own quota key |
| `LLM_GATEKEEPER_MAX_LIVE_PIPELINES` | positive integer: how many pipelines may be admitted at once, across all channels | no door on the chat channels; `execute_step` keeps its existing semaphore |

Example, for a deployment whose tenant meters two models separately:

```json
{
  "anthropic--claude-4.5-sonnet": { "limit": 60 },
  "text-embedding-3-small":       { "limit": 200 }
}
```

### Absent means off, malformed means refuse to start

There is no default rate, because there is no honest one: the number is a
property of someone's tenant, and this repository is forbidden elsewhere in this
document from guessing it. So an unset variable disables the thing it configures
and the service behaves exactly as it does today. An upgrade changes nothing
until somebody configures it.

A **malformed** value is the opposite: it fails at startup, loudly, naming the
variable. A limit that will not parse, a non-positive integer, a model mapped to
a quota key that has no entry — each is somebody intending a limit and not
getting one, which is the failure mode this whole design exists to make visible.
The precedent is `LLM_AGENT_THROTTLE_MAX_WAIT_MS`, which already fails at
startup rather than falling back to a default that hides the mistake.

### What is validated

- every `limit` and `windowMs` is a positive safe integer
- every value in `LLM_GATEKEEPER_QUOTA_OF_MODEL` names a key that exists in
  `LLM_GATEKEEPER_QUOTAS`
- `LLM_GATEKEEPER_MAX_LIVE_PIPELINES` is a positive safe integer
- **a runtime model with no quota is refused once quotas are configured.** The
  earlier rule — ungated, logged once at startup — cannot hold on this service.
  `/v1/chat/completions` accepts any `body.model` and `getSmartAgent` hot-swaps
  the shared main LLM to it for that request and the ones after
  (`srv/openai-handler.ts`, `srv/agent-manager.ts`), so the name may first be
  seen long after startup and a typo would silently un-gate every subsequent
  main call. The check therefore happens **at the swap**, not at boot: with
  `LLM_GATEKEEPER_QUOTAS` set, a model that names neither a quota entry nor a
  mapping is rejected — but **not** with this design's refusal shape. A door
  refusal and a throttle refusal both say "not now"; a program reading either
  is right to come back. An unconfigured model name will never become valid, so
  answering it with `529`, a retryable `503` or "try again shortly" invites a
  retry loop that cannot succeed. It is a bad request and it is answered as
  one: `400` with an `invalid_request_error`, naming the model and the variable
  that would have to list it. With no quotas configured at all nothing is gated and
  nothing is rejected, exactly as today

The values in force are logged at startup, for the same reason the throttle
ceiling is: a limit only shows itself under load, and by then nobody remembers
what was configured.

## When a dependency is down, the consumer decides

The door refuses because we are full. This is the other refusal: we are not
full, we are not able. It belongs in this document because both end at the same
place — a caller told no — and because getting the second one wrong undoes the
guarantee the first one buys.

**The decision is ours, and nothing below us should be making it.** llm-agent
has the seam for the fact: `IMcpFailureClassifier` names two kinds,
`unavailable` and `tool-error`, which is exactly the distinction that matters —
a server that is gone versus a tool that ran and failed. This service wires no
classifier at all, which is why nothing here closes a destination today.

So the shape is the same as everywhere else in this design. The library
establishes the fact and we decide what follows. Nothing below us may retry,
reconnect on its own, or convert an outage into a quieter-looking degradation —
and on our transport the third of those is the live risk, not the first two.
The section below says where.

**What we decide, stated plainly.**

A failure is scoped to a **destination**, not to the service. MCP here is
per-destination, built per request from the caller's headers, so one SAP system
being unreachable is no reason to refuse someone working with another. The
service as a whole stops only when something shared stops — the model provider,
say.

**RAG down is not MCP down.** Without MCP the executor has no tools at all and
can do nothing but talk, which is the failure mode this whole service exists to
prevent: an agent that answers confidently about ABAP it never read. Without
RAG it still has every tool, it simply chooses among them worse. The first
closes the destination; the second is logged and carried, because stopping for
it would cost more than it saves.

**New arrivals are refused; admitted pipelines are not killed *by us*.** The
qualifier matters, and an earlier draft of this section left it out. The door's
guarantee is about congestion: no `429`, and now no closing of a destination,
ends a pipeline that was let in. It was never a promise to survive the ABAP
system going away. A pipeline whose next tool call needs a server that is gone
fails on that call, the way any tool failure fails — what we undertake is not
to kill it *in addition*, because a pipeline cut mid-chain leaves an object
created-but-inactive and locked by a session nobody will unlock, and our own
refusal would be manufacturing work for a human in SM12.

**The ambiguous case has one answer, and it is not a retry.** A write that was
sent and whose answer never came is the hard one: the ADT call is asynchronous
in substance, so we cannot tell an applied change from a lost one, and the
system may well have applied it. Retrying is the worst available option — a
second attempt at the same change, against the rule this repository already
wrote down. Assuming success is worse still. So it is reported as what it is,
and the consumer — a human on the WebUI, or the planning agent on the MCP
surface — reads back and decides.

Saying it reuses the existing `UNVERIFIED_WRITE:` notice was too quick, and two
things have to be built for that sentence to be true.

**The notice cannot come from the finalizer.** `NoticeFinalizer` runs only when
the interpreter returned a result; on an execution failure the coordinator sets
its error and returns without calling it
(`pipeline/handlers/dag-coordinator.js` in llm-agent-libs). An outage is an
execution failure, so there is no executor response to append anything to. The
notice therefore belongs on **our** error path — the same place that already
composes `execute_step`'s failure text and the chat channels' error envelopes
(`srv/lib/throttle-surfacing.ts`) — built from what was recorded, not from a
response that does not exist.

**And the recording has to happen at dispatch.** `RecordingMcpClient` writes
its record *after* awaiting the call (`srv/lib/recording-mcp-client.ts`), so a
transport error that throws leaves no trace that a write was ever sent —
precisely the case we need to report. The record must be opened before the
call and closed when an answer arrives, so that "sent, unanswered" is a state
the error path can read rather than an absence it must infer.

With those two, the failure a caller receives names the tool, the object and
the fact that we do not know whether it applied, and the ADT session is
released on the way out as on every exit path.

**The refusal carries a number, and it has to be the true one.** `503`, never a
`500`, and `Retry-After` set to the time remaining until we next look at that
destination. Not the probe interval: the retry today is one process-wide
`setInterval` (`srv/agent-manager.ts`), whose phase has nothing to do with when
any particular destination failed, so a caller refused a second before a tick
would be told to wait five minutes while the recheck happens immediately. A
header that is wrong in both directions is worse than none.

So the scheduler records `nextProbeAt` per destination, and the header is the
remainder, rounded up. When nothing is scheduled — the timer stops once every
destination is reachable — there is no header, for the same reason the full
door carries none: we would be inventing it. What this number says is that we
will not have looked before then, which is ours to know, unlike when SAP
returns, which is not.

**Degrading silently is not on the table.** `LLM_AGENT_ALLOW_LLM_ONLY_FALLBACK`
already defaults to off, and an uninitialised destination already answers a
retryable `503` (`srv/agent-manager.ts`). What is missing is only that the same
posture applies to MCP lost *during* operation, not just at startup. This
section is that extension, not a new policy.

**The work is on the embedded path, and two earlier drafts had it on the wrong
one.** This service builds its MCP client with `transport: 'embedded'` and its
own `callToolHandler` (`srv/agent-manager.ts`), and the embedded branch of
`MCPClientWrapper` does not reconnect or retry at all: it catches the handler's
exception and returns an ordinary tool result carrying an `error` string. The
blind reconnect-and-retry sits only in the transport branch, which we never
reach. So removing it upstream — twice declared a prerequisite here — changes
nothing for this service. It is worth doing for other consumers and it is not
our gate.

What that leaves is a harder problem than the one the drafts described. On our
path a SAP outage does not arrive as a thrown transport failure; it arrives as
a tool result with a message in it, which is the same shape as a tool that ran
and legitimately failed. `McpClientAdapter` already draws the line —
a returned `error` stays tool-level feedback unless it matches a connection-loss
signature, and only those escalate to `ok:false`, deliberately not timeouts or
HTTP codes, since a tool's own "forbidden" is domain feedback and not an
outage. That rule is the classification point on our path, and it is a string
match.

So the plan owns three things here, and none of them is upstream:

- **What the handler raises.** `invokeEmbeddedTool` must distinguish a
  connection that could not be established or was lost from a tool that ran and
  failed, and raise them differently, so the distinction survives into the
  adapter instead of depending on how a message happens to read.
- **How it leaves the wrapper.** A returned `{ error }` collapses an outage
  into feedback. Either the handler's outage error carries a marker the adapter
  escalates on, or we stop routing outages through that return at all.
- **How it reaches destination state.** `IMcpFailureClassifier` is the library's
  seam for `unavailable` versus `tool-error` and this service does not wire one.
  Nothing closes a destination today because nothing tells it to.

## Not in scope

**Token limits.** OpenAI and Anthropic bound tokens per minute as well as
requests. We count requests only, and `acquire()` takes no cost argument.
Exceeding a limit we do not model looks the same as any other: a `429` with an
interval, handled below us. Estimating tokens before a call to avoid a failure
that is already handled is not worth its complexity.

**Reading the limit from the provider.** SAP exposes
`GET /v2/admin/quota/model`, which returns the requests-per-minute limit per
model. The number comes from configuration for now.

**A shared counter across instances.** The gatekeeper lives in process memory.
See the next section.

## Known limits of this design

**It does not guarantee the limit is respected.** The service cannot see the
subaccount's other consumers — the other fork deployments, `abap-dump-monitor`, anything else
in the subaccount. So the configured number is an estimate, and whoever deploys should
set it below the real limit. If it is too high we take more `429`s and work slows down; we do
not tear. That degradation is the expected failure mode, not an incident, and
the throttle handling below is what absorbs it.

**Scaling breaks the counter.** The state is in process memory. Today
`instances: 1`. A second instance means two independent windows against one
quota, so the limit is doubled. Changing that means shared state, and the design
would have to change with it.

**A rolling deploy doubles it briefly.** Even at one instance, the old process
drains while the new one admits. For those minutes we run two windows. Recorded
as a known mode rather than discovered in logs later.

**Shutdown does not free a slot instantly.** A pipeline inside one long ADT
call frees its slot when that call answers: an ADT request is asynchronous in
substance, so cutting it would discard our knowledge of the work rather than
stop it, and would leave the object locked. An LLM call now ends on the signal
(llm-agent 25.0.0), so that half of the tail is short. The ABAP half is not,
and sizing should assume it.

**A caller who leaves still costs a slot.** The pipeline runs to the end for an
answer nobody will read, holding its place the whole time. This is deliberate —
see Cancellation — and it means capacity has to be sized for work that is
started, not for work anyone is still waiting on.

**A permanent refusal costs a slot until shutdown.** Nothing below us can tell
a spend cap from a busy minute, and neither can we, so a pipeline meeting one
holds its place and keeps retrying on our own pacing. This is the accepted
cost of having no clock over running work: with capacity of N, N such pipelines
close the door until the service is restarted. A duration cap would trade it
for the opposite failure — cutting work that would have succeeded, mid-chain,
with a lock left behind — and that trade was refused deliberately. What makes
the cost bearable is that it is visible: door refusals rising with shallow
queues is exactly this, and the observability section reports it.

**The guarantee costs throughput at the door.** Capacity has to be reserved for
what admitted pipelines might yet ask for, not for what they are asking now. A
deployment sized for pipelines that each make twenty calls turns callers away
earlier than one sized for pipelines that make two, at the same memory. The
alternative is refusing work in flight, which is what the guarantee exists to
prevent.

**Shutdown cancels admitted work.** Stopping means no capacity for new
arrivals, which is the refusal the door already gives, and it also ends what is
already inside rather than waiting for it. Draining instead would mean a
restage held open by a pipeline retrying into a wall. So an admitted pipeline
has exactly one ending that is ours, and this is it.

## Shared code and forks

This repository is Apache 2.0 and holds only what is common: the mechanism, the
configuration shape, the wrappers, the refusal, the observability.

Forks are private and hold adaptations to a specific system, made by whoever
deploys it. Their quotas are different numbers in `.mtaext`, not a different
design. acme's provider will
not be SAP AI Core, which is why nothing in the gatekeeper may name one: it
knows a key, a limit and a window, and where those come from is configuration.


## Observability

Four scopes, because what they measure belongs to different things and adding
them up would answer nothing. Only three of them count refusals; the first
counts the work itself, since the quota queue refuses nobody.

**Per quota** — starts inside the window, waiters in the queue, and how long
the caller just admitted had waited. No refusals here: the quota queue does not
refuse anyone. It admits everything and orders it, which is the whole point of
having it.

**The door, once** — refusals, and how many pipelines are live. It is a single
global count, not a per-quota one: a pipeline is turned away before it makes
its first model call, so there is no quota to charge the refusal to.

**Per destination** — refusals caused by that destination being closed, and
whether it currently is. This is availability, not rate, and mixing it into a
quota's numbers would make an unreachable SAP system look like a full model
quota.

**Collisions, counted apart** — refusals from the guard above, and how many
caller-less pipelines are running. Folding these into the door's count would
read as memory pressure and send someone to buy memory that would change
nothing: the door was not full, a predecessor was still finishing. Rising
collisions with a shallow door mean callers are timing out and retrying, which
is a statement about their patience and our latency, not about capacity.

Together they answer the one question asked under load: are we hitting our own
limit or someone else's. A deep queue with no `429`s means ours is set too low.
An empty queue with `429`s arriving means another consumer is spending the
tenant's minute. Door refusals rising while queues stay shallow means memory is
the binding constraint, not rate.

The throttle observer already in llm-agent (`setThrottleObserver`) gives the
other side: how often the server refused us despite our accounting.

## Testing

These properties, because they are what this shape gets wrong:

- **No lost wake-up.** The state "waiters present, no dispatch scheduled" must
  never exist.
- **Order.** First in, first out, under contention as well. This is where
  `TokenBucketRateLimiter` fails.
- **The limit holds under pressure.** Twenty simultaneous callers against a
  limit of five produce exactly five starts in the window.
- **A capacity of one admits one and turns away the rest.** The degenerate
  setting is a setting.
- **An admitted pipeline is never refused.** Fill the capacity, then drive every
  admitted pipeline through more calls than the window allows: all complete,
  none is turned away. This is the guarantee, so it is the test that matters
  most.
- **And no `429` ends it.** An admitted pipeline meeting a `429` with an
  interval waits it out and finishes. One without an interval goes back to the
  tail of our own queue and finishes on a later attempt. Both are asserted,
  because "a 429 delays, it does not interrupt" is the property the guarantee
  is built on.

- **A full door refuses without a number.** No `Retry-After`, no seconds in the
  text: the door is full of running pipelines, and we do not measure how long
  they run. Asserted, because the previous version of this design invented a
  number here from the quota queue, which is a different resource entirely.
- **Every attempt is accounted.** A call that meets two `429`s before succeeding
  records three starts in the window, not one. This is what fails if anything
  below the gated wrapper starts retrying again.
- **And nothing else is.** A call turned back by the library's gate before the
  transport records no start at all: with the gate held shut, a limit of five
  and twenty callers, the window still has its five starts to give once the
  gate opens.
- **Shutdown cancels admitted work** rather than waiting for it, and nothing
  else of ours ends an admitted pipeline — a throttled one is slowed, never
  cut, however long it takes.
- **A session does not outlive its step.** The ADT session is torn down before
  the slot is released, so a freed slot never means a session still open.
- **A closed destination refuses arrivals and spares the admitted.** With MCP
  unreachable for one destination, a new request for it is refused with a `503`
  carrying the time left until that destination's `nextProbeAt` — not the whole
  interval, which is the bug this replaced — a request for another destination
  is served, and
  a pipeline already inside it is not cut by us — it fails only if it actually
  calls the missing server.
- **An unanswered write is reported, never repeated.** A tool call that was
  sent and whose answer never arrived produces one unverified-write failure and
  no second call, with the ADT session released. Two assertions, because each
  fails on its own: the transport sees exactly one call, and the failure the
  caller receives names the write — which it cannot do unless the record was
  opened at dispatch rather than written after the answer.
- **The refusal's `Retry-After` matches the schedule.** Refused just before a
  probe, the header says seconds and not the whole interval; with no probe
  scheduled, there is no header.
- **Every entrance is counted, including the CAP one.** A pipeline started
  through `AgentService.Chat` fills a door slot like any other, or the endpoint
  is gone. Asserted by driving each channel to capacity in turn, because a door
  with one way around it is not a door.
- **The slot outlives an aborted tool call, not only an aborted model call.**
  Abort a pipeline mid-write: the caller is answered, and the door still
  refuses an arrival until the embedded promise settles. Written against the
  MCP path specifically, because the LLM path passed this while the MCP path
  had no register at all.
- **The session outlives it too, and a disconnect ends nothing.** In the same
  run `closeSession` is not called until the registered promise has settled;
  and a client that disconnects mid-write leaves the pipeline running to its
  end, with teardown after it. Asserted on ordering, because a test that only
  counts the slot passes while the connection is pulled out from under a live
  write.
- **A dead socket cannot fail the run.** Disconnect mid-stream, then let the
  pipeline emit several more chunks and its closing envelope: all are dropped,
  none throws, and the run reaches its natural end. This is the test that
  fails if the sink is guarded rather than detached.
- **An identified retry is refused while the orphan runs; an anonymous one is
  not.** Same principal, session and destination during the first's caller-less
  tail: refused with the reason, no second write chain. A parallel request from
  a caller still connected is unaffected. And the same test asserts the limit
  honestly — two requests with no client-sent session both run, because nothing
  ties them together, which is the known limit rather than a bug to be found
  later.
- **The guard keys on the principal.** Two different users sending the same
  session id do not block each other.
- **The collision refusal is a conflict, not an overload.** `409` carrying
  `pipeline_in_flight` on both chat channels, no `Retry-After`, and never
  emitted after a stream has begun. Asserted on the wire shape, because a
  refusal that merely happens is one a client will hammer.
- **`execute_step` never produces it.** Drive the same collision through that
  channel and both calls run: it cannot see a disconnect and shares no session
  between calls. Asserted so the exclusion stays deliberate rather than
  becoming a gap someone closes by accident.
- **A returned permit wakes a sleeping waiter.** Park a waiter, give a permit
  back, and it proceeds without waiting for the expiry its timer was set to.
- **An unknown model is a bad request, not an overload.** With quotas
  configured, a `body.model` naming no quota answers `400`
  `invalid_request_error` — never `529`, never a retryable `503`.
- **A shared corpus build holds no caller's slot.** A request arriving
  mid-build waits before admission, so with the door at capacity minus one it
  does not consume the last place while it waits — and once admitted, the
  build's embedding calls are not in its register either.
- **A health check never waits.** With the quota shut, `healthCheck` reports
  throttled at once rather than sitting out the interval, and it still spends a
  permit, because it is still a request the window must see.
- **RAG down is carried, not fatal.** The same destination still answers with
  every tool available and a line in the log, because choosing tools worse is
  not the same as having none.
- **Cancellation reaches the waits, and the slot outlives the report.** A
  pipeline parked in the gatekeeper's queue and one parked in a wait-as-told
  both leave when the signal fires, and in both the slot is still held at the
  moment the caller is answered, and released only after safe-stop has run.
  Written against the observable order, because a `Promise.race` passes every
  other test on this list.
- **An abandoned LLM call still holds its slot.** Abort a pipeline while its
  transport promise is pending: the caller is answered, and the door still
  refuses a new arrival until that promise settles. This is the one the
  adapter's dropped signal would otherwise cost us, and it fails the moment the
  slot is released on the report instead of on the settle.
- **A `502` still retries.** Four attempts at the default `maxAttempts: 3`,
  which counts retries after the first call, and four permits — one per
  attempt. Two things fail this: mistaking the gated wrapper for a reason to
  drop `RetryLlm`, and reading the option's name as the number of requests.

## Relationship to what already exists

`WaitIfShortEnough` (`srv/lib/throttle-strategy.ts`) is **replaced** for admitted
pipelines, not merely demoted. Its ceiling protected a caller's connection from a
wait we could not predict. With a door in front, that protection has moved: a
request is either declined before it starts or carried to the end. A ceiling
behind the door would only kill work in flight, which is the failure the door
exists to prevent. Admitted pipelines therefore use `WaitAsTold` with no attempt
cap.

The behaviour that replaces it — wait as told, otherwise re-queue — belongs to
the gated wrapper, not to a strategy, because only that layer can take a permit
for each attempt. What the provider gets for admitted work is therefore
`ReportThrottling`: surface the refusal, absorb nothing, retry nothing.

**Model calls outside any pipeline exist, and they need a policy of their own.**
Leaving them as a "candidate" was a gap: two are already here, and they are not
alike.

**Building the shared tool corpus** is the first, and the earlier draft
described a path this service mostly does not take. The happy path loads
`srv/tool-embeddings.json`, a build-time bundle, with **zero** embedding calls;
runtime embedding happens only for entries that are missing or changed, or when
the bundle is absent or its fingerprint does not match the configured embedder
(`srv/agent-manager.ts`). So "hundreds of documents, every start" is the
fallback, not the rule — but it is a real fallback, it spends real quota when
it runs, and a deployment on an `openai` target meets it by design.

Nor is it reliably unattended. The build is kicked off in the background at
startup as a global single-flight, and a request arriving before it finishes
**awaits that same promise** on the request path. So the same work is sometimes
unwatched and sometimes has a caller behind it.

Which settles both questions. It is **gated** — a permit per attempt, because
the calls it makes are calls the window must see — and it **waits as told**,
because the work is shared and restarting it later costs more than waiting.

And one thing it must not do: **the corpus build is never registered against
an admission handle**, not even when a request is the one awaiting it. The
register exists so a pipeline's slot outlives the calls that pipeline started;
this work belongs to the process and outlives every pipeline. Attributing it to
whichever request happened to arrive first would make a global lifecycle the
property of one pipeline that may be gone before it ends.

**Keeping it out of the register is not enough on its own, though, and saying
so was half an answer.** A slot is held from admission until the pipeline ends,
so a request that is admitted and *then* waits for the build holds its slot for
the whole wait whatever the register says. `initDestination` awaits
`ensureSharedToolsVectorized` today (`srv/agent-manager.ts`), so this is the
ordinary path, not a corner.

So the order is fixed, and it is the useful half of the rule:

1. **Resolve the agent first** — the destination's readiness and any shared
   corpus build, both already bounded on the request path by
   `LLM_AGENT_DESTINATION_INIT_WAIT_MS`.
2. **Then admission.** The door is entered with an agent already in hand.
3. Pipeline, register, teardown, slot released, as above.

A caller waiting for the corpus is therefore waiting *outside* the door,
holding an HTTP request and no pipeline — which is the cheap thing to hold, and
the reason the wait is bounded there rather than here. And the background build
is started from startup, outside any request's admission context, so joining it
never transfers ownership to a caller.

**Health checks** are the opposite. `AgentService.Health` and the model probe
behind the OpenAI surface call `agent.healthCheck()` (`srv/agent-service.ts`,
`srv/openai-handler.ts`), and a liveness probe that waits out a `Retry-After`
is not a liveness probe — it is a hung request with no lifetime over it. So a
health call takes its permit like any other request, because it is one, but its
strategy is `ReportThrottling`: a `429` makes it report the quota as throttled,
immediately, which is a true and useful answer. It never waits and never
re-queues.

The rule underneath both: **every model call takes a permit, and only work with
somebody waiting on it gets a door slot.** Whether `WaitIfShortEnough` survives
anywhere is then answered — it does not. Waiting as told covers the batch case,
reporting covers the probe case, and the ceiling it existed to enforce belonged
to a world without a door.

The library's own gate stays as it is. It is a local safety net keyed on
something it inferred, and after this it should almost never fire: if it does,
our configured number is wrong or another consumer is spending the tenant's
minute. That is the signal to read it as. Because it refuses before the
transport, a refusal from it costs no permit — see "A refusal that never reached
the wire returns its permit".

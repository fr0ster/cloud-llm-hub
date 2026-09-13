# Gatekeeper: admission control for the LLM quota

**Status:** design approved, not implemented
**Date:** 2026-09-13

## TL;DR

One object per quota holds a FIFO queue and a sliding window of request starts.
Every model we call goes through it. If the window has room, the call goes. If
not, it waits its turn, for as long as that takes. Only when there is no room
left to hold it is a caller turned away, and then it is told how long the wait
would have been.

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
to both — a sentence for the person, a number in a field or header for the
program. The per-channel formatters in `srv/lib/throttle-surfacing.ts` exist for
exactly that split.

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
per window. A permit is taken on entry and never returned — duration is not its
business. This is why it is not a semaphore.

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

**Let in.** From here the answer is coming. It may be slow: the pipeline's calls
queue behind everyone else's, in order of arrival, with no ceiling on the wait
and none promised. A caller stays for as long as it stays, and if its own
timeout fires first that is its decision, not our failure.

**The guarantee: a pipeline that was let in is never refused by us.** If a
session was allowed to start work, that work completes, however slowly. This is
what makes the door worth having — a refusal there declines a whole request
cleanly, instead of killing one halfway with an ADT lock still held.

The guarantee has to be made true, not merely stated. An admitted pipeline uses
`WaitAsTold` with no attempt cap, not `WaitIfShortEnough`: a server that names
an interval is waited out however long it is. The ceiling in
`WaitIfShortEnough` existed to protect a caller's connection from a wait we
could not predict, and the door now protects capacity instead, so the ceiling
would only reintroduce the failure this section exists to prevent — a request
killed in flight.

**Its one exception, stated rather than hidden:** a `429` carrying no interval.
There is nothing to wait for, and the case exists — Anthropic omits the header
for a spend-cap refusal, which never clears by waiting. An admitted pipeline can
therefore still end in a provider failure. It cannot end in one of ours.

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

The wait **inside** is worth knowing even though it is not promised: queue
length divided by rate. At 78 requests per minute a queue of 39 means a call at
the back waits about 30 seconds. If that is longer than callers tolerate,
whoever deploys needs more quota, not fewer pipelines — fewer pipelines converts
waiting into refusals at the same load.

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

The two wrappers are thin. On the LLM side ours implements `ILlmRateLimiter`,
the interface `RateLimiterLlm` already calls — the decorator sits outermost, so
even a retry passes through. On the embedder side it is an `IEmbedder` wrapper.
Both call the same gatekeeper.

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
- a model with no mapping and no entry of its own is not an error: it is
  ungated, and that is logged once at startup so it is visible rather than
  silent

The values in force are logged at startup, for the same reason the throttle
ceiling is: a limit only shows itself under load, and by then nobody remembers
what was configured.

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

**The guarantee costs throughput at the door.** Capacity has to be reserved for
what admitted pipelines might yet ask for, not for what they are asking now. A
deployment sized for pipelines that each make twenty calls turns callers away
earlier than one sized for pipelines that make two, at the same memory. The
alternative is refusing work in flight, which is what the guarantee exists to
prevent.

**Shutdown looks like a full door.** Stopping means no capacity for new
arrivals, which is the refusal the door already gives. Admitted pipelines still
finish, which is the same guarantee under a different cause. No separate
mechanism.

## Shared code and forks

This repository is Apache 2.0 and holds only what is common: the mechanism, the
configuration shape, the wrappers, the refusal, the observability.

Forks are private and hold adaptations to a specific system, made by whoever
deploys it. Their quotas are different numbers in `.mtaext`, not a different
design. acme's provider will
not be SAP AI Core, which is why nothing in the gatekeeper may name one: it
knows a key, a limit and a window, and where those come from is configuration.


## Observability

Four numbers per quota:

- starts inside the window
- waiters in the queue
- how long the caller just admitted had waited
- refusals

Together they answer the one question asked under load: are we hitting our own
limit or someone else's. A deep queue with no `429`s means ours is set too low.
An empty queue with `429`s arriving means another consumer is spending the
tenant's minute.

The throttle observer already in llm-agent (`setThrottleObserver`) gives the
other side: how often the server refused us despite our accounting.

## Testing

Three properties, because they are what this shape gets wrong:

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
- **And it survives a provider 429 mid-flight.** An admitted pipeline that meets
  a `429` naming an interval waits it out and finishes, however long. Only a
  `429` naming nothing ends it, and the test asserts that too, so the exception
  stays deliberate rather than becoming a discovery.

Plus: a refusal at a full queue carries the right number, and shutdown behaves
as a full queue.

## Relationship to what already exists

`WaitIfShortEnough` (`srv/lib/throttle-strategy.ts`) is **replaced** for admitted
pipelines, not merely demoted. Its ceiling protected a caller's connection from a
wait we could not predict. With a door in front, that protection has moved: a
request is either declined before it starts or carried to the end. A ceiling
behind the door would only kill work in flight, which is the failure the door
exists to prevent. Admitted pipelines therefore use `WaitAsTold` with no attempt
cap.

Whether the strategy survives anywhere depends on whether anything still calls a
model outside an admitted pipeline. Startup tool vectorization is the candidate:
it embeds hundreds of documents before any request exists, so there is no door
in front of it and no caller to protect. Deciding that is part of the
implementation plan, not this design.

The library's own gate stays as it is. It is a local safety net keyed on
something it inferred, and after this it should almost never fire: if it does,
our configured number is wrong or another consumer is spending the tenant's
minute. That is the signal to read it as.

# Verification: turn/follow, delivery by message id, WebUI streaming

Date: 2026-10-25.

**Builds.** 9.5.0 for the first WebUI pass, then 9.5.1 for everything else. 9.5.1 adds the supersede fix that this run found.

**Setup.** The POC deployment, in dialogue coordinator mode, with persistent sessions on HANA. One SAP destination was used with a read-only workload: listing and reading the newest runtime errors.

**What this implements.** Plan `docs/superpowers/plans/2026-10-25-protocol-follow-delivery.md`, Task 10. The spec is `docs/superpowers/specs/2026-10-24-client-protocol-design.md` (rollout step 2).

## Clients

**WebUI.** Driven through a real browser (Playwright, Edge) via the approuter. A fetch tap in the page recorded the stream's framing comments, and an SSE probe read `/v1/session/events`.

**SDKs:**
- **OpenAI SDK** (`openai`): streaming and non-streaming.
- **Anthropic SDK** (`@anthropic-ai/sdk`): streaming.

**Third-party client.** The `llm` CLI (0.36), with an OpenAI-compatible model entry pointing at the hub. It sent the session and SAP headers configured in that model entry.

**Plain fetch client.** A script that reads raw SSE lines. Unlike the WebUI it does no deduplication, so any redelivery is visible.

## Results

| Scenario (spec acceptance) | Client | Result |
|---|---|---|
| 1 (partial: read-only; collection writes, scopes and the checker not exercised). Multi-step read task: reply, `: turn-end`, follow, background result, one `[DONE]` | WebUI, OpenAI SDK stream, Anthropic SDK stream, `llm` CLI | pass |
| 3 (partial: protocol side only; whether the planner applied the correction was not judged). Correction while a follow is open: old stream ends with the supersede note and one `[DONE]`; the new request is admitted at once | WebUI, plain client | pass |
| 7 (partial: no forced long admission or initialization wait; no initialization error). Keep-alive written on open (7 ms after the request) and every 10 s through a 23 s silent follow; one terminal sequence | WebUI | pass |
| 10. Cut right after `: turn-end`: the next response delivers the cut response's complete reply again, then the messages produced meanwhile | plain client | pass |
| 14 (partial: SSE-view tab attached after and during a stream; no cut stream in either tab). Two tabs on one session: the stream tab and the SSE-view tab show every message once | WebUI | pass |
| 15/16. Supersede with and without `x-clh-ack`: no message the old response carried is delivered again | plain client | pass on 9.5.1, fail on 9.5.0 (fixed by #78) |
| 17. Implicit mode, normal path: no duplicates | plain client | pass |
| Non-streaming: one message, `x-clh-last-message` set, `finish_reason: stop` | OpenAI SDK | pass |
| SSE view: every message once, with its `trigger` (user/event), in outbox order | WebUI SSE probe | pass |
| WebUI acknowledgement: `x-clh-ack: none` first, then the id of the last complete message | WebUI tap | pass |

## Not run

- **Spec scenarios:** 2 (a question ends the turn), 8 and 8a (failed steps; a pause before the turn's outbox write), 9 (a hub error after partial follow content), 10a (TTL shorter than the run), 15a (a reply still streaming while another tab acknowledges).
  - These are covered by unit tests on the branch; they were not reproduced live.
- **Client combinations:** OpenAI and Anthropic non-streaming with a follow-length task, and the Anthropic SDK in explicit acknowledgement mode.

## Evidence (sanitized)

Ids are truncated; times are milliseconds from the response start.

- **Scenario 1, WebUI stream.** `: keep-alive` at 7 and 10008 → `: message-id 3fe2…`/`: message-end 3fe2…` at 14478 → `: turn-end` at 14478 → `: keep-alive` at 19992 and 30009 → `: message-id 9ff3…`/`: message-end 9ff3…` at 37825 → final chunk and `data: [DONE]` at 37825.
- **Supersede, plain client.**
  - On 9.5.0, the new request with `x-clh-ack: 9067…` streamed `: message-id 9067…` again.
  - On 9.5.1, in both modes: old stream with note + `[DONE]`; new stream ids `{8fa8…, 28d8…}` and `{040d…, 0e5d…}`, none of the old ones.
- **Cut, plain client.** The cut response carried `4a0d…` and was aborted at `: turn-end`. The next response streamed `4a0d…`, `4a56…`, `f53a…`, `[DONE]`.
- **Non-streaming, OpenAI SDK.** Status 200, `x-clh-last-message: dc27…`, `finish_reason: stop`.
- **SSE view.** Messages with `trigger` user/event in outbox order. Each id appeared once in both tabs.

## Found and fixed during the run

**Supersede redelivery (9.5.0).** After a supersede, the new request delivered the old response's last message again, even though its `x-clh-ack` named that id.

- Cause: the superseded response's delivery had not ended when the new request read its acknowledgement.
- Fixed in 9.5.1 (#78): supersede now waits for the old response to finish, bounded at 5 s.

**Leading empty paragraph (9.5.0).** A turn reply started with an empty paragraph. Fixed in 9.5.1 (#78).

## Observations (not protocol defects)

- **Unconfirmed after a finished write.** A client that reads up to the last message and then aborts, after the server has already written `[DONE]`, confirms nothing; but the server counts the response as ended, so a later arrival confirms it. This is the documented limit of implicit mode. Explicit `x-clh-ack` covers it.
- **Second tab opens a new session.** In a second WebUI tab, CONNECT opens a new session; it does not join the existing one. Existing WebUI behaviour.
- **Planner answers an earlier request.** The planner twice answered an earlier, unhandled request instead of the newest one. Delivery was correct: the answers carry `trigger: user`. With all collections selected, about 100K characters of retrieved context accompany every planner turn. This belongs to the planner prompt and retrieval-size work.
- **XSUAA secret rotates on deploy.** Each deploy recreated the srv XSUAA binding with a new client secret. Local tooling that keeps a copy of the binding credentials must refresh it after a deploy.
- **`llm` CLI on Windows.** It waits on stdin when stdin is not a terminal, and needs UTF-8 output (`PYTHONIOENCODING=utf-8`). Client-side only.

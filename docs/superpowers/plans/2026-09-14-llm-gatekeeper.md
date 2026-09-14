# LLM Gatekeeper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit sessions against this service's own memory — a counted door with a bounded queue in front of it and a bounded retention of idle sessions behind it — so that a caller is refused cleanly before anything starts or carried to the end, and no session's state is deleted out from under work still using it.

**Architecture:** Three units with no knowledge of Express or CAP: the configuration (`gatekeeper-config`), the door (slots, one bounded queue, dispatch to the oldest eligible waiter, the register of calls in flight), and retention (places, leases, the mark that closes a session before it is deleted, LRU eviction). One process-wide module, `gatekeeper`, joins them to the real stores and is the only thing the three channels and the RAG routes call. Session identity becomes the authenticated user together with the session this service issued in `clh_session`; request headers stop naming sessions.

**Tech Stack:** TypeScript (strict), SAP CAP (`@sap/cds` 9), Express, Node 22, Jest + ts-jest, Biome. `@mcp-abap-adt/llm-agent` 25.0.0 (`ILlm`, `WaitAsTold`, `CallOptions.signal`, `setThrottleObserver`, `IMcpFailureClassifier`), `@mcp-abap-adt/llm-agent-libs` 25.0.0 (`makeLlm`), `@mcp-abap-adt/llm-agent-mcp` 25.0.0.

**Spec:** `docs/superpowers/specs/2026-09-13-llm-gatekeeper-design.md` (approved at `6ec86092`). This plan supersedes the rate-limit plan of the same name; nothing of the quota window, permits or `GatedLlm` survives.

## Global Constraints

- **Absent means off, malformed means refuse to start.** An unset variable disables what it configures and the service behaves as today. A value that will not parse, or is not a positive integer, throws at startup naming the variable. Precedent: `LLM_AGENT_THROTTLE_MAX_WAIT_MS`.
- **Three variables, exactly these:** `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` (absent: no door on the chat channels; `execute_step` keeps its semaphore of two); `LLM_GATEKEEPER_QUEUE_LENGTH` (absent: the capacity); `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` (requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` and may not be smaller than it; absent: unbounded).
- **Only shutdown ends an admitted session.** Not a `429`, not a client disconnect, not a logout, not a clock of ours.
- **Teardown order:** stop starting new calls → wait for the register to empty → `safeStop` → release the slot, last.
- **Admission takes a slot and a retention place atomically, or neither.**
- **A door refusal carries no `Retry-After` and no number in its text.** Reasons, in check order: `session_busy`, `capacity`, `retention`.
- **Identity is the authenticated user plus the session this service issued.** `x-session-id` and `mcp-session-id` are never read to identify a session. Every composite key of the two is `JSON.stringify([userId, sessionId])` — never a join, which some pair of values always makes ambiguous.
- **Every deletion of a session's state is three steps:** close it to new leases → wait for the leases in flight to settle, cancelling only RAG operations → remove it once, through the primitive that frees the disk.
- **Every removal of a collection frees its directory.**
- **No new timeout above the connector.** The only bounds are an `AbortSignal` from whoever waits, and idleness where nothing runs.
- **Never blind-retry a stateful write.**
- `instances: 1` holds; every counter is per process.
- All code, comments, commit messages and docs in **English**. Biome: single quotes, 2-space indent, 100-char width.
- Every task ends green on `npm run test:unit`, `npm run test:check`, and `npx biome check` for the files it touched.

## Decisions this plan makes that the spec leaves open

Named here so a reviewer can reject one without hunting for it.

1. **`sessionTopicMap` is deleted, not rekeyed.** The spec lists it among the stores to move to `(userId, sessionId)`. It is never written: `srv/agent-manager.ts` declares it and `clearSessionTopic` deletes from it, and nothing else touches it. Rekeying a map nothing fills would be ceremony; removing it leaves one store fewer for eviction to remember.
2. **The throttle strategy follows the door.** `WaitAsTold` when `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` is set; `WaitIfShortEnough` otherwise. The spec replaces the ceiling "for admitted work" and leaves the rest to the plan; with no door nothing is admitted, and an unbounded wait would hold a connection the client cuts at a minute — which is exactly what "absent means today" forbids.
3. **The detached sink and "a disconnect ends nothing" apply whether or not a door is configured.** They are the fix for the orphaned ADT locks, not a limit. "The chat channels are unchanged" is read as "no admission limit", which stays true.
4. **A RAG request against a session already closed for deletion is answered `410`** with `{ error: { message, code: 'session_closed' } }`. The spec says it is refused and gives no shape.
5. **Metrics are exposed on the existing `Health` function** (`srv/mcp-proxy.ts`), as one added `gatekeeper` field holding the snapshot as JSON — CDS types are closed, and a type per scope would change with every counter — and the values in force are logged at startup. No new route.
6. **A retained session stops counting when nothing holds it and nothing is left in it** — no lease, no history in `sessionStore`, no session collection. Checked on the existing five-minute history sweep. The spec bounds how many are held and says nothing about when an idle one leaves the count by itself.
7. **A cookie names a live session when retention knows it and it is not closing, or when any store still holds state for it.** Anything else is a cookie holding nothing, and a fresh session is minted. A caller that creates no state (a `GET /v1/models`) is minted a new cookie each time; that is cheap and is the price of keeping no registry of issued ids.
8. **A queue length without a capacity is refused at startup.** The spec says a queue length defaults to the capacity and says nothing of one set alone. With no door there is nothing to wait for, so the setting would do nothing while looking like a limit — the failure "malformed means refuse to start" exists to make visible.

---

## Phase map

Each phase leaves the service working and tested; a later one may be deferred without leaving an earlier one half-built.

| Phase | Tasks | Deliverable |
|---|---|---|
| 1 — identity and the stores | 1–3 | Service-issued session only; every collection ending frees its directory; one primitive over every store keyed by `(userId, sessionId)` |
| 2 — retention | 4–6 | Configuration; places, leases, mark-then-delete, LRU eviction; wired into RAG routes, logout, sweeps and the cookie |
| 3 — the door | 7–13 | The door; per-channel refusals; the register; the sink and one admission call; both chat channels; `execute_step`; shutdown and the strategy |
| 4 — a dependency that is down | 14–16 | Outage told from tool failure; closed destinations; unanswered writes reported |
| 5 — surface and record | 17–19 | `AgentService.Chat` removed; four observability scopes; documentation |

## File structure

**New files**

| File | Responsibility |
|---|---|
| `srv/lib/session-middleware.ts` | The `/v1` session middleware, lifted out of `server.ts` so it can be tested: reads only `clh_session`, mints and sets a cookie when the one presented names no live session. |
| `srv/session-store.ts` | The server-side history store, moved out of `openai-handler` so the gatekeeper can reach it without an import cycle. |
| `srv/lib/session-state.ts` | The one operation over every store keyed by `(userId, sessionId)`: `deleteSessionState`, `hasSessionState`. |
| `srv/lib/gatekeeper-config.ts` | Reads and validates the three `LLM_GATEKEEPER_*` variables. Holds no runtime state. |
| `srv/lib/session-retention.ts` | Places, leases, the closing mark, three-step deletion, LRU eviction, the sweep's skip test. Pure: stores are injected. |
| `srv/lib/door.ts` | Slots, one bounded FIFO queue, oldest-eligible dispatch, atomic slot-plus-place, refusal reasons, the admission handle with its controller and call register. Pure: retention is injected. |
| `srv/lib/admission-scope.ts` | `runWithAdmission` / `currentAdmission` over `AsyncLocalStorage`, so the tool dispatcher and the LLM wrapper can register a call without importing the door. |
| `srv/lib/tracked-llm.ts` | An `ILlm` decorator that registers each model call against the admission in scope. |
| `srv/lib/detached-sink.ts` | The output sink a disconnect detaches: after it, every write is dropped before the socket and none throws. |
| `srv/lib/gatekeeper.ts` | The process singleton: builds door and retention from configuration and the real stores; the only surface the channels, RAG routes, server and health call. |
| `srv/lib/gatekeeper-metrics.ts` | The four scopes, kept apart. |
| `srv/lib/mcp-outage.ts` | Tells a lost connection from a tool that failed (Phase 4). |
| `test/unit/helpers/channel-harness.ts` | Fake `req`/`res` and mocked agent seams for driving the three channels in-process. |

**Modified files**

| File | Change |
|---|---|
| `srv/session-id.ts` | Cookie only; `carriesSessionHeader`, `sessionIdOf`. |
| `srv/server.ts` | Uses the middleware; `DELETE /v1/session` goes through the gatekeeper; sweeps wired; shutdown hook. |
| `srv/rag-collections.ts` | `removeCollection` frees the directory for every ending; sweep takes a skip test; `hasSessionCollections`; bulk writes honour a signal. |
| `srv/rag-handler.ts` | Old header refused on session scope; leases around session-scoped operations; retention and closed-session refusals. |
| `srv/agent-manager.ts` | `lastDestinationBySession` keyed by user and session; `sessionTopicMap` removed; tool calls registered at dispatch; model calls tracked; Phase 4 wiring. |
| `srv/openai-handler.ts`, `srv/anthropic-handler.ts` | Admission after the agent resolves; detached sink; teardown order; refusals; destination keyed by user. |
| `srv/agent-mcp.ts` | The door replaces the semaphore when configured; refusal text; teardown order. |
| `srv/agent-config.ts` | Strategy chosen by the door; gatekeeper values logged. |
| `srv/lib/throttle-surfacing.ts` | Door refusal formatters per channel; closed-session and closed-destination text. |
| `srv/mcp-proxy.ts`, `srv/mcp-proxy.cds` | `Health` carries the gatekeeper snapshot. |
| `srv/agent-service.ts`, `srv/agent-service.cds` | `Chat` removed. |
| `app/chat/webapp/controller/Chat.controller.js` | Stops inventing and sending a session id. |
| `docs/architecture/*.md`, `docs/llm-agent/*.md`, `docs/deployment/TESTING_AFTER_DEPLOYMENT.md`, `README.md` | The new contract, the migration, the removed surface. |

## Phase 1 — identity and the stores

### Task 1: The session is the one we issued

**Files:**
- Modify: `srv/session-id.ts` (whole file)
- Create: `srv/lib/session-middleware.ts`
- Modify: `srv/server.ts:478-495` (the inline `/v1` session middleware)
- Modify: `srv/rag-handler.ts` (session scope refuses the old header; the four `resolveSessionId` fallbacks at `:122-124`, `:208-210`, `:314-316`, `:711-713`)
- Modify: `srv/openai-handler.ts:403-409`, `srv/anthropic-handler.ts:112`
- Modify: `app/chat/webapp/util/StreamClient.js:19-30`, `app/chat/webapp/controller/Chat.controller.js:16-21,65,125-136`
- Test: `test/unit/session-id.test.ts` (rewritten), `test/unit/session-middleware.test.ts` (new), `test/unit/session-identity-surface.test.ts` (new), `test/unit/rag-handler.test.ts`, `test/unit/cross-user-isolation.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function resolveSessionId(req: IncomingHeaders): string | undefined` — `clh_session` only
  - `export function carriesSessionHeader(req: IncomingHeaders): boolean`
  - `export type WithSession = IncomingHeaders & { sessionId?: string; sessionMinted?: boolean }`
  - `export function sessionIdOf(req: WithSession): string | undefined` — what the middleware stashed, else the cookie
  - `export function honouredSessionId(req: WithSession): string | undefined` — the presented session when the middleware kept it, `undefined` when it minted
  - `export interface SessionMiddlewareDeps { isLive?: (userId: string, sessionId: string) => boolean; userIdOf?: () => string }`
  - `export function sessionMiddleware(deps?: SessionMiddlewareDeps): (req: Request, res: Response, next: NextFunction) => void`

**Why the header goes, including for RAG:** between a consumer and MCP and ABAP there is no reason for a consumer to name a chat session. A header that did was one more value to validate and one more way to collide; a session-scoped collection is scoped to the session, and every request now has one issued by us. The user half of the key comes from the token, so the unsigned cookie is harmless: a chosen value collides with its own author's requests and nobody else's.

**Why loudly on RAG:** `x-session-id` with `scope: 'session'` is answered `400` naming the cookie. Silence would let a caller build collections under a session it can never address.

- [ ] **Step 1: Write the failing tests**

Replace `test/unit/session-id.test.ts` entirely:

```ts
import {
  buildSetCookie,
  carriesSessionHeader,
  honouredSessionId,
  resolveSessionId,
  SESSION_COOKIE,
  sessionIdOf,
} from '../../srv/session-id';

function req(headers: Record<string, string | undefined>) {
  return { headers } as Parameters<typeof resolveSessionId>[0];
}

describe('resolveSessionId — the cookie we issued, and nothing a caller names', () => {
  test('reads the clh_session cookie', () => {
    const r = req({ cookie: `other=value; ${SESSION_COOKIE}=cookie-abc; another=x` });
    expect(resolveSessionId(r)).toBe('cookie-abc');
  });

  test('does not read x-session-id', () => {
    expect(resolveSessionId(req({ 'x-session-id': 'hdr' }))).toBeUndefined();
  });

  test('does not read mcp-session-id', () => {
    expect(resolveSessionId(req({ 'mcp-session-id': 'mcp' }))).toBeUndefined();
  });

  test('a header naming another session changes nothing', () => {
    // The case the header existed for, and the reason it goes: whatever a
    // caller writes, the session is the one in the cookie we issued.
    const r = req({ 'x-session-id': 'victim', cookie: `${SESSION_COOKIE}=mine` });
    expect(resolveSessionId(r)).toBe('mine');
  });

  test('returns undefined when there is no cookie', () => {
    expect(resolveSessionId(req({}))).toBeUndefined();
  });

  test('returns undefined when the clh_session value is empty', () => {
    expect(resolveSessionId(req({ cookie: `${SESSION_COOKIE}=` }))).toBeUndefined();
  });

  test('parses the cookie when clh_session is the first entry', () => {
    expect(resolveSessionId(req({ cookie: `${SESSION_COOKIE}=first; other=x` }))).toBe('first');
  });

  test('ignores a cookie named like a prefix of clh_session', () => {
    expect(resolveSessionId(req({ cookie: 'clh_sessio=nope' }))).toBeUndefined();
  });
});

describe('carriesSessionHeader', () => {
  test('sees x-session-id', () => {
    expect(carriesSessionHeader(req({ 'x-session-id': 'a' }))).toBe(true);
  });

  test('sees mcp-session-id', () => {
    expect(carriesSessionHeader(req({ 'mcp-session-id': 'a' }))).toBe(true);
  });

  test('does not count a blank header', () => {
    expect(carriesSessionHeader(req({ 'x-session-id': '   ' }))).toBe(false);
  });

  test('does not count the cookie', () => {
    expect(carriesSessionHeader(req({ cookie: `${SESSION_COOKIE}=a` }))).toBe(false);
  });
});

describe('sessionIdOf and honouredSessionId', () => {
  test('prefer what the middleware stashed over the raw cookie', () => {
    const r = { ...req({ cookie: `${SESSION_COOKIE}=old` }), sessionId: 's-new', sessionMinted: true };
    expect(sessionIdOf(r)).toBe('s-new');
    // Minted now: the caller presented nothing we kept, so there is no
    // server-managed history to prepend.
    expect(honouredSessionId(r)).toBeUndefined();
  });

  test('a kept cookie is honoured', () => {
    const r = { ...req({ cookie: `${SESSION_COOKIE}=kept` }), sessionId: 'kept', sessionMinted: false };
    expect(honouredSessionId(r)).toBe('kept');
  });

  test('fall back to the cookie when no middleware ran', () => {
    expect(sessionIdOf(req({ cookie: `${SESSION_COOKIE}=raw` }))).toBe('raw');
  });
});

describe('buildSetCookie', () => {
  test('includes HttpOnly; SameSite=Lax; Path=/', () => {
    const v = buildSetCookie('sid123', false);
    expect(v).toContain('HttpOnly');
    expect(v).toContain('SameSite=Lax');
    expect(v).toContain('Path=/');
    expect(v).toContain('sid123');
  });

  test('includes Secure when secure=true', () => {
    expect(buildSetCookie('sid123', true)).toContain('Secure');
  });

  test('does NOT include Secure when secure=false', () => {
    expect(buildSetCookie('sid123', false)).not.toContain('Secure');
  });

  test('cookie name is SESSION_COOKIE constant', () => {
    expect(buildSetCookie('val', false).startsWith(`${SESSION_COOKIE}=val`)).toBe(true);
  });
});
```

Create `test/unit/session-middleware.test.ts`:

```ts
import type { NextFunction, Request, Response } from 'express';
import { sessionMiddleware } from '../../srv/lib/session-middleware';
import { SESSION_COOKIE } from '../../srv/session-id';

type Stashed = Request & { sessionId?: string; sessionMinted?: boolean };

function run(
  headers: Record<string, string>,
  deps?: Parameters<typeof sessionMiddleware>[0],
) {
  const req = { headers, secure: false } as unknown as Stashed;
  const set: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      set[k] = v;
    },
  } as unknown as Response;
  let called = false;
  const next: NextFunction = () => {
    called = true;
  };
  sessionMiddleware(deps)(req, res, next);
  return { req, set, called };
}

describe('the /v1 session middleware', () => {
  it('honours the cookie it issued', () => {
    const { req, set, called } = run({ cookie: `${SESSION_COOKIE}=s-abc` });
    expect(called).toBe(true);
    expect(req.sessionId).toBe('s-abc');
    expect(req.sessionMinted).toBe(false);
    expect(set['Set-Cookie']).toBeUndefined();
  });

  it('does not let a request name its session', () => {
    const { req, set } = run({ 'x-session-id': 'victim' });
    expect(req.sessionId).not.toBe('victim');
    expect(req.sessionId).toMatch(/^s-/);
    expect(req.sessionMinted).toBe(true);
    expect(set['Set-Cookie']).toContain(`${SESSION_COOKIE}=${req.sessionId}`);
  });

  it('ignores mcp-session-id the same way', () => {
    const { req } = run({ 'mcp-session-id': 'victim' });
    expect(req.sessionId).not.toBe('victim');
  });

  it('marks the cookie Secure behind https', () => {
    const { set } = run({ 'x-forwarded-proto': 'https' });
    expect(set['Set-Cookie']).toContain('Secure');
  });

  it('mints a new session for a cookie that names no live one', () => {
    const { req, set } = run(
      { cookie: `${SESSION_COOKIE}=s-retired` },
      { isLive: () => false, userIdOf: () => 'alice' },
    );
    expect(req.sessionId).not.toBe('s-retired');
    expect(req.sessionMinted).toBe(true);
    expect(set['Set-Cookie']).toContain(`${SESSION_COOKIE}=${req.sessionId}`);
  });

  it('asks about liveness with the user from the token', () => {
    const seen: Array<[string, string]> = [];
    run(
      { cookie: `${SESSION_COOKIE}=s-1` },
      {
        isLive: (u, s) => {
          seen.push([u, s]);
          return true;
        },
        userIdOf: () => 'alice',
      },
    );
    expect(seen).toEqual([['alice', 's-1']]);
  });
});
```

Create `test/unit/session-identity-surface.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(__dirname, '../..', f), 'utf8');

describe('no client of ours names a session', () => {
  // The browser's chat session survives on the cookie alone. A client still
  // inventing an id and sending it would now be sending something nobody reads,
  // and would look to its author as if it mattered.
  for (const file of [
    'app/chat/webapp/index.html',
    'app/chat/webapp/util/StreamClient.js',
    'app/chat/webapp/controller/Chat.controller.js',
  ]) {
    it(`${file} sends no x-session-id`, () => {
      expect(read(file)).not.toMatch(/x-session-id/i);
    });
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest test/unit/session-id.test.ts test/unit/session-middleware.test.ts test/unit/session-identity-surface.test.ts`
Expected: FAIL — `carriesSessionHeader` is not exported, `srv/lib/session-middleware` is not found, and `StreamClient.js` and `Chat.controller.js` still contain `x-session-id`.

- [ ] **Step 3: Rewrite `srv/session-id.ts`**

```ts
/**
 * Session identity.
 *
 * A session is the one this service issued in `clh_session`, together with the
 * authenticated user. Nothing a caller writes in a header names one:
 * `x-session-id` and `mcp-session-id` are not read. Between a consumer and MCP
 * and ABAP there is no reason for a consumer to name a chat session, and a
 * header that did was one more value to validate and one more way to collide.
 *
 * The cookie is unsigned and nothing records what was issued, so a caller can
 * still send any value in it. That is harmless only because the user half of
 * the key comes from the token: a chosen id collides with its own author's
 * requests and nobody else's.
 */

/** Name of the HttpOnly session cookie issued by the session middleware. */
export const SESSION_COOKIE = 'clh_session';

/** Minimal shape of an Express request the helpers here need. */
interface IncomingHeaders {
  headers: {
    [key: string]: string | string[] | undefined;
    cookie?: string;
  };
}

/** A request the session middleware has seen. */
export type WithSession = IncomingHeaders & {
  sessionId?: string;
  sessionMinted?: boolean;
};

/** The `clh_session` cookie's value, or `undefined`. */
export function resolveSessionId(req: IncomingHeaders): string | undefined {
  const cookieStr = req.headers.cookie;
  if (!cookieStr) return undefined;
  for (const part of cookieStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const val = part.slice(eq + 1).trim();
      return val || undefined;
    }
  }
  return undefined;
}

/**
 * Whether the request still carries a session header.
 *
 * Read only to refuse it loudly where silence would mislead — never to identify
 * a session.
 */
export function carriesSessionHeader(req: IncomingHeaders): boolean {
  const first = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim();
  return !!(
    first(req.headers['x-session-id']) || first(req.headers['mcp-session-id'])
  );
}

/** The session this request runs under: what the middleware stashed, else the cookie. */
export function sessionIdOf(req: WithSession): string | undefined {
  return req.sessionId ?? resolveSessionId(req);
}

/**
 * The session the caller presented and we kept, or `undefined` when the
 * middleware minted a new one.
 *
 * The difference decides whether history is server-managed: a caller that
 * presented nothing we kept has no stored turns to prepend, and a stateless API
 * client sending its full history must not be truncated to its last message.
 */
export function honouredSessionId(req: WithSession): string | undefined {
  return req.sessionMinted ? undefined : sessionIdOf(req);
}

/**
 * Build a `Set-Cookie` header value for the session cookie.
 *
 * @param secure When true, appends `; Secure` (behind HTTPS / the CF approuter).
 *               When false, it is omitted so the cookie works on plain
 *               `http://localhost` during local development.
 */
export function buildSetCookie(sessionId: string, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`;
  return secure ? `${base}; Secure` : base;
}
```

- [ ] **Step 4: Create the middleware and use it**

Create `srv/lib/session-middleware.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { buildSetCookie, resolveSessionId, type WithSession } from '../session-id';

export interface SessionMiddlewareDeps {
  /**
   * Whether a presented session still exists. Absent: every presented cookie is
   * kept. Supplied once retention exists (Task 6), so a cookie naming a session
   * that was deleted, evicted or swept is treated as holding nothing.
   */
  isLive?: (userId: string, sessionId: string) => boolean;
  /** The authenticated user. The middleware runs after auth, so CAP's context has it. */
  userIdOf?: () => string;
}

/**
 * Give every `/v1` request a session this service issued.
 *
 * Keeps the presented `clh_session` when it names a live session, and otherwise
 * mints one and sets the cookie — never a revival of the old id, so state a
 * caller asked us to destroy cannot be reattached through the cookie in their
 * jar.
 */
export function sessionMiddleware(deps: SessionMiddlewareDeps = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = req as Request & WithSession;
    const presented = resolveSessionId(r);
    const userId = deps.userIdOf?.() ?? 'anonymous';
    if (presented !== undefined && (deps.isLive?.(userId, presented) ?? true)) {
      r.sessionId = presented;
      r.sessionMinted = false;
      next();
      return;
    }
    const sid = `s-${randomUUID()}`;
    const secure = !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
    res.setHeader('Set-Cookie', buildSetCookie(sid, secure));
    r.sessionId = sid;
    r.sessionMinted = true;
    next();
  };
}
```

In `srv/server.ts`, replace the whole inline block that starts with the comment `// Session middleware: resolves (or mints) the session ID for every /v1/* request.` and ends with its `});` by:

```ts
  // Every /v1 request runs under a session this service issued. The cookie is
  // the only thing read; a header naming a session is not.
  app.use(
    '/v1',
    sessionMiddleware({ userIdOf: () => cds.context?.user?.id ?? 'anonymous' }),
  );
```

and add `import { sessionMiddleware } from './lib/session-middleware';`. Remove `buildSetCookie` from the `./session-id` import; `npx biome check srv/server.ts` names any import left unused.

- [ ] **Step 5: The chat handlers read the issued session**

In `srv/openai-handler.ts`, replace:

```ts
  const explicitSessionId = resolveSessionId(req);
  // Session id used for history + RAG keying: the middleware-stashed id (explicit, or the
  // freshly-minted cookie id), falling back defensively if the middleware didn't run.
  const sessionId =
    (req as Request & { sessionId?: string }).sessionId ??
    explicitSessionId ??
    randomUUID();
```

with:

```ts
  // A session the caller presented and we kept. A freshly minted one is not
  // explicit: a stateless API client sending its full history must never be
  // truncated to its last message.
  const explicitSessionId = honouredSessionId(req);
  const sessionId = sessionIdOf(req) ?? randomUUID();
```

and change the import to `import { honouredSessionId, sessionIdOf } from './session-id';`. Update the comment block above it: the explicit session is "the `clh_session` cookie the middleware kept", not a header.

In `srv/anthropic-handler.ts:112`, replace `const sessionId = resolveSessionId(req);` with `const sessionId = sessionIdOf(req);` and the import with `import { sessionIdOf } from './session-id';`.

- [ ] **Step 6: RAG refuses the old header on session scope, and reads the issued session**

In `srv/rag-handler.ts`, change the import to `import { carriesSessionHeader, sessionIdOf } from './session-id';` and replace each of the four expressions

```ts
      (req as Request & { sessionId?: string }).sessionId ??
      resolveSessionId(req)
```

(at `:122-124`, `:208-210`, `:314-316` and `:711-713`) with `sessionIdOf(req)`.

In `POST /rag/collections`, replace the session branch's opening:

```ts
      if (scope === 'session') {
        const sid =
          (req as Request & { sessionId?: string }).sessionId ??
          resolveSessionId(req);
        if (!sid) {
          error(
            res,
            400,
            'session scope requires an active session (x-session-id header or clh_session cookie)',
          );
          return;
        }
```

with:

```ts
      if (scope === 'session') {
        // Refused, not ignored. Ignoring it would create the collection under
        // the issued session, which this caller evidently is not tracking, and
        // it would find nothing where it looks next.
        if (carriesSessionHeader(req)) {
          error(
            res,
            400,
            'x-session-id is no longer read. A session collection belongs to the session this service issued: keep the clh_session cookie from a previous response and send it back.',
          );
          return;
        }
        const sid = sessionIdOf(req);
        if (!sid) {
          error(
            res,
            400,
            'session scope requires the clh_session cookie issued by this service',
          );
          return;
        }
```

In `test/unit/rag-handler.test.ts`:

- line 4 of the header comment: `session-scope requires x-session-id` → `session-scope requires the issued clh_session cookie`
- the test `'session-scope without x-session-id → 400'` is renamed `'session-scope without the issued cookie → 400'`; its body is unchanged
- the test `'session-scope with x-session-id: physical id is <logical>__s_<key>'` is renamed `'session-scope with the issued cookie: physical id is <logical>__s_<key>'`, and its headers `{ 'x-session-id': 'sess-abc' }` become `{ cookie: 'clh_session=sess-abc' }`
- `doGet({ 'x-session-id': 'session-1' })` becomes `doGet({ cookie: 'clh_session=session-1' })`, and `doGet({ 'x-session-id': 'some-session' })` becomes `doGet({ cookie: 'clh_session=some-session' })`

and add, inside the `describe` that defines `doPost`:

```ts
    test('session-scope that still sends x-session-id → 400 naming the cookie', async () => {
      asUser('alice@example.com');
      const res = await doPost(
        { id: 'result', displayName: 'Result', scope: 'session' },
        { 'x-session-id': 'sess-abc', cookie: 'clh_session=sess-abc' },
      );
      expect(res._status).toBe(400);
      expect(JSON.stringify(res._body)).toMatch(/clh_session/);
    });

    test('a client that keeps the cookie keeps its session collection', async () => {
      // The migration path for every client that used to send the header, so it
      // is a test and not a sentence in a release note.
      asUser('alice@example.com');
      const cookie = { cookie: 'clh_session=kept-1' };
      const created = await doPost(
        { id: 'notes', displayName: 'Notes', scope: 'session' },
        cookie,
      );
      expect(created._status).toBe(201);
      const req = makeReq({ method: 'GET', params: { id: 'notes' }, headers: cookie });
      const res = await runWithMiddleware(routes, 'GET', '/rag/collections/:id', req);
      expect(res._status).toBe(200);
      expect((res._body as { id?: string }).id).toBe(
        sessionCollectionId('notes', 'alice@example.com', 'kept-1'),
      );
    });
```

In `test/unit/cross-user-isolation.test.ts`, the session travels in the cookie, and the assertions do not change:

- `{ 'x-session-id': rawSessionId }` (twice, around `:261` and `:298`) → `{ cookie: \`clh_session=${rawSessionId}\` }`
- `{ 'x-session-id': 'session-2' }` (around `:416` and `:447`) → `{ cookie: 'clh_session=session-2' }`
- `{ 'x-session-id': 'session-1' }` (around `:488`) → `{ cookie: 'clh_session=session-1' }`
- `{ 'x-session-id': 'session-2' }` (around `:497`) → `{ cookie: 'clh_session=session-2' }`
- the two test titles reading `same raw x-session-id` → `same raw session id`

- [ ] **Step 7: The chat UI stops inventing a session**

In `app/chat/webapp/util/StreamClient.js`, delete the `@param {string} [options.sessionId]` line and the block

```js
      if (options.sessionId) {
        headers["x-session-id"] = options.sessionId;
      }
```

In `app/chat/webapp/controller/Chat.controller.js`:

- delete `_sessionId: null,`
- replace the two lines in `onInit` that generate and log `this._sessionId` with `console.log("[Chat] Controller v3 initialized");`
- delete `sessionId: this._sessionId,` from the `StreamClient.streamChat` options
- in `onClearHistory`, replace the `if (this._sessionId) { fetch(... headers: { "x-session-id": ... }) }` block and the line generating a new id after it with:

```js
      // The clh_session cookie is sent automatically; the server issues a new
      // session on the next request once this one is gone.
      fetch(StreamClient._getBaseUrl() + "/v1/session", {
        method: "DELETE",
        credentials: "same-origin"
      }).catch(function () { /* best effort */ });
```

- [ ] **Step 8: Run, lint, commit**

```bash
npx jest test/unit/session-id.test.ts test/unit/session-middleware.test.ts test/unit/session-identity-surface.test.ts test/unit/rag-handler.test.ts test/unit/cross-user-isolation.test.ts
npm run test:unit && npm run test:check
npx biome check --write srv/session-id.ts srv/lib/session-middleware.ts srv/server.ts srv/rag-handler.ts srv/openai-handler.ts srv/anthropic-handler.ts test/unit/session-id.test.ts test/unit/session-middleware.test.ts test/unit/session-identity-surface.test.ts test/unit/rag-handler.test.ts test/unit/cross-user-isolation.test.ts
git add srv/session-id.ts srv/lib/session-middleware.ts srv/server.ts srv/rag-handler.ts srv/openai-handler.ts srv/anthropic-handler.ts app/chat/webapp/util/StreamClient.js app/chat/webapp/controller/Chat.controller.js test/unit/session-id.test.ts test/unit/session-middleware.test.ts test/unit/session-identity-surface.test.ts test/unit/rag-handler.test.ts test/unit/cross-user-isolation.test.ts
git commit -m "feat(session)!: the session is the one we issued, and no header names it"
```

---

### Task 2: Every way a collection ends frees its directory

**Files:**
- Modify: `srv/rag-collections.ts:566-575` (`deleteCollection`), `:604-638` (`sweepExpiredSessions`, `deleteSessionCollections`)
- Test: `test/unit/rag-collections-disk.test.ts` (new); `test/unit/rag-collections-session.test.ts` stays green unchanged

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `private removeCollection(id: string): boolean` — registry entry, every user's enabled flag, the directory; persists nothing
  - `hasSessionCollections(userId: string, sessionId: string): boolean`
  - `sweepExpiredSessions(): void` and `deleteSessionCollections(userId, sessionId): void` keep their signatures and now free storage

**Why this is a bug today and not a gap in the design:** `deleteSessionCollections` (logout, clear-chat) and `sweepExpiredSessions` (the twenty-four-hour TTL) drop the registry entry and rewrite the metadata, and never call `deleteCollectionDir`, which only `deleteCollection` does. The sweep is the quiet one: it runs on a timer and leaks every session collection this service has ever made. A retention bound built on top of that would count something that had stopped meaning anything.

- [ ] **Step 1: Write the failing test**

Create `test/unit/rag-collections-disk.test.ts`:

```ts
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CollectionRegistry } from '../../srv/rag-collections';

let dir: string;
let reg: CollectionRegistry;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-disk-'));
  reg = new CollectionRegistry({ storagePath: dir });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A collection with one document written, so its directory exists. */
async function withDocument(
  id: string,
  meta: { scope: 'session' | 'user'; owner: string; sessionId?: string; expiresAt?: number },
): Promise<string> {
  reg.createCollection({
    id,
    logicalId: id.split('__')[0],
    displayName: id,
    description: '',
    ...meta,
  });
  await reg.addDocument(id, { id: 'd1', text: 'hello', metadata: {} });
  const collectionDir = path.join(dir, id);
  // Guard the premise: a test that never wrote a directory proves nothing
  // about removing one.
  expect(fs.existsSync(collectionDir)).toBe(true);
  return collectionDir;
}

describe('every way a collection ends takes its directory with it', () => {
  it('deleteCollection, as it always did', async () => {
    const d = await withDocument('u__u_1', { scope: 'user', owner: 'alice' });
    reg.deleteCollection('u__u_1');
    expect(reg.getCollection('u__u_1')).toBeNull();
    expect(fs.existsSync(d)).toBe(false);
  });

  it('deleteSessionCollections — logout and clear-chat, which leaked', async () => {
    const d = await withDocument('s__s_1', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'x',
      expiresAt: Date.now() + 60_000,
    });
    reg.deleteSessionCollections('alice', 'x');
    expect(reg.getCollection('s__s_1')).toBeNull();
    expect(fs.existsSync(d)).toBe(false);
  });

  it('sweepExpiredSessions — the TTL, which leaked on a timer', async () => {
    const d = await withDocument('s__s_2', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'y',
      expiresAt: Date.now() - 1,
    });
    reg.sweepExpiredSessions();
    expect(reg.getCollection('s__s_2')).toBeNull();
    expect(fs.existsSync(d)).toBe(false);
  });

  it('leaves what did not end on disk', async () => {
    const live = await withDocument('s__s_3', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'z',
      expiresAt: Date.now() + 60_000,
    });
    const user = await withDocument('u__u_2', { scope: 'user', owner: 'alice' });
    reg.sweepExpiredSessions();
    reg.deleteSessionCollections('bob', 'z');
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(user)).toBe(true);
  });

  it('forgets the enabled flag of what it removed', async () => {
    await withDocument('s__s_4', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'w',
      expiresAt: Date.now() + 60_000,
    });
    reg.setEnabled('alice', 's__s_4', true);
    reg.deleteSessionCollections('alice', 'w');
    expect(reg.getEnabled('alice', 's__s_4')).toBeUndefined();
  });
});

describe('hasSessionCollections', () => {
  it('answers per user and session', async () => {
    await withDocument('s__s_5', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'v',
      expiresAt: Date.now() + 60_000,
    });
    expect(reg.hasSessionCollections('alice', 'v')).toBe(true);
    expect(reg.hasSessionCollections('bob', 'v')).toBe(false);
    expect(reg.hasSessionCollections('alice', 'other')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/rag-collections-disk.test.ts`
Expected: FAIL — the two leak tests find the directory still present, and `hasSessionCollections is not a function`.

- [ ] **Step 3: One primitive, used by all three**

In `srv/rag-collections.ts`, add beside `deleteCollectionDir`:

```ts
  /**
   * Remove one collection completely: its registry entry, every user's enabled
   * flag for it, and its directory on disk.
   *
   * The one primitive every ending goes through. Only `deleteCollection` used to
   * free the directory; logout, clear-chat and the TTL sweep dropped the entry
   * and left the documents on disk with nothing pointing at them. Persists
   * nothing, so a caller removing several writes the metadata once.
   */
  private removeCollection(id: string): boolean {
    if (!this.collections.delete(id)) return false;
    for (const m of this.enabledByUser.values()) m.delete(id);
    this.deleteCollectionDir(id);
    return true;
  }
```

Replace `deleteCollection`:

```ts
  deleteCollection(id: string): boolean {
    const deleted = this.removeCollection(id);
    if (deleted) {
      this.persistMeta();
      this.persistEnabled();
      this.log.info('Collection deleted', { id });
    }
    return deleted;
  }
```

Replace `sweepExpiredSessions` and `deleteSessionCollections`, and add `hasSessionCollections` after them:

```ts
  sweepExpiredSessions(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, stored] of [...this.collections]) {
      if (
        stored.meta.scope === 'session' &&
        (stored.meta.expiresAt ?? 0) <= now
      ) {
        changed = this.removeCollection(id) || changed;
      }
    }
    if (changed) {
      this.persistMeta();
      this.persistEnabled();
    }
  }

  deleteSessionCollections(userId: string, sessionId: string): void {
    let changed = false;
    for (const [id, stored] of [...this.collections]) {
      if (
        stored.meta.scope === 'session' &&
        stored.meta.owner === userId &&
        stored.meta.sessionId === sessionId
      ) {
        changed = this.removeCollection(id) || changed;
      }
    }
    if (changed) {
      this.persistMeta();
      this.persistEnabled();
    }
  }

  /** Whether this user's session still owns any session-scoped collection. */
  hasSessionCollections(userId: string, sessionId: string): boolean {
    for (const stored of this.collections.values()) {
      if (
        stored.meta.scope === 'session' &&
        stored.meta.owner === userId &&
        stored.meta.sessionId === sessionId
      ) {
        return true;
      }
    }
    return false;
  }
```

- [ ] **Step 4: Run, lint, commit**

```bash
npx jest test/unit/rag-collections-disk.test.ts test/unit/rag-collections-session.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/rag-collections.ts test/unit/rag-collections-disk.test.ts
git add srv/rag-collections.ts test/unit/rag-collections-disk.test.ts
git commit -m "fix(rag): every way a collection ends frees its directory, not only one"
```

---

### Task 3: One primitive over every store a session holds

**Files:**
- Create: `srv/lib/session-state.ts`
- Modify: `srv/agent-manager.ts:830-864` (`lastDestinationBySession` keyed by user and session; `sessionTopicMap` and `clearSessionTopic` removed)
- Create: `srv/session-store.ts` (the history store, moved out of `srv/openai-handler.ts`)
- Modify: `srv/openai-handler.ts` (the store moves out and is re-exported; `:543`, `:653`, `:660-661`; imports)
- Modify: `srv/anthropic-handler.ts:112-113`
- Modify: `srv/server.ts:580-605` (`DELETE /v1/session`; imports)
- Test: `test/unit/session-state.test.ts` (new)

**Interfaces:**
- Consumes: `sessionIdOf` (Task 1); `hasSessionCollections`, `deleteSessionCollections` (Task 2).
- Produces:
  - `export function getCurrentDestination(userId?: string, sessionId?: string): string`
  - `export function setSessionDestination(userId: string, sessionId: string, destination: string): void`
  - `export function forgetSessionDestination(userId: string, sessionId: string): void`
  - in `srv/session-store.ts`: `getSessionHistory`, `appendToSession`, `clearSession` (moved with unchanged signatures, re-exported from `openai-handler`), and `export function hasSessionHistory(sessionId: string, userId: string): boolean`
  - `export function deleteSessionState(userId: string, sessionId: string): void`
  - `export function hasSessionState(userId: string, sessionId: string): boolean`

**Why the key is a prerequisite and not a tidy-up:** `lastDestinationBySession` is keyed by the session id alone. Two users whose sessions carry the same id already share it, so one user's destination can be read for another's request, and a central deletion over `(userId, sessionId)` would delete the wrong entry precisely when two users collide. It is also cleared by nobody today.

**Why `sessionTopicMap` is removed rather than rekeyed:** nothing writes it. It is declared, and `clearSessionTopic` deletes from it, and that is all.

**Why the destination does not count as state:** `hasSessionState` answers "does this session still hold memory worth bounding". A destination name is a few bytes; counting it would keep a session retained for ever after its turns and documents have gone.

**Why the history store moves out of the handler:** the gatekeeper (Task 6) imports `session-state`, and the chat handler (Task 11) imports the gatekeeper. With the store inside `openai-handler`, `session-state` would import the handler that imports it back. The store has nothing to do with HTTP; it moves to its own module and the handler re-exports it, so existing importers keep working.

- [ ] **Step 1: Write the failing test**

Create `test/unit/session-state.test.ts`:

```ts
const mockCdsContext: { user?: { id: string; is?: (role: string) => boolean } } = {};
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return mockCdsContext;
      },
    },
  }),
  { virtual: true },
);

jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
  getRequestHistory: () => [],
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCollectionRegistry,
  getCurrentDestination,
  setSessionDestination,
} from '../../srv/agent-manager';
import { sessionCollectionId } from '../../srv/collection-ids';
import { deleteSessionState, hasSessionState } from '../../srv/lib/session-state';
import { appendToSession, getSessionHistory } from '../../srv/session-store';

const SID = 'shared-id';

function seed(user: string, destination: string) {
  appendToSession(SID, user, { role: 'user', content: `hi from ${user}` });
  setSessionDestination(user, SID, destination);
  getCollectionRegistry().createCollection({
    id: sessionCollectionId('notes', user, SID),
    logicalId: 'notes',
    displayName: 'notes',
    description: '',
    scope: 'session',
    owner: user,
    sessionId: SID,
    expiresAt: Date.now() + 60_000,
  });
}

afterEach(() => {
  deleteSessionState('alice', SID);
  deleteSessionState('bob', SID);
});

describe('one session, every store', () => {
  it('does not collide when the parts could be read two ways', () => {
    // ("a", "b c") and ("a b", "c") must stay two keys, whatever separator a
    // join would use.
    setSessionDestination('a', 'b c', 'S4HANA_DEV');
    setSessionDestination('a b', 'c', 'S4HANA_QAS');
    expect(getCurrentDestination('a', 'b c')).toBe('S4HANA_DEV');
    expect(getCurrentDestination('a b', 'c')).toBe('S4HANA_QAS');
  });

  it('does not share a destination between two users with the same session id', () => {
    seed('alice', 'S4HANA_DEV');
    seed('bob', 'S4HANA_QAS');
    expect(getCurrentDestination('alice', SID)).toBe('S4HANA_DEV');
    expect(getCurrentDestination('bob', SID)).toBe('S4HANA_QAS');
  });

  it("deletes one user's session and leaves the other's turns, collections and destination", () => {
    seed('alice', 'S4HANA_DEV');
    seed('bob', 'S4HANA_QAS');

    deleteSessionState('alice', SID);

    expect(getSessionHistory(SID, 'alice')).toEqual([]);
    expect(getCollectionRegistry().getCollection(sessionCollectionId('notes', 'alice', SID))).toBeNull();
    expect(getCurrentDestination('alice', SID)).not.toBe('S4HANA_DEV');

    expect(getSessionHistory(SID, 'bob')).toHaveLength(1);
    expect(getCollectionRegistry().getCollection(sessionCollectionId('notes', 'bob', SID))).not.toBeNull();
    expect(getCurrentDestination('bob', SID)).toBe('S4HANA_QAS');
  });

  it('reports what is still held', () => {
    seed('alice', 'S4HANA_DEV');
    expect(hasSessionState('alice', SID)).toBe(true);
    deleteSessionState('alice', SID);
    expect(hasSessionState('alice', SID)).toBe(false);
  });
});

describe('no per-session map is keyed by the session alone', () => {
  it('holds in agent-manager', () => {
    const src = readFileSync(join(__dirname, '../../srv/agent-manager.ts'), 'utf8');
    expect(src).not.toMatch(/sessionTopicMap/);
    expect(src).not.toMatch(/lastDestinationBySession\.(get|set|delete)\(\s*sessionId\s*[,)]/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/session-state.test.ts`
Expected: FAIL — `srv/lib/session-state` is not found.

- [ ] **Step 3: Key the destination by user and session, and remove the dead map**

In `srv/agent-manager.ts`, replace everything from `/** Last-used destination per session (for detecting switches in openai-handler) */` through the end of `setSessionDestination` with:

```ts
/**
 * Last-used destination per (user, session), for detecting switches.
 *
 * Keyed by the user as well as the session: keyed by the session alone, two
 * users whose sessions carried the same id shared an entry, so one user's
 * destination could be read for another's request.
 */
const lastDestinationBySession = new Map<string, string>();

function destinationKey(userId: string, sessionId: string): string {
  // A tuple, not a join: no separator keeps ("a", "b c") and ("a b", "c") apart
  // whatever a caller puts in a cookie.
  return JSON.stringify([userId, sessionId]);
}

/** Last-used destination for a user's session, or the configured default. */
export function getCurrentDestination(userId?: string, sessionId?: string): string {
  if (userId && sessionId) {
    return (
      lastDestinationBySession.get(destinationKey(userId, sessionId)) ||
      getAgentConfig().mcp.destination
    );
  }
  return getAgentConfig().mcp.destination;
}

/** Track which destination a user's session is using. */
export function setSessionDestination(
  userId: string,
  sessionId: string,
  destination: string,
): void {
  lastDestinationBySession.set(destinationKey(userId, sessionId), destination);
}

/** Forget a user's session destination. Nothing cleared it before. */
export function forgetSessionDestination(userId: string, sessionId: string): void {
  lastDestinationBySession.delete(destinationKey(userId, sessionId));
}
```

This removes `sessionTopicMap` and `clearSessionTopic` with it.

- [ ] **Step 4: Move the history store out of the handler, and report whether a session holds history**

Create `srv/session-store.ts` and move into it, unchanged, everything in `srv/openai-handler.ts` from the `// Server-side session history` section banner through the end of `clearSession` — `SESSION_MAX_MESSAGES`, `SESSION_TTL_MS`, `SESSION_CLEANUP_INTERVAL_MS`, `SessionEntry`, `sessionStore`, `sessionStoreKey`, the cleanup `setInterval`, `getSessionHistory`, `appendToSession` and `clearSession` — **except** `recordTurnForRecall`, which stays in the handler. Give the new file the imports those need:

```ts
import type { Message } from '@mcp-abap-adt/llm-agent';
import { getSharedHistoryRag } from './agent-manager';
import { turnOwner } from './lib/session-history-rag';
```

In `srv/openai-handler.ts`, import what the handler still uses and re-export the three moved functions:

```ts
import { appendToSession, clearSession, getSessionHistory } from './session-store';

// Re-exported: tests and other modules imported these from the handler.
export { appendToSession, clearSession, getSessionHistory };
```

`turnOwner` and `getSharedHistoryRag` stay imported in the handler — `recordTurnForRecall` uses both. Remove whatever `npx biome check srv/openai-handler.ts` reports as unused.

Then add to `srv/session-store.ts`, after `getSessionHistory`:

```ts
/**
 * Whether this user's session still holds any turns.
 *
 * Unlike `getSessionHistory` this does not refresh `lastAccess`: asking whether
 * a session is idle must not make it look busy.
 */
export function hasSessionHistory(sessionId: string, userId: string): boolean {
  return sessionStore.has(sessionStoreKey(sessionId, userId));
}
```

Update the callers in `srv/openai-handler.ts`:

- `const destBefore = getCurrentDestination(sessionId);` → `const destBefore = getCurrentDestination(userId, sessionId);`
- `setSessionDestination(sessionId, destAfter);` → `setSessionDestination(userId, sessionId, destAfter);`
- delete the line `clearSessionTopic(sessionId);` in the destination-reconnect block
- remove `clearSessionTopic` from the `./agent-manager` import

`userId` is already declared earlier in `handleChatCompletions` (`const userId = getUserId();`), before `destBefore`.

In `srv/anthropic-handler.ts`, replace:

```ts
  const sessionId = sessionIdOf(req);
  const destination = requestedDestination || getCurrentDestination(sessionId);
```

with:

```ts
  const sessionId = sessionIdOf(req);
  const userId = cds.context?.user?.id ?? 'anonymous';
  const destination =
    requestedDestination || getCurrentDestination(userId, sessionId);
```

- [ ] **Step 5: Create the primitive**

Create `srv/lib/session-state.ts`:

```ts
import { forgetSessionDestination, getCollectionRegistry } from '../agent-manager';
import { clearSession, hasSessionHistory } from '../session-store';

/**
 * Every store keyed by one session, in one place.
 *
 * Logout, clear-chat and eviction each used to remember their own list, and
 * each remembered a different one: the history and the collections were
 * cleared, the destination never was, and a map nothing wrote was cleared on
 * every path. A bound that dropped only the history would be theatre — the
 * documents are where most of the memory is.
 *
 * Synchronous on purpose. Retention calls it inside the same turn of the event
 * loop in which it decided the session could go (Task 5), so nothing can take a
 * lease between the decision and the deletion.
 */
export function deleteSessionState(userId: string, sessionId: string): void {
  clearSession(sessionId, userId);
  forgetSessionDestination(userId, sessionId);
  getCollectionRegistry().deleteSessionCollections(userId, sessionId);
}

/**
 * Whether this session still holds memory worth bounding: turns, or session
 * collections. The destination name is deliberately not counted — a few bytes
 * that would keep a session retained after everything else had gone.
 */
export function hasSessionState(userId: string, sessionId: string): boolean {
  return (
    hasSessionHistory(sessionId, userId) ||
    getCollectionRegistry().hasSessionCollections(userId, sessionId)
  );
}
```

`clearSession`'s own call to `getSharedHistoryRag()?.forgetOwner(...)` is fire-and-forget already and stays so.

- [ ] **Step 6: Logout and clear-chat use it**

In `srv/server.ts`, replace the body of `app.delete('/v1/session', ...)` with:

```ts
  app.delete('/v1/session', ((req: Request, res: Response) => {
    const sessionId = sessionIdOf(req);
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'no session (the clh_session cookie is required)' },
        }),
      );
      return;
    }
    const userId = cds.context?.user?.id ?? 'anonymous';
    // Every store, through one primitive. Task 6 puts the close-then-delete
    // sequence in front of this, so a pipeline or upload still running is not
    // cut from under.
    deleteSessionState(userId, sessionId);
    res.writeHead(204);
    res.end();
  }) as never);
```

Add `import { deleteSessionState } from './lib/session-state';`, change the `./session-id` import to include `sessionIdOf`, and remove `clearSession` and `clearSessionTopic` from their imports if nothing else in the file uses them.

- [ ] **Step 7: Run, lint, commit**

```bash
npx jest test/unit/session-state.test.ts test/unit/cross-user-isolation.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/session-state.ts srv/session-store.ts srv/agent-manager.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/server.ts test/unit/session-state.test.ts
git add srv/lib/session-state.ts srv/session-store.ts srv/agent-manager.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/server.ts test/unit/session-state.test.ts
git commit -m "refactor(session): one primitive over every store a session holds, keyed by the user too"
```

---

## Phase 2 — retention

### Task 4: The configuration

**Files:**
- Create: `srv/lib/gatekeeper-config.ts`
- Modify: `srv/agent-config.ts` (validate at load, log the values in force)
- Test: `test/unit/gatekeeper-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface GatekeeperConfig { maxLiveSessions?: number; queueLength?: number; maxRetainedSessions?: number }`
  - `export function loadGatekeeperConfig(): GatekeeperConfig` — reads and validates, throws naming the variable
  - `export function gatekeeperConfig(): GatekeeperConfig` — cached
  - `export function describeGatekeeperConfig(cfg?: GatekeeperConfig): Record<string, number | string>`
  - `export function clearGatekeeperConfig(): void` — test seam

**Why its own module:** the door and retention both consume it, and `agent-config` validates it at startup. A module holding no runtime state can be depended on by all three without an import cycle through live counters.

- [ ] **Step 1: Write the failing test**

Create `test/unit/gatekeeper-config.test.ts`:

```ts
import {
  clearGatekeeperConfig,
  describeGatekeeperConfig,
  loadGatekeeperConfig,
} from '../../srv/lib/gatekeeper-config';

const VARS = [
  'LLM_GATEKEEPER_MAX_LIVE_SESSIONS',
  'LLM_GATEKEEPER_QUEUE_LENGTH',
  'LLM_GATEKEEPER_MAX_RETAINED_SESSIONS',
] as const;

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  clearGatekeeperConfig();
});

describe('absent means off', () => {
  it('configures nothing when nothing is set', () => {
    expect(loadGatekeeperConfig()).toEqual({
      maxLiveSessions: undefined,
      queueLength: undefined,
      maxRetainedSessions: undefined,
    });
  });

  it('treats a blank value as unset', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '  ';
    expect(loadGatekeeperConfig().maxLiveSessions).toBeUndefined();
  });
});

describe('the queue is derived from the capacity', () => {
  it('defaults to the capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
    expect(loadGatekeeperConfig()).toMatchObject({ maxLiveSessions: 4, queueLength: 4 });
  });

  it('takes an explicit length', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
    process.env.LLM_GATEKEEPER_QUEUE_LENGTH = '2';
    expect(loadGatekeeperConfig().queueLength).toBe(2);
  });

  it('refuses a queue with no door in front of it', () => {
    process.env.LLM_GATEKEEPER_QUEUE_LENGTH = '2';
    expect(() => loadGatekeeperConfig()).toThrow(
      /LLM_GATEKEEPER_QUEUE_LENGTH[\s\S]*LLM_GATEKEEPER_MAX_LIVE_SESSIONS/,
    );
  });
});

describe('malformed means refuse to start, naming the variable', () => {
  for (const v of VARS) {
    for (const bad of ['0', '-1', '2.5', 'four', '1e3x']) {
      it(`${v}=${bad}`, () => {
        process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '8';
        process.env[v] = bad;
        expect(() => loadGatekeeperConfig()).toThrow(new RegExp(v));
      });
    }
  }
});

describe('retention requires a capacity and may not be smaller than it', () => {
  it('refuses retention without a capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = '10';
    expect(() => loadGatekeeperConfig()).toThrow(
      /LLM_GATEKEEPER_MAX_RETAINED_SESSIONS[\s\S]*LLM_GATEKEEPER_MAX_LIVE_SESSIONS/,
    );
  });

  it('refuses retention below capacity, naming both', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '5';
    process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = '2';
    expect(() => loadGatekeeperConfig()).toThrow(
      /LLM_GATEKEEPER_MAX_RETAINED_SESSIONS[\s\S]*LLM_GATEKEEPER_MAX_LIVE_SESSIONS/,
    );
  });

  it('accepts retention equal to capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '5';
    process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = '5';
    expect(loadGatekeeperConfig().maxRetainedSessions).toBe(5);
  });
});

describe('describeGatekeeperConfig', () => {
  it('says what is off rather than printing nothing', () => {
    expect(describeGatekeeperConfig({})).toEqual({
      door: 'off (execute_step keeps its semaphore of two)',
      queueLength: 'none',
      retainedSessions: 'unbounded',
    });
  });

  it('prints the values in force', () => {
    expect(
      describeGatekeeperConfig({ maxLiveSessions: 4, queueLength: 4, maxRetainedSessions: 40 }),
    ).toEqual({ door: 4, queueLength: 4, retainedSessions: 40 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/gatekeeper-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

Create `srv/lib/gatekeeper-config.ts`:

```ts
/**
 * The gatekeeper's configuration: read from the environment, validated, and
 * holding nothing that changes at runtime.
 *
 * Absent means off. Malformed means refuse to start, naming the variable:
 * somebody intending a limit and not getting one is the failure this design
 * exists to make visible. The precedent is `LLM_AGENT_THROTTLE_MAX_WAIT_MS`.
 */

const LIVE = 'LLM_GATEKEEPER_MAX_LIVE_SESSIONS';
const QUEUE = 'LLM_GATEKEEPER_QUEUE_LENGTH';
const RETAINED = 'LLM_GATEKEEPER_MAX_RETAINED_SESSIONS';

export interface GatekeeperConfig {
  /** Sessions that may be live at once, across every channel. Absent: no door. */
  maxLiveSessions?: number;
  /** Callers that may wait to be admitted. The capacity when a capacity is set. */
  queueLength?: number;
  /** Sessions that may hold state. Absent: unbounded. */
  maxRetainedSessions?: number;
}

function readPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `Invalid ${name}: expected a positive whole number, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export function loadGatekeeperConfig(): GatekeeperConfig {
  const maxLiveSessions = readPositiveInt(LIVE);
  const queue = readPositiveInt(QUEUE);
  const maxRetainedSessions = readPositiveInt(RETAINED);

  if (queue !== undefined && maxLiveSessions === undefined) {
    // A queue waits for a slot. With no door there is no slot and nothing to
    // wait for, so the setting would do nothing while looking like a limit.
    throw new Error(
      `Invalid ${QUEUE}: a queue needs a door in front of it. Set ${LIVE} as well, or unset ${QUEUE}.`,
    );
  }

  if (maxRetainedSessions !== undefined) {
    if (maxLiveSessions === undefined) {
      // With chat concurrency unbounded, any number of sessions can be live at
      // once and none of them may be evicted, so the cap would be exceeded by
      // sessions the design forbids touching.
      throw new Error(
        `Invalid ${RETAINED}: retention cannot be bounded without bounding how many sessions run. Set ${LIVE} as well, or unset ${RETAINED}.`,
      );
    }
    if (maxRetainedSessions < maxLiveSessions) {
      // Five slots and room for two histories has no correct behaviour: the
      // third admitted session would need a place while none is idle.
      throw new Error(
        `Invalid ${RETAINED}: ${maxRetainedSessions} is smaller than ${LIVE}=${maxLiveSessions}. You cannot retain fewer sessions than you can run at once.`,
      );
    }
  }

  return {
    maxLiveSessions,
    queueLength: maxLiveSessions === undefined ? undefined : (queue ?? maxLiveSessions),
    maxRetainedSessions,
  };
}

let cached: GatekeeperConfig | undefined;

export function gatekeeperConfig(): GatekeeperConfig {
  if (!cached) cached = loadGatekeeperConfig();
  return cached;
}

/** For the startup log. A limit only shows itself under load, and by then nobody remembers what was set. */
export function describeGatekeeperConfig(
  cfg: GatekeeperConfig = gatekeeperConfig(),
): Record<string, number | string> {
  return {
    door: cfg.maxLiveSessions ?? 'off (execute_step keeps its semaphore of two)',
    queueLength: cfg.queueLength ?? 'none',
    retainedSessions: cfg.maxRetainedSessions ?? 'unbounded',
  };
}

/** Test seam. */
export function clearGatekeeperConfig(): void {
  cached = undefined;
}
```

- [ ] **Step 4: Validate at load and log the values in force**

In `srv/agent-config.ts`, add `import { describeGatekeeperConfig, gatekeeperConfig } from './lib/gatekeeper-config';`. In `loadAgentConfig`, as the first statement after `const log = cds.log('agent-config');`:

```ts
  // Validated here because this runs at startup. A malformed limit must stop
  // the service before it takes traffic, not on the first request that meets it.
  const gatekeeper = gatekeeperConfig();
```

and add to the `log.info('Agent configuration loaded', { ... })` object:

```ts
    gatekeeper: describeGatekeeperConfig(gatekeeper),
```

- [ ] **Step 5: Run, lint, commit**

```bash
npx jest test/unit/gatekeeper-config.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/gatekeeper-config.ts srv/agent-config.ts test/unit/gatekeeper-config.test.ts
git add srv/lib/gatekeeper-config.ts srv/agent-config.ts test/unit/gatekeeper-config.test.ts
git commit -m "feat(gatekeeper): three variables, absent means off, malformed refuses to start"
```

---

### Task 5: Retention — places, leases, and closing before deleting

**Files:**
- Create: `srv/lib/session-retention.ts`
- Test: `test/unit/session-retention.test.ts`

**Interfaces:**
- Consumes: nothing. Stores are injected, so this unit knows no module of the service.
- Produces:
  - `export interface RetentionStores { hasState(userId: string, sessionId: string): boolean; deleteAll(userId: string, sessionId: string): void }`
  - `export type LeaseKind = 'pipeline' | 'rag'`
  - `export interface Lease { readonly kind: LeaseKind; readonly signal: AbortSignal; release(): void }`
  - `export type LeaseRefusal = { refused: 'closing' | 'retention' }`
  - `export function isRefusal(x: Lease | LeaseRefusal): x is LeaseRefusal`
  - `export class SessionRetention`:
    - `constructor(stores: RetentionStores, cap?: number, now?: () => number)`
    - `canReserve(userId: string, sessionId: string): boolean`
    - `lease(userId: string, sessionId: string, kind: LeaseKind): Lease | LeaseRefusal`
    - `close(userId: string, sessionId: string): Promise<void>`
    - `isKnown(userId: string, sessionId: string): boolean`
    - `isClosing(userId: string, sessionId: string): boolean`
    - `maySweep(userId: string, sessionId: string): boolean`
    - `forgetEmpty(): number`
    - `snapshot(): RetentionSnapshot` where `RetentionSnapshot = { retained: number; cap: number | undefined; evictions: number; closing: number }`

**What a lease is for.** Idle means nothing is working on the session, and a slot does not say that: `/v1/rag/*` takes no slot, so a session in the middle of an upload looks idle to an LRU that asks only about slots — and the upload makes its own eviction likelier, because other sessions are touched while it runs. So eviction and the sweep test for a lease, which every operation on session-scoped state takes. A pipeline takes one kind, a RAG request the other.

**What the mark is for.** Deleting a directory does not stop the operation writing into it. So every deletion closes the session to new leases first, cancels only RAG leases (their writes land only in the state being removed), waits for every lease to settle — a pipeline runs to its own end, because its writes land in SAP — and removes the session once. The caller is answered at the mark; the bytes go when the last operation stops.

**Why eviction is synchronous.** `lease` may have to evict to make room, and the door calls it inside the same turn of the event loop in which it decided the waiter was eligible. An evicted session has no lease by construction, so its wait is empty, and `deleteAll` is synchronous: nothing can take a lease between the choice and the deletion.

**Why a released session with nothing in it leaves the count.** `execute_step` mints a session per call and keeps no history. Without this, every step would occupy a place until the next sweep.

- [ ] **Step 1: Write the failing test**

Create `test/unit/session-retention.test.ts`:

```ts
import {
  isRefusal,
  type Lease,
  type LeaseRefusal,
  SessionRetention,
} from '../../srv/lib/session-retention';

function fakeStores() {
  const held = new Set<string>();
  const log: string[] = [];
  return {
    held,
    log,
    put: (u: string, s: string) => held.add(`${u}/${s}`),
    stores: {
      hasState: (u: string, s: string) => held.has(`${u}/${s}`),
      deleteAll: (u: string, s: string) => {
        log.push(`delete ${u}/${s}`);
        held.delete(`${u}/${s}`);
      },
    },
  };
}

function lease(x: Lease | LeaseRefusal): Lease {
  if (isRefusal(x)) throw new Error(`refused: ${x.refused}`);
  return x;
}

function clock() {
  let t = 0;
  return { now: () => t, tick: (ms = 1) => (t += ms) };
}

describe('places', () => {
  it('keeps two users apart when their parts could be read two ways', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 5);
    lease(r.lease('a', 'b c', 'pipeline'));
    expect(r.isKnown('a b', 'c')).toBe(false);
    expect(r.lease('a b', 'c', 'pipeline')).not.toEqual({ refused: 'closing' });
    expect(r.snapshot().retained).toBe(2);
  });

  it('counts a session once however many leases it holds', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 3);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'pipeline'));
    lease(r.lease('alice', 'A', 'rag'));
    expect(r.snapshot().retained).toBe(1);
  });

  it('evicts the least recently used idle session to make room, all of it', () => {
    const f = fakeStores();
    const c = clock();
    const r = new SessionRetention(f.stores, 2, c.now);
    for (const s of ['A', 'B']) {
      f.put('alice', s);
      lease(r.lease('alice', s, 'rag')).release();
      c.tick();
    }
    // A is older. C needs a place.
    const l = lease(r.lease('alice', 'C', 'rag'));
    expect(f.log).toEqual(['delete alice/A']);
    expect(r.isKnown('alice', 'A')).toBe(false);
    expect(r.snapshot()).toMatchObject({ retained: 2, evictions: 1 });
    l.release();
  });

  it('never evicts a session holding a pipeline lease', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 1);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'pipeline'));
    expect(r.canReserve('bob', 'B')).toBe(false);
    expect(r.lease('bob', 'B', 'pipeline')).toEqual({ refused: 'retention' });
    expect(f.log).toEqual([]);
  });

  it('never evicts a session in the middle of a RAG operation, slot or no slot', () => {
    // The test the slot-only rule passed while being wrong: the upload holds no
    // slot, and it is the least recently used.
    const f = fakeStores();
    const c = clock();
    const r = new SessionRetention(f.stores, 2, c.now);
    f.put('alice', 'A');
    const upload = lease(r.lease('alice', 'A', 'rag'));
    c.tick();
    f.put('alice', 'B');
    lease(r.lease('alice', 'B', 'rag')).release();
    c.tick();
    // B is the only idle candidate, so B goes and A survives.
    lease(r.lease('alice', 'C', 'rag'));
    expect(f.log).toEqual(['delete alice/B']);
    expect(r.isKnown('alice', 'A')).toBe(true);
    upload.release();
  });

  it('a cap filled entirely by live sessions evicts nothing', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    lease(r.lease('alice', 'A', 'pipeline'));
    lease(r.lease('bob', 'B', 'pipeline'));
    expect(r.lease('carol', 'C', 'pipeline')).toEqual({ refused: 'retention' });
    expect(f.log).toEqual([]);
  });

  it('is unbounded without a cap', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores);
    for (let i = 0; i < 50; i++) lease(r.lease('alice', `S${i}`, 'pipeline'));
    expect(r.snapshot().retained).toBe(50);
    expect(r.snapshot().cap).toBeUndefined();
  });

  it('lets a released session that holds nothing leave the count', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    lease(r.lease('agent', 'step-1', 'pipeline')).release();
    expect(r.snapshot().retained).toBe(0);
  });

  it('keeps a released session that still holds state', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'pipeline')).release();
    expect(r.isKnown('alice', 'A')).toBe(true);
  });
});

describe('closing, then deleting', () => {
  it('deletes at once when nothing holds the session', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'rag')).release();
    await r.close('alice', 'A');
    expect(f.log).toEqual(['delete alice/A']);
    expect(r.isKnown('alice', 'A')).toBe(false);
  });

  it('refuses new leases from the moment it is closed', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    const held = lease(r.lease('alice', 'A', 'pipeline'));
    void r.close('alice', 'A');
    expect(r.lease('alice', 'A', 'rag')).toEqual({ refused: 'closing' });
    expect(r.isClosing('alice', 'A')).toBe(true);
    held.release();
  });

  it('cancels a RAG lease, and still waits for it to settle before deleting', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    const upload = lease(r.lease('alice', 'A', 'rag'));
    const closed = r.close('alice', 'A');
    expect(upload.signal.aborted).toBe(true);
    // Cancelled is not finished: the upload is still writing.
    expect(f.log).toEqual([]);
    f.log.push('upload wrote its last document');
    upload.release();
    await closed;
    expect(f.log).toEqual(['upload wrote its last document', 'delete alice/A']);
  });

  it('does not cancel a pipeline, and deletes only after it ends', async () => {
    // A logout is a disconnect with a better name. Cutting an admitted pipeline
    // between create and activate leaves an ABAP object inactive and locked.
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    const pipeline = lease(r.lease('alice', 'A', 'pipeline'));
    let settled = false;
    const closed = r.close('alice', 'A').then(() => {
      settled = true;
    });
    expect(pipeline.signal.aborted).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.log).toEqual([]);
    pipeline.release();
    await closed;
    expect(f.log).toEqual(['delete alice/A']);
  });

  it('deletes once however many times it is closed', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    const held = lease(r.lease('alice', 'A', 'rag'));
    const first = r.close('alice', 'A');
    const second = r.close('alice', 'A');
    held.release();
    await Promise.all([first, second]);
    expect(f.log).toEqual(['delete alice/A']);
  });

  it('removes state for a session retention never saw', async () => {
    // After a restart, or with no lease ever taken: the stores may still hold
    // it, and a logout must still take it away.
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    await r.close('alice', 'A');
    expect(f.log).toEqual(['delete alice/A']);
  });

  it('is not a tombstone: the entry is gone once removal has run', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    lease(r.lease('alice', 'A', 'rag')).release();
    await r.close('alice', 'A');
    expect(r.isClosing('alice', 'A')).toBe(false);
    expect(r.snapshot().closing).toBe(0);
  });

  it('counts a closed session whose cleanup is still waiting', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    const held = lease(r.lease('alice', 'A', 'pipeline'));
    void r.close('alice', 'A');
    // Its bytes are still there, so it still takes a place.
    expect(r.snapshot()).toMatchObject({ retained: 1, closing: 1 });
    held.release();
  });

  it('a lease releasing twice settles once', async () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    f.put('alice', 'A');
    const a = lease(r.lease('alice', 'A', 'rag'));
    const b = lease(r.lease('alice', 'A', 'rag'));
    const closed = r.close('alice', 'A');
    a.release();
    a.release();
    expect(f.log).toEqual([]);
    b.release();
    await closed;
    expect(f.log).toEqual(['delete alice/A']);
  });
});

describe('the sweep asks first', () => {
  it('may not sweep a leased or closing session, and may once it settles', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 2);
    const held = lease(r.lease('alice', 'A', 'rag'));
    expect(r.maySweep('alice', 'A')).toBe(false);
    held.release();
    expect(r.maySweep('alice', 'A')).toBe(true);
    expect(r.maySweep('nobody', 'N')).toBe(true);
  });

  it('forgets entries that hold nothing and have no lease', () => {
    const f = fakeStores();
    const r = new SessionRetention(f.stores, 3);
    f.put('alice', 'A');
    lease(r.lease('alice', 'A', 'rag')).release();
    const held = lease(r.lease('bob', 'B', 'rag'));
    // A's history expired on its own thirty-minute clock.
    f.held.delete('alice/A');
    expect(r.forgetEmpty()).toBe(1);
    expect(r.isKnown('alice', 'A')).toBe(false);
    expect(r.isKnown('bob', 'B')).toBe(true);
    held.release();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/session-retention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the unit**

Create `srv/lib/session-retention.ts`:

```ts
/**
 * Retention: how many sessions may hold state, and the rules for letting one go.
 *
 * Pure. The stores are injected, there is no timer, and the clock is a
 * parameter, so every rule here is tested without the service around it.
 */

export interface RetentionStores {
  /** Whether anything is still held for this session. */
  hasState(userId: string, sessionId: string): boolean;
  /** Remove everything held for this session. Must be synchronous. */
  deleteAll(userId: string, sessionId: string): void;
}

/**
 * `pipeline` — an admitted session's run. Never cancelled: its writes land in
 * SAP, which a deletion here does not remove.
 *
 * `rag` — a RAG operation. Cancelled by a deletion: its writes land only in the
 * state being removed.
 */
export type LeaseKind = 'pipeline' | 'rag';

export interface Lease {
  readonly kind: LeaseKind;
  /** Aborted when a deletion cancels this lease. Never aborted for a pipeline. */
  readonly signal: AbortSignal;
  /** Settle the lease. Idempotent. */
  release(): void;
}

export type LeaseRefusal = { refused: 'closing' | 'retention' };

export function isRefusal(x: Lease | LeaseRefusal): x is LeaseRefusal {
  return 'refused' in x;
}

export interface RetentionSnapshot {
  retained: number;
  cap: number | undefined;
  evictions: number;
  /** Closed to new leases, cleanup not yet run. Normally zero for longer than an upload. */
  closing: number;
}

interface Entry {
  userId: string;
  sessionId: string;
  lastUsed: number;
  leases: Set<Lease>;
  closing?: { settled: Promise<void>; resolve: () => void };
}

function keyOf(userId: string, sessionId: string): string {
  // A tuple, not a join: no separator keeps ("a", "b c") and ("a b", "c") apart
  // whatever a caller puts in a cookie.
  return JSON.stringify([userId, sessionId]);
}

export class SessionRetention {
  private readonly entries = new Map<string, Entry>();
  private evictions = 0;

  constructor(
    private readonly stores: RetentionStores,
    private readonly cap?: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a place could be had for this session now, without taking it. */
  canReserve(userId: string, sessionId: string): boolean {
    const e = this.entries.get(keyOf(userId, sessionId));
    if (e) return !e.closing;
    if (this.cap === undefined || this.entries.size < this.cap) return true;
    return this.evictionCandidate() !== undefined;
  }

  /**
   * A place and a lease on it, together.
   *
   * Evicts the least recently used idle session when the cap is full. Refuses
   * when the session is closing, or when every place is held by something
   * working.
   */
  lease(userId: string, sessionId: string, kind: LeaseKind): Lease | LeaseRefusal {
    const key = keyOf(userId, sessionId);
    let e = this.entries.get(key);
    if (e?.closing) return { refused: 'closing' };
    if (!e) {
      if (this.cap !== undefined && this.entries.size >= this.cap) {
        const victim = this.evictionCandidate();
        if (!victim) return { refused: 'retention' };
        this.evict(victim);
      }
      e = { userId, sessionId, lastUsed: this.now(), leases: new Set() };
      this.entries.set(key, e);
    }
    e.lastUsed = this.now();

    const controller = new AbortController();
    const entry = e;
    let released = false;
    const lease: Lease & { cancel(): void } = {
      kind,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.settle(entry, lease);
      },
      cancel: () => {
        if (kind === 'rag') controller.abort(new Error('session closed'));
      },
    };
    e.leases.add(lease);
    return lease;
  }

  /**
   * Delete a session: close it to new leases now, cancel its RAG leases, wait
   * for every lease to settle, then remove it once.
   *
   * Resolves when the removal has run. A caller answering a user does not wait
   * for it — the user is answered at the mark.
   */
  close(userId: string, sessionId: string): Promise<void> {
    const e = this.entries.get(keyOf(userId, sessionId));
    if (!e) {
      this.stores.deleteAll(userId, sessionId);
      return Promise.resolve();
    }
    if (e.closing) return e.closing.settled;
    let resolve!: () => void;
    const settled = new Promise<void>((r) => {
      resolve = r;
    });
    e.closing = { settled, resolve };
    for (const l of e.leases) (l as Lease & { cancel(): void }).cancel();
    if (e.leases.size === 0) this.finishClose(e);
    return settled;
  }

  /** Known, and not closing. */
  isKnown(userId: string, sessionId: string): boolean {
    const e = this.entries.get(keyOf(userId, sessionId));
    return !!e && !e.closing;
  }

  isClosing(userId: string, sessionId: string): boolean {
    return !!this.entries.get(keyOf(userId, sessionId))?.closing;
  }

  /**
   * Whether the TTL sweep may remove this session's expired collections.
   *
   * The sweep asks and removes in the same synchronous pass, so no lease can be
   * taken between the answer and the removal — which is what the closing mark
   * guarantees on every other path.
   */
  maySweep(userId: string, sessionId: string): boolean {
    const e = this.entries.get(keyOf(userId, sessionId));
    return !e || (e.leases.size === 0 && !e.closing);
  }

  /** Drop entries with no lease and nothing held. Returns how many went. */
  forgetEmpty(): number {
    let n = 0;
    for (const [key, e] of [...this.entries]) {
      if (e.leases.size === 0 && !e.closing && !this.stores.hasState(e.userId, e.sessionId)) {
        this.entries.delete(key);
        n++;
      }
    }
    return n;
  }

  snapshot(): RetentionSnapshot {
    let closing = 0;
    for (const e of this.entries.values()) if (e.closing) closing++;
    return { retained: this.entries.size, cap: this.cap, evictions: this.evictions, closing };
  }

  private evictionCandidate(): Entry | undefined {
    let oldest: Entry | undefined;
    for (const e of this.entries.values()) {
      if (e.leases.size > 0 || e.closing) continue;
      if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
    }
    return oldest;
  }

  /** An idle session has no lease, so closing it removes it in this same turn. */
  private evict(e: Entry): void {
    this.evictions++;
    void this.close(e.userId, e.sessionId);
  }

  private settle(e: Entry, lease: Lease): void {
    e.leases.delete(lease);
    e.lastUsed = this.now();
    if (e.leases.size > 0) return;
    if (e.closing) {
      this.finishClose(e);
      return;
    }
    if (!this.stores.hasState(e.userId, e.sessionId)) {
      this.entries.delete(keyOf(e.userId, e.sessionId));
    }
  }

  private finishClose(e: Entry): void {
    try {
      this.stores.deleteAll(e.userId, e.sessionId);
    } finally {
      this.entries.delete(keyOf(e.userId, e.sessionId));
      e.closing?.resolve();
    }
  }
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
npx jest test/unit/session-retention.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/session-retention.ts test/unit/session-retention.test.ts
git add srv/lib/session-retention.ts test/unit/session-retention.test.ts
git commit -m "feat(gatekeeper): retention — places, leases, and closing a session before deleting it"
```

---

### Task 6: Retention in the service

**Files:**
- Create: `srv/lib/gatekeeper.ts`
- Create: `test/unit/helpers/rag-routes.ts`
- Modify: `srv/lib/throttle-surfacing.ts` (the three refusal sentences)
- Modify: `srv/rag-collections.ts` (`sweepExpiredSessions` asks first; `addDocumentsBulk` honours a signal)
- Modify: `srv/rag-handler.ts` (leases around every session-scoped operation; the two refusals)
- Modify: `srv/server.ts` (the middleware asks about liveness; `DELETE /v1/session` answers at the mark; the sweeps)
- Test: `test/unit/retention-wiring.test.ts`

**Interfaces:**
- Consumes: `SessionRetention`, `Lease`, `LeaseRefusal`, `LeaseKind`, `isRefusal` (Task 5); `gatekeeperConfig` (Task 4); `deleteSessionState`, `hasSessionState` (Task 3); `sessionMiddleware`, `sessionIdOf` (Task 1).
- Produces:
  - in `srv/lib/gatekeeper.ts`:
    - `export function theRetention(): SessionRetention`
    - `export function sessionIsLive(userId: string, sessionId: string): boolean`
    - `export function leaseSession(userId: string, sessionId: string, kind: LeaseKind): Lease | LeaseRefusal`
    - `export function deleteSession(userId: string, sessionId: string): Promise<void>`
    - `export function maySweepSession(userId: string, sessionId: string): boolean`
    - `export function forgetEmptySessions(): number`
    - `export function resetGatekeeperForTest(): void`
  - in `srv/lib/throttle-surfacing.ts`:
    - `export type DoorRefusalReason = 'session_busy' | 'capacity' | 'retention'`
    - `export function doorRefusalSentence(reason: DoorRefusalReason): string`
    - `export function sessionClosedText(): string`
  - `sweepExpiredSessions(maySweep?: (userId: string, sessionId: string) => boolean): void`
  - `addDocumentsBulk(..., options?: { sleep?; budgetMs?; signal?: AbortSignal })`

**Which routes lease.** Everything that reads or writes a session collection asynchronously: document add, bulk add, update, delete, file upload, query, and collection delete — through the `/rag/collections/:id` routes, when the resolved collection is session-scoped. Creating a session collection leases the caller's session, which is where a place is reserved. `POST /rag/tool/:name` leases the caller's session, because `rag_add` may create a session collection. `GET /rag/collections` reads registry metadata synchronously and cannot race anything.

**Which leases cancel.** Bulk add and file upload stop between documents when their lease is cancelled; the document already sent is not taken back, and the session's removal follows it. A single add, an update, a delete and a query are one backend call each and are waited for.

- [ ] **Step 1: Extract the route-test helpers**

Create `test/unit/helpers/rag-routes.ts` — the same mock router and request/response doubles `rag-handler.test.ts` defines inline, so a new test does not copy them a third time. The existing test files are left as they are.

```ts
import type { Request, Response, Router } from 'express';

export interface RouteHandler {
  method: string;
  path: string;
  handler: (req: Request, res: Response, next?: () => void) => void | Promise<void>;
}

export function makeMockRouter(): { router: Router; routes: RouteHandler[] } {
  const routes: RouteHandler[] = [];
  const add = (method: string) => (path: string, handler: RouteHandler['handler']) => {
    routes.push({ method, path, handler });
  };
  const router = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    use: add('USE'),
  } as unknown as Router;
  return { router, routes };
}

export function findRoute(routes: RouteHandler[], method: string, path: string) {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`${method} ${path} not registered`);
  return r;
}

export function makeReq(o: {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  sessionId?: string;
}): Request {
  return {
    body: o.body ?? {},
    params: o.params ?? {},
    query: {},
    headers: o.headers ?? {},
    method: o.method ?? 'GET',
    path: o.path ?? '/',
    sessionId: o.sessionId,
  } as unknown as Request;
}

export interface MockRes {
  _status: number;
  _body: unknown;
  res: Response;
}

export function makeRes(): MockRes {
  const r = { _status: 200, _body: undefined as unknown } as MockRes;
  const res = {
    status(code: number) {
      r._status = code;
      return res;
    },
    json(data: unknown) {
      r._body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  r.res = res as unknown as Response;
  return r;
}

/** Run the `/rag/collections/:id` guard, then the route, as Express would. */
export async function runIdRoute(
  routes: RouteHandler[],
  method: string,
  path: string,
  req: Request,
): Promise<MockRes> {
  const res = makeRes();
  let passed = false;
  await findRoute(routes, 'USE', '/rag/collections/:id').handler(req, res.res, () => {
    passed = true;
  });
  if (!passed) return res;
  await findRoute(routes, method, path).handler(req, res.res);
  return res;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/retention-wiring.test.ts`:

```ts
const mockCdsContext: { user?: { id: string; is: (role: string) => boolean } } = {};
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return mockCdsContext;
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
  getRequestHistory: () => [],
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryRag } from '@mcp-abap-adt/llm-agent';
import { sessionCollectionId } from '../../srv/collection-ids';
import {
  clearGatekeeperConfig,
} from '../../srv/lib/gatekeeper-config';
import type { Request, Response } from 'express';
import { isRefusal, type Lease } from '../../srv/lib/session-retention';
import {
  findRoute,
  makeMockRouter,
  makeReq,
  makeRes,
  runIdRoute,
} from './helpers/rag-routes';

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-wiring-'));
process.env.RAG_STORAGE_PATH = storage;

// Loaded after the environment is set: the registry reads its storage path
// once, on first use.
const manager = require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
const gatekeeper = require('../../srv/lib/gatekeeper') as typeof import('../../srv/lib/gatekeeper');
const { registerRagRoutes } = require('../../srv/rag-handler') as typeof import('../../srv/rag-handler');
const { sessionMiddleware } = require('../../srv/lib/session-middleware') as typeof import('../../srv/lib/session-middleware');

/** A backend whose calls wait until the test lets them go. */
function gatedBackend() {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  class GatedRag extends InMemoryRag {
    async upsert(...args: Parameters<InMemoryRag['upsert']>) {
      await gate;
      return super.upsert(...args);
    }
    async query(...args: Parameters<InMemoryRag['query']>) {
      await gate;
      return super.query(...args);
    }
    async deleteById(...args: Parameters<InMemoryRag['deleteById']>) {
      await gate;
      return super.deleteById(...args);
    }
  }
  return { open, factory: () => new GatedRag() };
}

const registry = manager.getCollectionRegistry();
const { router, routes } = makeMockRouter();
registerRagRoutes(router, registry);

function as(user: string) {
  mockCdsContext.user = { id: user, is: () => false };
}

function configure(live: number, retained: number) {
  process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = String(retained);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

async function createSessionCollection(user: string, sid: string, backend?: string) {
  as(user);
  const res = makeRes();
  await findRoute(routes, 'POST', '/rag/collections').handler(
    makeReq({
      method: 'POST',
      body: { id: 'notes', displayName: 'Notes', scope: 'session', backend },
      headers: { cookie: `clh_session=${sid}` },
      sessionId: sid,
    }),
    res.res,
  );
  return res;
}

function dirOf(user: string, sid: string) {
  return path.join(storage, sessionCollectionId('notes', user, sid));
}

beforeEach(() => configure(1, 1));

afterEach(async () => {
  for (const [u, s] of [
    ['alice', 'A'],
    ['bob', 'B'],
  ]) {
    await gatekeeper.deleteSession(u, s);
  }
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  delete process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS;
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
});

afterAll(() => fs.rmSync(storage, { recursive: true, force: true }));

describe('the retention cap on the RAG routes', () => {
  it('a RAG route cannot exceed the cap', async () => {
    // Alice's session is running a pipeline. There is one place, and it is hers.
    const running = gatekeeper.leaseSession('alice', 'A', 'pipeline') as Lease;
    const res = await createSessionCollection('bob', 'B');
    expect(res._status).toBe(503);
    expect(res._body).toEqual({
      error: {
        message: 'The service has no room to hold another session right now. Please try again shortly.',
        code: 'gatekeeper_retention',
      },
    });
    expect(registry.getCollection(sessionCollectionId('notes', 'bob', 'B'))).toBeNull();
    running.release();
  });

  it('evicts an idle session for a new one — all of it, directory included', async () => {
    expect((await createSessionCollection('alice', 'A'))._status).toBe(201);
    await registry.addDocument(sessionCollectionId('notes', 'alice', 'A'), {
      id: 'd1',
      text: 'hello',
      metadata: {},
    });
    expect(fs.existsSync(dirOf('alice', 'A'))).toBe(true);

    expect((await createSessionCollection('bob', 'B'))._status).toBe(201);

    expect(registry.getCollection(sessionCollectionId('notes', 'alice', 'A'))).toBeNull();
    expect(fs.existsSync(dirOf('alice', 'A'))).toBe(false);
  });
});

/** Three operations that each hold a session-scoped lease while their backend call is out. */
const OPERATIONS: Array<{
  name: string;
  start: (physId: string) => Promise<ReturnType<typeof makeRes>>;
}> = [
  {
    name: 'a bulk upload',
    start: (physId) =>
      runIdRoute(
        routes,
        'POST',
        '/rag/collections/:id/documents/bulk',
        makeReq({
          method: 'POST',
          path: '/documents/bulk',
          params: { id: physId },
          body: {
            documents: [
              { id: 'd1', text: 'one' },
              { id: 'd2', text: 'two' },
              { id: 'd3', text: 'three' },
            ],
          },
          headers: { cookie: 'clh_session=A' },
          sessionId: 'A',
        }),
      ),
  },
  {
    name: 'a query',
    start: (physId) =>
      runIdRoute(
        routes,
        'POST',
        '/rag/collections/:id/query',
        makeReq({
          method: 'POST',
          path: '/query',
          params: { id: physId },
          body: { text: 'hello' },
          headers: { cookie: 'clh_session=A' },
          sessionId: 'A',
        }),
      ),
  },
  {
    name: 'a document delete',
    start: (physId) =>
      runIdRoute(
        routes,
        'DELETE',
        '/rag/collections/:id/documents/:did',
        makeReq({
          method: 'DELETE',
          path: '/documents/d0',
          params: { id: physId, did: 'd0' },
          headers: { cookie: 'clh_session=A' },
          sessionId: 'A',
        }),
      ),
  },
];

describe.each(OPERATIONS)('while $name is in flight', ({ start }) => {
  async function inFlight() {
    configure(2, 2);
    const backend = gatedBackend();
    registry.registerBackend('gated', backend.factory);
    expect((await createSessionCollection('alice', 'A', 'gated'))._status).toBe(201);
    const physId = sessionCollectionId('notes', 'alice', 'A');
    // A document to delete, written before the gate matters.
    backend.open();
    await registry.addDocument(physId, { id: 'd0', text: 'zero', metadata: {} });
    // A fresh gate for the operation under test.
    const held = gatedBackend();
    registry.registerBackend('gated', held.factory);
    (registry as unknown as {
      collections: Map<string, { rag: unknown }>;
    }).collections.get(physId)!.rag = held.factory();
    as('alice');
    const running = start(physId);
    await new Promise((r) => setImmediate(r));
    return { physId, running, open: held.open };
  }

  it('is not evicted, slot or no slot', async () => {
    const { physId, running, open } = await inFlight();
    // Bob takes the second place; carol would need Alice's, which is in use.
    expect((await createSessionCollection('bob', 'B'))._status).toBe(201);
    const refused = await createSessionCollection('carol', 'C');
    expect(refused._status).toBe(503);
    open();
    await running;
    expect(registry.getCollection(physId)).not.toBeNull();
    expect(fs.existsSync(dirOf('alice', 'A'))).toBe(true);
    await gatekeeper.deleteSession('carol', 'C');
  });

  it('logout answers at once, refuses new work, and removes everything after it settles', async () => {
    const { physId, running, open } = await inFlight();

    let removed = false;
    const removal = gatekeeper.deleteSession('alice', 'A').then(() => {
      removed = true;
    });
    await Promise.resolve();
    expect(removed).toBe(false);

    // Closed to new leases from the mark.
    const late = await runIdRoute(
      routes,
      'POST',
      '/rag/collections/:id/query',
      makeReq({
        method: 'POST',
        path: '/query',
        params: { id: physId },
        body: { text: 'late' },
        headers: { cookie: 'clh_session=A' },
        sessionId: 'A',
      }),
    );
    expect(late._status).toBe(410);
    expect((late._body as { error: { code: string } }).error.code).toBe('session_closed');

    open();
    await running;
    await removal;

    // The assertion that matters is made after the operation has finished: a
    // cleanup racing it passes every check made before.
    expect(registry.getCollection(physId)).toBeNull();
    expect(fs.existsSync(dirOf('alice', 'A'))).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(dirOf('alice', 'A'))).toBe(false);
  });
});

describe('the TTL sweep', () => {
  it('skips a leased session and takes it on the next pass, directory included', async () => {
    configure(2, 2);
    expect((await createSessionCollection('alice', 'A'))._status).toBe(201);
    const physId = sessionCollectionId('notes', 'alice', 'A');
    await registry.addDocument(physId, { id: 'd1', text: 'hello', metadata: {} });
    (registry as unknown as {
      collections: Map<string, { meta: { expiresAt?: number } }>;
    }).collections.get(physId)!.meta.expiresAt = Date.now() - 1;

    const held = gatekeeper.leaseSession('alice', 'A', 'rag');
    expect(isRefusal(held)).toBe(false);
    registry.sweepExpiredSessions(gatekeeper.maySweepSession);
    expect(registry.getCollection(physId)).not.toBeNull();

    (held as Lease).release();
    registry.sweepExpiredSessions(gatekeeper.maySweepSession);
    expect(registry.getCollection(physId)).toBeNull();
    expect(fs.existsSync(dirOf('alice', 'A'))).toBe(false);
  });
});

describe('a retired cookie', () => {
  it('gets a new session, and none of the old state is visible through it', async () => {
    configure(2, 2);
    expect((await createSessionCollection('alice', 'A'))._status).toBe(201);
    await gatekeeper.deleteSession('alice', 'A');

    as('alice');
    const req = { headers: { cookie: 'clh_session=A' }, secure: false } as unknown as Request & {
      sessionId?: string;
    };
    const set: Record<string, string> = {};
    sessionMiddleware({ isLive: gatekeeper.sessionIsLive, userIdOf: () => 'alice' })(
      req,
      { setHeader: (k: string, v: string) => (set[k] = v) } as unknown as Response,
      () => {},
    );
    expect(req.sessionId).not.toBe('A');
    expect(set['Set-Cookie']).toContain(`clh_session=${req.sessionId}`);

    const list = makeRes();
    findRoute(routes, 'GET', '/rag/collections').handler(
      makeReq({ method: 'GET', headers: { cookie: `clh_session=${req.sessionId}` }, sessionId: req.sessionId }),
      list.res,
    );
    const ids = (list._body as { collections: Array<{ id: string }> }).collections.map((c) => c.id);
    expect(ids).not.toContain(sessionCollectionId('notes', 'alice', 'A'));
  });
});

describe('logout and clear-chat in server.ts', () => {
  it('answer at the mark and do not wait for the removal', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../srv/server.ts'), 'utf8');
    expect(src).toMatch(/void\s+deleteSession\(\s*userId\s*,\s*sessionId\s*\)/);
    expect(src).toMatch(/sweepExpiredSessions\(\s*maySweepSession\s*\)/);
    expect(src).toMatch(/isLive:\s*sessionIsLive/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest test/unit/retention-wiring.test.ts`
Expected: FAIL — `srv/lib/gatekeeper` is not found.

- [ ] **Step 4: The refusal sentences**

In `srv/lib/throttle-surfacing.ts`, append:

```ts
/** Why admission was withheld, in the order admission checks. */
export type DoorRefusalReason = 'session_busy' | 'capacity' | 'retention';

const DOOR_SENTENCES: Record<DoorRefusalReason, string> = {
  session_busy:
    'This session is still working on an earlier request. Wait for it to finish before sending another.',
  capacity: 'The service is at capacity right now. Please try again shortly.',
  retention:
    'The service has no room to hold another session right now. Please try again shortly.',
};

/**
 * The sentence for the person. No number: how long the sessions ahead will run
 * or be held is not something we measure, and inventing one is the guess this
 * design refuses everywhere.
 */
export function doorRefusalSentence(reason: DoorRefusalReason): string {
  return DOOR_SENTENCES[reason];
}

/** A request against a session already closed for deletion. */
export function sessionClosedText(): string {
  return 'This session is being deleted. Send the request again to start a new one.';
}
```

- [ ] **Step 5: The process-wide retention**

Create `srv/lib/gatekeeper.ts`:

```ts
/**
 * The gatekeeper as the service sees it: one door and one retention per process,
 * built from the configuration and the real stores.
 *
 * The only module the channels, the RAG routes, the server and the health
 * function call. Everything with rules in it lives in the pure units beside it.
 */

import { gatekeeperConfig } from './gatekeeper-config';
import {
  type Lease,
  type LeaseKind,
  type LeaseRefusal,
  SessionRetention,
} from './session-retention';
import { deleteSessionState, hasSessionState } from './session-state';

let retention: SessionRetention | undefined;

export function theRetention(): SessionRetention {
  if (!retention) {
    retention = new SessionRetention(
      { hasState: hasSessionState, deleteAll: deleteSessionState },
      gatekeeperConfig().maxRetainedSessions,
    );
  }
  return retention;
}

/**
 * Whether a presented cookie still names a session.
 *
 * Closing means no, from the mark: the session is unreachable from that moment.
 * Otherwise yes when retention knows it or any store still holds it — the
 * second covers collections loaded from disk after a restart, which retention
 * has never seen.
 */
export function sessionIsLive(userId: string, sessionId: string): boolean {
  const r = theRetention();
  if (r.isClosing(userId, sessionId)) return false;
  return r.isKnown(userId, sessionId) || hasSessionState(userId, sessionId);
}

export function leaseSession(
  userId: string,
  sessionId: string,
  kind: LeaseKind,
): Lease | LeaseRefusal {
  return theRetention().lease(userId, sessionId, kind);
}

/** Close, wait for what is running, remove. The caller answers without awaiting it. */
export function deleteSession(userId: string, sessionId: string): Promise<void> {
  return theRetention().close(userId, sessionId);
}

export function maySweepSession(userId: string, sessionId: string): boolean {
  return theRetention().maySweep(userId, sessionId);
}

export function forgetEmptySessions(): number {
  return theRetention().forgetEmpty();
}

/** Test seam. */
export function resetGatekeeperForTest(): void {
  retention = undefined;
}
```

- [ ] **Step 6: The registry asks before sweeping, and bulk writes stop when told**

In `srv/rag-collections.ts`, change `sweepExpiredSessions`:

```ts
  /**
   * Remove expired session collections.
   *
   * `maySweep` is asked about each collection's session in the same synchronous
   * pass that removes it, so nothing can take a lease on the session between
   * the answer and the removal.
   */
  sweepExpiredSessions(
    maySweep: (userId: string, sessionId: string) => boolean = () => true,
  ): void {
    const now = Date.now();
    let changed = false;
    for (const [id, stored] of [...this.collections]) {
      if (
        stored.meta.scope === 'session' &&
        (stored.meta.expiresAt ?? 0) <= now &&
        maySweep(stored.meta.owner ?? '', stored.meta.sessionId ?? '')
      ) {
        changed = this.removeCollection(id) || changed;
      }
    }
    if (changed) {
      this.persistMeta();
      this.persistEnabled();
    }
  }
```

In `addDocumentsBulk`, add to the `options` type:

```ts
      /**
       * Stop between documents once aborted. The document already sent is not
       * taken back: its session is being removed, and the removal waits for
       * this call to return.
       */
      signal?: AbortSignal;
```

and as the first statement inside `for (const doc of docs) {`:

```ts
      if (options?.signal?.aborted) break;
```

- [ ] **Step 7: The RAG routes lease what they touch**

In `srv/rag-handler.ts`, add imports:

```ts
import { leaseSession } from './lib/gatekeeper';
import { isRefusal, type Lease, type LeaseRefusal } from './lib/session-retention';
import { doorRefusalSentence, sessionClosedText } from './lib/throttle-surfacing';
```

Inside `registerRagRoutes`, after `canAccess` is declared, add:

```ts
  function refuseLease(res: Response, refusal: LeaseRefusal): void {
    if (refusal.refused === 'closing') {
      res.status(410).json({ error: { message: sessionClosedText(), code: 'session_closed' } });
      return;
    }
    res.status(503).json({
      error: { message: doorRefusalSentence('retention'), code: 'gatekeeper_retention' },
    });
  }

  /**
   * Hold a lease on the collection's session for as long as the handler runs.
   *
   * Only session-scoped collections: a user collection belongs to no session and
   * nothing here deletes it. The lease is released when the handler's work
   * settles — not on the response's `close`, which fires on a client disconnect
   * while the backend call is still out.
   */
  const leased =
    (
      handler: (req: Request, res: Response, lease?: Lease) => void | Promise<void>,
    ) =>
    async (req: Request, res: Response): Promise<void> => {
      const physId = (req as Request & { _physId?: string })._physId;
      const meta = physId ? registry.getCollection(physId) : null;
      if (meta?.scope !== 'session' || !meta.owner || !meta.sessionId) {
        await handler(req, res);
        return;
      }
      const lease = leaseSession(meta.owner, meta.sessionId, 'rag');
      if (isRefusal(lease)) {
        refuseLease(res, lease);
        return;
      }
      try {
        await handler(req, res, lease);
      } finally {
        lease.release();
      }
    };
```

Wrap the handler passed to each of these registrations in `leased(...)`, bodies otherwise unchanged:

- `router.delete('/rag/collections/:id', ...)`
- `router.post('/rag/collections/:id/documents', ...)`
- `router.post('/rag/collections/:id/documents/bulk', ...)`
- `router.put('/rag/collections/:id/documents/:did', ...)`
- `router.delete('/rag/collections/:id/documents/:did', ...)`
- `router.post('/rag/collections/:id/upload', ...)`
- `router.post('/rag/collections/:id/query', ...)`

For example:

```ts
  router.post(
    '/rag/collections/:id/documents/bulk',
    leased(async (req: Request, res: Response, lease?: Lease) => {
      // ... unchanged, except the call:
      const result = await registry.addDocumentsBulk(physId, docs, namespace, {
        signal: lease?.signal,
      });
      // ... unchanged
    }),
  );
```

and in the upload route, likewise: `registry.addDocumentsBulk(collectionId, docs, namespace, { signal: lease?.signal })`.

In `POST /rag/collections`, declare `let lease: Lease | undefined;` immediately before the outer `try {`, take the lease in the session branch right after `physical = sessionCollectionId(logicalId, userId, sid);`:

```ts
        const taken = leaseSession(userId, sid, 'rag');
        if (isRefusal(taken)) {
          refuseLease(res, taken);
          return;
        }
        lease = taken;
```

and add after the outer `catch (err) { error(res, 409, ...); }`:

```ts
    finally {
      lease?.release();
    }
```

In `POST /rag/tool/:name`, replace the body after the unknown-tool check with:

```ts
    const sid = sessionIdOf(req);
    // rag_add may create a session collection, so a place is reserved for the
    // caller's session before it can.
    const lease = sid ? leaseSession(getUserId(), sid, 'rag') : undefined;
    if (lease && isRefusal(lease)) {
      refuseLease(res, lease);
      return;
    }
    try {
      const result = await runWithSessionId(sid, () =>
        dispatchRagTool(registry, name, req.body ?? {}),
      );
      json(res, result.ok ? 200 : 400, result);
    } finally {
      lease?.release();
    }
```

- [ ] **Step 8: The server — liveness, logout at the mark, and the sweeps**

In `srv/server.ts`, add `import { deleteSession, forgetEmptySessions, maySweepSession, sessionIsLive } from './lib/gatekeeper';` and remove the `deleteSessionState` import.

The middleware:

```ts
  app.use(
    '/v1',
    sessionMiddleware({
      userIdOf: () => cds.context?.user?.id ?? 'anonymous',
      isLive: sessionIsLive,
    }),
  );
```

In `DELETE /v1/session`, replace `deleteSessionState(userId, sessionId);` and its comment with:

```ts
    // Answered at the mark. The session is unreachable from this moment; its
    // bytes go when the last operation against them has stopped — a pipeline
    // runs to its own end, a RAG upload is cancelled and then waited for.
    void deleteSession(userId, sessionId).catch((err) =>
      cds.log('session').warn('session removal failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
```

In the `cds.on('served')` block, replace the RAG sweep interval with:

```ts
        // Hourly: expired session collections, skipping any session with an
        // operation still running against it — the next pass collects those.
        setInterval(
          () => registry.sweepExpiredSessions(maySweepSession),
          60 * 60 * 1000,
        ).unref();
        // Every five minutes, beside the history sweep: a session whose turns
        // have expired and which owns no collection stops counting.
        setInterval(() => forgetEmptySessions(), 5 * 60 * 1000).unref();
```

- [ ] **Step 9: Run, lint, commit**

```bash
npx jest test/unit/retention-wiring.test.ts test/unit/rag-handler.test.ts test/unit/cross-user-isolation.test.ts test/unit/rag-collections-disk.test.ts
npm run test:unit && npm run test:check
npx biome check --write srv/lib/gatekeeper.ts srv/lib/throttle-surfacing.ts srv/rag-collections.ts srv/rag-handler.ts srv/server.ts test/unit/helpers/rag-routes.ts test/unit/retention-wiring.test.ts
git add srv/lib/gatekeeper.ts srv/lib/throttle-surfacing.ts srv/rag-collections.ts srv/rag-handler.ts srv/server.ts test/unit/helpers/rag-routes.ts test/unit/retention-wiring.test.ts
git commit -m "feat(gatekeeper): sessions are leased while worked on, closed before deleted, and evicted only when idle"
```

---

## Phase 3 — the door

### Task 7: The door

**Files:**
- Create: `srv/lib/door.ts`
- Test: `test/unit/door.test.ts`

**Interfaces:**
- Consumes: `Lease`, `LeaseRefusal`, `isRefusal` (Task 5); `DoorRefusalReason` (Task 6, type only).
- Produces:
  - `export interface DoorRetention { canReserve(userId: string, sessionId: string): boolean; lease(userId: string, sessionId: string, kind: 'pipeline'): Lease | LeaseRefusal }`
  - `export interface Admission { readonly userId: string; readonly sessionId: string; readonly signal: AbortSignal; readonly outstanding: number; track<T>(p: Promise<T>): Promise<T>; drain(): Promise<void>; release(): void }`
  - `export type AdmitResult = { admitted: Admission } | { refused: DoorRefusalReason }`
  - `export interface DoorSnapshot { live: number; capacity: number; queued: number; queueLength: number; highWater: number; refusals: Record<DoorRefusalReason, number>; left: number }`
  - `export class Door`:
    - `constructor(opts: { capacity: number; queueLength: number; retention: DoorRetention; onPressure?: (depth: number, queueLength: number) => void })`
    - `admit(userId: string, sessionId: string, signal?: AbortSignal): Promise<AdmitResult>` — rejects with the signal's reason if the caller leaves while queued
    - `poke(): void` — dispatch after a retention place was freed elsewhere
    - `abortAll(reason?: unknown): void`
    - `snapshot(): DoorSnapshot`

**One rule for dispatch:** the oldest waiter that can be served goes next. Eligible means the session holds no slot, a slot is free, and retention can give a place — all three, taken in the same synchronous step, so admission never promises what retention then refuses.

**The invariant that makes a lost wake-up impossible:** after every change of state — an arrival, a release, a waiter leaving, a poke — the door dispatches until no queued waiter is eligible. So at rest no eligible waiter is ever queued, and an arrival that is eligible may be admitted at once without jumping anyone.

**Why `poke` exists:** a place can be freed by something the door never sees — a RAG lease settling, a logout finishing its cleanup. The gatekeeper (Task 10) calls `poke` on each; without it a waiter blocked only on retention would wait for an unrelated release.

**The register is on the admission.** Every dispatched call is tracked before it is awaited, and `drain` resolves when the last has settled, whether it resolved or rejected.

- [ ] **Step 1: Write the failing test**

Create `test/unit/door.test.ts`:

```ts
import { type Admission, type AdmitResult, Door } from '../../srv/lib/door';

function fakeRetention() {
  const r = {
    open: true,
    leases: 0,
    canReserve: (_u: string, _s: string) => r.open,
    lease: (_u: string, _s: string, kind: 'pipeline') => {
      if (!r.open) return { refused: 'retention' as const };
      r.leases++;
      let done = false;
      return {
        kind,
        signal: new AbortController().signal,
        release: () => {
          if (done) return;
          done = true;
          r.leases--;
        },
      };
    },
  };
  return r;
}

function door(capacity: number, queueLength = capacity, retention = fakeRetention()) {
  const pressure: number[] = [];
  const d = new Door({
    capacity,
    queueLength,
    retention,
    onPressure: (depth) => pressure.push(depth),
  });
  return { d, retention, pressure };
}

function admitted(r: AdmitResult): Admission {
  if (!('admitted' in r)) throw new Error(`refused: ${r.refused}`);
  return r.admitted;
}

const tick = () => new Promise((r) => setImmediate(r));

/** Start an admission without awaiting it; report when it lands. */
function pending(d: Door, u: string, s: string, signal?: AbortSignal) {
  const state: { result?: AdmitResult; error?: unknown } = {};
  const p = d.admit(u, s, signal).then(
    (r) => {
      state.result = r;
      return r;
    },
    (e) => {
      state.error = e;
      throw e;
    },
  );
  p.catch(() => {});
  return { p, state };
}

describe('capacity and the queue', () => {
  it('a capacity of one admits one', async () => {
    const { d } = door(1);
    admitted(await d.admit('u', 'A'));
    const b = pending(d, 'u', 'B');
    await tick();
    expect(b.state.result).toBeUndefined();
    expect(d.snapshot()).toMatchObject({ live: 1, queued: 1 });
  });

  it('holds the limit under pressure', async () => {
    const { d } = door(5, 20);
    const all = Array.from({ length: 20 }, (_, i) => pending(d, 'u', `S${i}`));
    await tick();
    expect(d.snapshot()).toMatchObject({ live: 5, queued: 15 });
    expect(all.filter((x) => x.state.result).length).toBe(5);
  });

  it('absorbs and then refuses', async () => {
    const { d } = door(5, 5);
    for (let i = 0; i < 10; i++) void pending(d, 'u', `S${i}`);
    await tick();
    expect(await d.admit('u', 'S10')).toEqual({ refused: 'capacity' });
    expect(d.snapshot().refusals.capacity).toBe(1);
  });

  it('reports three quarters before anyone is refused', async () => {
    const { d, pressure } = door(1, 4);
    for (let i = 0; i < 5; i++) void pending(d, 'u', `S${i}`);
    await tick();
    expect(pressure).toEqual([3]);
    expect(d.snapshot().highWater).toBe(4);
    expect(await d.admit('u', 'S5')).toEqual({ refused: 'capacity' });
  });
});

describe('order', () => {
  it('is first in, first out under contention', async () => {
    const { d } = door(1, 3);
    const a = admitted(await d.admit('u', 'A'));
    const b = pending(d, 'u', 'B');
    const c = pending(d, 'u', 'C');
    const e = pending(d, 'u', 'E');
    a.release();
    await tick();
    expect(b.state.result).toBeDefined();
    expect(c.state.result).toBeUndefined();
    admitted(b.state.result!).release();
    await tick();
    expect(c.state.result).toBeDefined();
    expect(e.state.result).toBeUndefined();
  });

  it('has no lost wake-up: a release always dispatches', async () => {
    const { d } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    const b = pending(d, 'u', 'B');
    a.release();
    await expect(b.p).resolves.toHaveProperty('admitted');
  });
});

describe('one session, one pipeline', () => {
  it('a second request for a live session waits, with slots to spare', async () => {
    // Written with capacity free: a test that fills the door first would pass
    // on the queue alone and prove nothing about the key.
    const { d } = door(5);
    admitted(await d.admit('alice', 'A'));
    const again = pending(d, 'alice', 'A');
    await tick();
    expect(again.state.result).toBeUndefined();
    expect(d.snapshot().live).toBe(1);
  });

  it('does not mistake one user for another when the parts could be read two ways', async () => {
    // With a join, ("a b", "c") would be the same key as ("a", "b c"): it would
    // wait on a session that is not its own, and its release would free the
    // other user's admission.
    const { d } = door(5);
    const first = admitted(await d.admit('a', 'b c'));
    const second = admitted(await d.admit('a b', 'c'));
    expect(d.snapshot().live).toBe(2);
    second.release();
    expect(d.snapshot().live).toBe(1);
    first.release();
  });

  it('two users cannot collide, whatever id they send', async () => {
    const { d } = door(5);
    admitted(await d.admit('alice', 'A'));
    admitted(await d.admit('bob', 'A'));
    expect(d.snapshot().live).toBe(2);
  });

  it('a caller colliding with itself is serialised, and both complete', async () => {
    const { d } = door(5);
    const first = admitted(await d.admit('alice', 'A'));
    const second = pending(d, 'alice', 'A');
    first.release();
    await expect(second.p).resolves.toHaveProperty('admitted');
  });

  it('a repeated session id cannot build a backlog', async () => {
    const { d } = door(5, 10);
    admitted(await d.admit('alice', 'A'));
    for (let i = 0; i < 10; i++) void pending(d, 'alice', 'A');
    await tick();
    expect(await d.admit('alice', 'A')).toEqual({ refused: 'session_busy' });
  });

  it('a blocked waiter does not hold the queue, and is not starved', async () => {
    const { d } = door(2, 5);
    const a = admitted(await d.admit('u', 'A'));
    const c = admitted(await d.admit('u', 'C'));
    const a2 = pending(d, 'u', 'A');
    const b = pending(d, 'u', 'B');
    c.release();
    await tick();
    // B is served while A is still busy, rather than the slot sitting empty.
    expect(b.state.result).toBeDefined();
    expect(a2.state.result).toBeUndefined();
    const later = pending(d, 'u', 'D');
    a.release();
    await tick();
    // A's waiter goes before anyone who arrived after it.
    expect(a2.state.result).toBeDefined();
    expect(later.state.result).toBeUndefined();
  });
});

describe('retention is part of admission', () => {
  it('a free slot with no retention place admits nobody, until a place frees', async () => {
    const { d, retention } = door(3);
    retention.open = false;
    const w = pending(d, 'u', 'A');
    await tick();
    expect(w.state.result).toBeUndefined();
    expect(retention.leases).toBe(0);
    retention.open = true;
    d.poke();
    await expect(w.p).resolves.toHaveProperty('admitted');
    expect(retention.leases).toBe(1);
  });

  it('a full queue refuses with every slot free, and says retention', async () => {
    const { d, retention } = door(3, 2);
    retention.open = false;
    void pending(d, 'u', 'A');
    void pending(d, 'u', 'B');
    await tick();
    expect(await d.admit('u', 'C')).toEqual({ refused: 'retention' });
    expect(d.snapshot()).toMatchObject({ live: 0, queued: 2 });
  });

  it('checks the session before capacity, and capacity before retention', async () => {
    const { d, retention } = door(1, 1);
    admitted(await d.admit('alice', 'A'));
    void pending(d, 'bob', 'B');
    await tick();
    retention.open = false;
    expect(await d.admit('alice', 'A')).toEqual({ refused: 'session_busy' });
    expect(await d.admit('carol', 'C')).toEqual({ refused: 'capacity' });
  });

  it('releasing gives the place back as well as the slot', async () => {
    const { d, retention } = door(2);
    const a = admitted(await d.admit('u', 'A'));
    a.release();
    a.release();
    expect(retention.leases).toBe(0);
    expect(d.snapshot().live).toBe(0);
  });
});

describe('a waiter that leaves', () => {
  it('takes no slot and starts nothing', async () => {
    const { d, retention } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    const controller = new AbortController();
    const b = pending(d, 'u', 'B', controller.signal);
    controller.abort(new Error('client gone'));
    await expect(b.p).rejects.toThrow('client gone');
    a.release();
    await tick();
    expect(d.snapshot()).toMatchObject({ live: 0, queued: 0, left: 1 });
    expect(retention.leases).toBe(0);
  });
});

describe('the register', () => {
  it('drains only when every tracked call has settled, rejected ones included', async () => {
    const { d } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    let finish!: () => void;
    let fail!: (e: Error) => void;
    void a.track(new Promise<void>((r) => (finish = r)));
    a.track(new Promise<void>((_, j) => (fail = j))).catch(() => {});
    expect(a.outstanding).toBe(2);
    let drained = false;
    void a.drain().then(() => (drained = true));
    finish();
    await tick();
    expect(drained).toBe(false);
    fail(new Error('write failed'));
    await tick();
    expect(drained).toBe(true);
    expect(a.outstanding).toBe(0);
  });

  it('drains at once when nothing was tracked', async () => {
    const { d } = door(1);
    await expect(admitted(await d.admit('u', 'A')).drain()).resolves.toBeUndefined();
  });
});

describe('shutdown', () => {
  it('aborts every admitted session and every waiter, and nothing else does', async () => {
    const { d } = door(1);
    const a = admitted(await d.admit('u', 'A'));
    const b = pending(d, 'u', 'B');
    await tick();
    expect(a.signal.aborted).toBe(false);
    d.abortAll(new Error('shutdown'));
    expect(a.signal.aborted).toBe(true);
    await expect(b.p).rejects.toThrow('shutdown');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/door.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the door**

Create `srv/lib/door.ts`:

```ts
/**
 * The door: how many sessions may be live at once, and the one queue in front.
 *
 * Pure. Retention is injected; there is no timer and no clock, because nothing
 * here waits for a duration — only for a slot, a session or a place.
 */

import { isRefusal, type Lease, type LeaseRefusal } from './session-retention';
import type { DoorRefusalReason } from './throttle-surfacing';

export interface DoorRetention {
  canReserve(userId: string, sessionId: string): boolean;
  lease(userId: string, sessionId: string, kind: 'pipeline'): Lease | LeaseRefusal;
}

export interface Admission {
  readonly userId: string;
  readonly sessionId: string;
  /** Aborted by shutdown, and by nothing else. */
  readonly signal: AbortSignal;
  readonly outstanding: number;
  /** Register a dispatched call before awaiting it. */
  track<T>(p: Promise<T>): Promise<T>;
  /** Resolves when every tracked call has settled. */
  drain(): Promise<void>;
  /** Give back the retention lease and the slot. Last in teardown. Idempotent. */
  release(): void;
}

export type AdmitResult = { admitted: Admission } | { refused: DoorRefusalReason };

export interface DoorSnapshot {
  live: number;
  capacity: number;
  queued: number;
  queueLength: number;
  highWater: number;
  refusals: Record<DoorRefusalReason, number>;
  left: number;
}

interface Waiter {
  userId: string;
  sessionId: string;
  key: string;
  resolve: (r: AdmitResult) => void;
  reject: (e: unknown) => void;
  detach: () => void;
}

function keyOf(userId: string, sessionId: string): string {
  // A tuple, not a join: no separator keeps ("a", "b c") and ("a b", "c") apart
  // whatever a caller puts in a cookie.
  return JSON.stringify([userId, sessionId]);
}

export class Door {
  private readonly live = new Map<string, Admission & { abort(reason: unknown): void }>();
  private readonly waiters: Waiter[] = [];
  private readonly refusals: Record<DoorRefusalReason, number> = {
    session_busy: 0,
    capacity: 0,
    retention: 0,
  };
  private highWater = 0;
  private left = 0;
  private readonly capacity: number;
  private readonly queueLength: number;
  private readonly retention: DoorRetention;
  private readonly onPressure?: (depth: number, queueLength: number) => void;

  constructor(opts: {
    capacity: number;
    queueLength: number;
    retention: DoorRetention;
    onPressure?: (depth: number, queueLength: number) => void;
  }) {
    this.capacity = opts.capacity;
    this.queueLength = opts.queueLength;
    this.retention = opts.retention;
    this.onPressure = opts.onPressure;
  }

  admit(userId: string, sessionId: string, signal?: AbortSignal): Promise<AdmitResult> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.eligible(userId, sessionId)) {
      const admission = this.take(userId, sessionId);
      if (admission) return Promise.resolve({ admitted: admission });
    }
    if (this.waiters.length >= this.queueLength) {
      const reason = this.reasonFor(userId, sessionId);
      this.refusals[reason]++;
      return Promise.resolve({ refused: reason });
    }
    return new Promise<AdmitResult>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i === -1) return;
        this.waiters.splice(i, 1);
        this.left++;
        reject(signal?.reason);
        this.dispatch();
      };
      const waiter: Waiter = {
        userId,
        sessionId,
        key: keyOf(userId, sessionId),
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const before = this.waiters.length;
      this.waiters.push(waiter);
      this.noteDepth(before);
    });
  }

  poke(): void {
    this.dispatch();
  }

  abortAll(reason: unknown = new Error('shutdown')): void {
    for (const w of this.waiters.splice(0)) {
      w.detach();
      w.reject(reason);
    }
    for (const a of this.live.values()) a.abort(reason);
  }

  snapshot(): DoorSnapshot {
    return {
      live: this.live.size,
      capacity: this.capacity,
      queued: this.waiters.length,
      queueLength: this.queueLength,
      highWater: this.highWater,
      refusals: { ...this.refusals },
      left: this.left,
    };
  }

  private eligible(userId: string, sessionId: string): boolean {
    return (
      !this.live.has(keyOf(userId, sessionId)) &&
      this.live.size < this.capacity &&
      this.retention.canReserve(userId, sessionId)
    );
  }

  /** In the order admission checks, so the caller hears what it can act on first. */
  private reasonFor(userId: string, sessionId: string): DoorRefusalReason {
    if (this.live.has(keyOf(userId, sessionId))) return 'session_busy';
    if (this.live.size >= this.capacity) return 'capacity';
    return 'retention';
  }

  private noteDepth(before: number): void {
    const depth = this.waiters.length;
    if (depth > this.highWater) this.highWater = depth;
    const mark = (this.queueLength * 3) / 4;
    if (before < mark && depth >= mark) this.onPressure?.(depth, this.queueLength);
  }

  /** Slot and place together, in this synchronous step, or neither. */
  private take(userId: string, sessionId: string): Admission | undefined {
    const lease = this.retention.lease(userId, sessionId, 'pipeline');
    if (isRefusal(lease)) return undefined;
    const key = keyOf(userId, sessionId);
    const controller = new AbortController();
    const register = new Set<Promise<unknown>>();
    let drainers: Array<() => void> = [];
    let released = false;
    const settleOne = (p: Promise<unknown>) => {
      register.delete(p);
      if (register.size === 0) {
        const waiting = drainers;
        drainers = [];
        for (const d of waiting) d();
      }
    };
    const admission = {
      userId,
      sessionId,
      signal: controller.signal,
      get outstanding() {
        return register.size;
      },
      track: <T>(p: Promise<T>): Promise<T> => {
        register.add(p);
        p.then(
          () => settleOne(p),
          () => settleOne(p),
        );
        return p;
      },
      drain: () =>
        register.size === 0
          ? Promise.resolve()
          : new Promise<void>((r) => {
              drainers.push(r);
            }),
      release: () => {
        if (released) return;
        released = true;
        lease.release();
        this.live.delete(key);
        this.dispatch();
      },
      abort: (reason: unknown) => controller.abort(reason),
    };
    this.live.set(key, admission);
    return admission;
  }

  /** Admit the oldest eligible waiter, repeatedly, until none is eligible. */
  private dispatch(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const w = this.waiters[i];
      if (!this.eligible(w.userId, w.sessionId)) {
        i++;
        continue;
      }
      const admission = this.take(w.userId, w.sessionId);
      if (!admission) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      w.detach();
      w.resolve({ admitted: admission });
      i = 0;
    }
  }
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
npx jest test/unit/door.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/door.ts test/unit/door.test.ts
git add srv/lib/door.ts test/unit/door.test.ts
git commit -m "feat(gatekeeper): the door — one queue, the oldest eligible waiter, slot and place together"
```

---

### Task 8: Each channel refuses in its own dialect

**Files:**
- Modify: `srv/lib/throttle-surfacing.ts`
- Test: `test/unit/door-refusal.test.ts`

**Interfaces:**
- Consumes: `DoorRefusalReason`, `doorRefusalSentence` (Task 6).
- Produces:
  - `export interface HttpRefusal { status: number; body: unknown }`
  - `export function openAiDoorRefusal(reason: DoorRefusalReason): HttpRefusal` — `503`, `{ error: { message, type: 'server_error', code: 'gatekeeper_<reason>' } }`
  - `export function anthropicDoorRefusal(reason: DoorRefusalReason): HttpRefusal` — `529`, `{ type: 'error', error: { type: 'overloaded_error', message } }`
  - `export function executeStepDoorRefusal(reason: DoorRefusalReason): string` — `gatekeeper_<reason>: <sentence>`

**Why here and not in the handlers:** a test must exercise what the handler actually sends. Tasks 10 and 11 assert the handlers send these; this task pins the shapes.

**Why no header:** a door refusal carries no `Retry-After` and no number. The formatters return no headers, so a handler has nothing to forward.

- [ ] **Step 1: Write the failing test**

Create `test/unit/door-refusal.test.ts`:

```ts
import {
  anthropicDoorRefusal,
  type DoorRefusalReason,
  doorRefusalSentence,
  executeStepDoorRefusal,
  openAiDoorRefusal,
} from '../../srv/lib/throttle-surfacing';

const REASONS: DoorRefusalReason[] = ['session_busy', 'capacity', 'retention'];

describe.each(REASONS)('refusing for %s', (reason) => {
  it('speaks the OpenAI envelope with a code a program can branch on', () => {
    expect(openAiDoorRefusal(reason)).toEqual({
      status: 503,
      body: {
        error: {
          message: doorRefusalSentence(reason),
          type: 'server_error',
          code: `gatekeeper_${reason}`,
        },
      },
    });
  });

  it("speaks Anthropic's overloaded_error under 529, the reason in the sentence", () => {
    expect(anthropicDoorRefusal(reason)).toEqual({
      status: 529,
      body: {
        type: 'error',
        error: { type: 'overloaded_error', message: doorRefusalSentence(reason) },
      },
    });
  });

  it('gives execute_step a prefixed line a planner can branch on without parsing prose', () => {
    expect(executeStepDoorRefusal(reason)).toBe(
      `gatekeeper_${reason}: ${doorRefusalSentence(reason)}`,
    );
  });

  it('carries no number anywhere', () => {
    for (const text of [
      JSON.stringify(openAiDoorRefusal(reason).body),
      JSON.stringify(anthropicDoorRefusal(reason).body),
      executeStepDoorRefusal(reason),
    ]) {
      expect(text).not.toMatch(/\d/);
    }
  });
});

describe('the sentences say what is missing, and only that', () => {
  it('retention never mentions pipelines, and capacity never mentions memory', () => {
    // The wrong one sends an operator to tune the wrong variable.
    expect(doorRefusalSentence('retention')).not.toMatch(/pipeline|capacity/i);
    expect(doorRefusalSentence('capacity')).not.toMatch(/memory|hold another session/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/door-refusal.test.ts`
Expected: FAIL — `openAiDoorRefusal` is not exported.

- [ ] **Step 3: Write the formatters**

Append to `srv/lib/throttle-surfacing.ts`:

```ts
/** A refusal a handler writes as-is: a status and a JSON body, and no headers. */
export interface HttpRefusal {
  status: number;
  body: unknown;
}

/** `/v1/chat/completions`. */
export function openAiDoorRefusal(reason: DoorRefusalReason): HttpRefusal {
  return {
    status: 503,
    body: {
      error: {
        message: doorRefusalSentence(reason),
        type: 'server_error',
        code: `gatekeeper_${reason}`,
      },
    },
  };
}

/**
 * `/v1/messages`. `overloaded_error` under `529` is the dialect's own pairing,
 * argued above for throttling. The envelope has no field for a reason, so the
 * reason travels in the sentence.
 */
export function anthropicDoorRefusal(reason: DoorRefusalReason): HttpRefusal {
  return {
    status: 529,
    body: {
      type: 'error',
      error: { type: 'overloaded_error', message: doorRefusalSentence(reason) },
    },
  };
}

/** `execute_step`: a failure line whose prefix a planner can branch on. */
export function executeStepDoorRefusal(reason: DoorRefusalReason): string {
  return `gatekeeper_${reason}: ${doorRefusalSentence(reason)}`;
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
npx jest test/unit/door-refusal.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/throttle-surfacing.ts test/unit/door-refusal.test.ts
git add srv/lib/throttle-surfacing.ts test/unit/door-refusal.test.ts
git commit -m "feat(gatekeeper): each channel refuses at the door in its own dialect, with no number"
```

---

### Task 9: The register is written by the calls themselves

**Files:**
- Create: `srv/lib/admission-scope.ts`, `srv/lib/tracked-llm.ts`
- Modify: `srv/agent-manager.ts` (every `makeLlm` result wrapped; `invokeEmbeddedTool` tracks its dispatch)
- Modify: `srv/lib/door.ts` (the admission's register comes from `createCallRegister`)
- Test: `test/unit/admission-scope.test.ts`

**Interfaces:**
- Consumes: `Admission.track` (Task 7), structurally — this module does not import the door.
- Produces:
  - `export interface CallRegister { track<T>(p: Promise<T>): Promise<T> }`
  - `export function runWithAdmission<T>(register: CallRegister, fn: () => T): T`
  - `export function currentAdmission(): CallRegister | undefined`
  - `export function trackCall<T>(p: Promise<T>): Promise<T>` — registers when a scope exists, passes through otherwise
  - `export interface DrainableRegister extends CallRegister { readonly outstanding: number; drain(): Promise<void> }`
  - `export function createCallRegister(): DrainableRegister` — the one register implementation; the door and the no-door path (Task 10) both use it
  - `export function trackedLlm(inner: ILlm): ILlm`

**Why this task exists:** Task 7 gives the admission a register and a drain, and nothing writes to it. A register nobody writes to drains instantly, so `safeStop` would close the ADT session on top of a live write — the defect the register exists to prevent, dressed as a passing test.

**Why an async-local scope and not a parameter:** the two places that dispatch — the embedded tool handler and the LLM — sit below the library's pipeline, with no parameter to thread. This codebase already carries per-request state this way (`connectionALS`, `request-session`).

**Why no scope means no registration:** the shared tool corpus is built outside any request. Attributing it to whichever caller arrived first would make a process-wide build the property of a caller that may be gone before it ends.

**Why every `makeLlm` result, the helpers included:** a wrapper costs nothing outside a scope, and a rule with exceptions is a rule someone breaks on the next hot-swap. The structural test counts them.

- [ ] **Step 1: Write the failing test**

Create `test/unit/admission-scope.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import {
  createCallRegister,
  currentAdmission,
  runWithAdmission,
  trackCall,
} from '../../srv/lib/admission-scope';
import { trackedLlm } from '../../srv/lib/tracked-llm';

function register() {
  const set = new Set<Promise<unknown>>();
  return {
    set,
    track<T>(p: Promise<T>): Promise<T> {
      set.add(p);
      p.then(
        () => set.delete(p),
        () => set.delete(p),
      );
      return p;
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('trackCall', () => {
  it('registers a call started inside the scope, before it is awaited', async () => {
    const reg = register();
    const call = deferred<string>();
    await runWithAdmission(reg, async () => {
      void trackCall(call.promise);
    });
    // Registered at dispatch. Written after the await, an aborted caller would
    // free the slot on top of a call still running.
    expect(reg.set.size).toBe(1);
    call.resolve('done');
    await tick();
    expect(reg.set.size).toBe(0);
  });

  it('registers nothing with no scope', async () => {
    expect(currentAdmission()).toBeUndefined();
    await expect(trackCall(Promise.resolve(1))).resolves.toBe(1);
  });

  it('keeps two pipelines apart', async () => {
    const a = register();
    const b = register();
    const call = deferred<void>();
    await runWithAdmission(a, async () => {
      void trackCall(call.promise);
    });
    expect(a.set.size).toBe(1);
    expect(b.set.size).toBe(0);
    call.resolve();
  });
});

describe('createCallRegister', () => {
  it('drains only after every tracked call settles, rejected ones included', async () => {
    const reg = createCallRegister();
    const ok = deferred<void>();
    let fail!: (e: Error) => void;
    void reg.track(ok.promise);
    reg.track(new Promise<void>((_, j) => (fail = j))).catch(() => {});
    expect(reg.outstanding).toBe(2);
    let drained = false;
    void reg.drain().then(() => (drained = true));
    ok.resolve();
    await tick();
    expect(drained).toBe(false);
    fail(new Error('x'));
    await tick();
    expect(drained).toBe(true);
  });

  it('drains at once when empty', async () => {
    await expect(createCallRegister().drain()).resolves.toBeUndefined();
  });
});

describe('trackedLlm', () => {
  function fakeLlm(chat: Promise<unknown>, chunks: unknown[] = []): ILlm {
    return {
      model: 'm',
      chat: () => chat as ReturnType<ILlm['chat']>,
      async *streamChat() {
        for (const c of chunks) yield c as never;
      },
    };
  }

  it('registers a model call for as long as it is pending', async () => {
    const reg = register();
    const call = deferred<unknown>();
    const llm = trackedLlm(fakeLlm(call.promise));
    await runWithAdmission(reg, async () => {
      void llm.chat([]);
    });
    expect(reg.set.size).toBe(1);
    call.resolve({ ok: true, value: { content: '' } });
    await tick();
    expect(reg.set.size).toBe(0);
  });

  it('registers a stream until it ends, and when the reader stops early', async () => {
    const reg = register();
    const llm = trackedLlm(fakeLlm(Promise.resolve(), [1, 2, 3]));
    await runWithAdmission(reg, async () => {
      for await (const _ of llm.streamChat([])) {
        expect(reg.set.size).toBe(1);
        break;
      }
    });
    await tick();
    expect(reg.set.size).toBe(0);
  });

  it('keeps the model name', () => {
    expect(trackedLlm(fakeLlm(Promise.resolve())).model).toBe('m');
  });
});

describe('the calls that dispatch are the ones that register', () => {
  const src = readFileSync(join(__dirname, '../../srv/agent-manager.ts'), 'utf8');

  it('wraps every LLM this service constructs', () => {
    const made = src.match(/makeLlm\(/g)?.length ?? 0;
    const wrapped = src.match(/trackedLlm\(/g)?.length ?? 0;
    expect(made).toBeGreaterThan(0);
    // Each construction site passes its result through trackedLlm: directly, or
    // via `.then(trackedLlm)` which the second pattern counts.
    const thenWrapped = src.match(/\.then\(\s*trackedLlm\s*\)/g)?.length ?? 0;
    expect(wrapped + thenWrapped).toBe(made);
  });

  it('tracks the embedded tool dispatch', () => {
    expect(src).toMatch(/await\s+trackCall\(\s*Promise\.resolve\(\s*toolCall\s*\)\s*\)/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/admission-scope.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: The scope**

Create `srv/lib/admission-scope.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

/** What a dispatched call needs from the admission it runs under. */
export interface CallRegister {
  track<T>(p: Promise<T>): Promise<T>;
}

const als = new AsyncLocalStorage<CallRegister>();

/** Run a pipeline so that every call it dispatches registers against `register`. */
export function runWithAdmission<T>(register: CallRegister, fn: () => T): T {
  return als.run(register, fn);
}

/** The register in scope, or nothing — the correct answer for process-owned work. */
export function currentAdmission(): CallRegister | undefined {
  return als.getStore();
}

/** Register `p` against the admission in scope, if any, and return it. */
export function trackCall<T>(p: Promise<T>): Promise<T> {
  return currentAdmission()?.track(p) ?? p;
}

/** A register that can say when everything it holds has settled. */
export interface DrainableRegister extends CallRegister {
  readonly outstanding: number;
  drain(): Promise<void>;
}

export function createCallRegister(): DrainableRegister {
  const inFlight = new Set<Promise<unknown>>();
  let drainers: Array<() => void> = [];
  const settle = (p: Promise<unknown>) => {
    inFlight.delete(p);
    if (inFlight.size > 0) return;
    const waiting = drainers;
    drainers = [];
    for (const d of waiting) d();
  };
  return {
    get outstanding() {
      return inFlight.size;
    },
    track<T>(p: Promise<T>): Promise<T> {
      inFlight.add(p);
      p.then(
        () => settle(p),
        () => settle(p),
      );
      return p;
    },
    drain: () =>
      inFlight.size === 0
        ? Promise.resolve()
        : new Promise<void>((r) => {
            drainers.push(r);
          }),
  };
}
```

The door built its own register in Task 7, before this module existed. Replace it: in `srv/lib/door.ts`, add `import { createCallRegister } from './admission-scope';`, and in `take` delete `register`, `drainers` and `settleOne`, create `const register = createCallRegister();`, and give the admission `get outstanding() { return register.outstanding; }`, `track: (p) => register.track(p)` and `drain: () => register.drain()`. `test/unit/door.test.ts` stays green unchanged — it is the check that the swap kept the behaviour.

- [ ] **Step 4: The LLM wrapper**

Create `srv/lib/tracked-llm.ts`:

```ts
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { trackCall } from './admission-scope';

/**
 * An `ILlm` whose calls register against the admission in scope.
 *
 * A stream is registered when the reader starts it and settles when the reader
 * stops, whether at the end, on an early `break`, or on a throw.
 */
export function trackedLlm(inner: ILlm): ILlm {
  return {
    get model() {
      return inner.model;
    },
    chat: (...args: Parameters<ILlm['chat']>) => trackCall(inner.chat(...args)),
    streamChat: (...args: Parameters<ILlm['streamChat']>) =>
      trackStream(inner.streamChat(...args)),
    ...(inner.healthCheck
      ? { healthCheck: (...a: Parameters<NonNullable<ILlm['healthCheck']>>) => inner.healthCheck!(...a) }
      : {}),
    ...(inner.getModels
      ? { getModels: (...a: Parameters<NonNullable<ILlm['getModels']>>) => inner.getModels!(...a) }
      : {}),
  };
}

async function* trackStream<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  let done!: () => void;
  void trackCall(
    new Promise<void>((r) => {
      done = r;
    }),
  );
  try {
    for await (const chunk of source) yield chunk;
  } finally {
    done();
  }
}
```

If Biome rejects the two non-null assertions, bind the method first: `const hc = inner.healthCheck; ...(hc ? { healthCheck: (...a) => hc.call(inner, ...a) } : {})`, and the same for `getModels`.

- [ ] **Step 5: Wrap every construction, and track the tool dispatch**

In `srv/agent-manager.ts`, add `import { trackCall } from './lib/admission-scope';` and `import { trackedLlm } from './lib/tracked-llm';`.

The two helper constructions (`const helperLlm = await makeLlm(` — there are two):

```ts
  const helperLlm = trackedLlm(
    await makeLlm(
      // ... arguments unchanged ...
    ),
  );
```

In `getOrCreateSharedLlms`, both `sharedMainLlm = makeLlm(...)` and `sharedClassifierLlm = makeLlm(...)` gain `.then(trackedLlm)` after the closing parenthesis of the call:

```ts
    sharedMainLlm = makeLlm(
      // ... arguments unchanged ...
      config.llm.temperature,
    ).then(trackedLlm);
```

In the model hot-swap, likewise:

```ts
    const newLlmPromise = makeLlm(
      // ... arguments unchanged ...
      config.llm.temperature,
    ).then(trackedLlm);
```

The declared types (`ReturnType<typeof makeLlm>`, i.e. `Promise<ILlm>`) are unchanged.

In `invokeEmbeddedTool`, replace:

```ts
      const result = await toolCall;
```

with:

```ts
      // Registered before it is awaited. An ADT call is asynchronous in
      // substance: the slot, and the ADT session, must outlive it even when
      // everything waiting on it has stopped.
      const result = await trackCall(Promise.resolve(toolCall));
```

- [ ] **Step 6: Run, lint, commit**

```bash
npx jest test/unit/admission-scope.test.ts test/unit/door.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/admission-scope.ts srv/lib/tracked-llm.ts srv/lib/door.ts srv/agent-manager.ts test/unit/admission-scope.test.ts
git add srv/lib/admission-scope.ts srv/lib/tracked-llm.ts srv/lib/door.ts srv/agent-manager.ts test/unit/admission-scope.test.ts
git commit -m "feat(gatekeeper): model and tool calls register themselves against the admission in scope"
```

---

### Task 10: The detached sink, and the door inside the gatekeeper

**Files:**
- Create: `srv/lib/detached-sink.ts`
- Modify: `srv/lib/gatekeeper.ts` (the door; `admitPipeline`; pokes when a place frees)
- Test: `test/unit/detached-sink.test.ts`, `test/unit/gatekeeper-door.test.ts`

**Interfaces:**
- Consumes: `Door`, `AdmitResult` (Task 7); `runWithAdmission`, `createCallRegister` (Task 9); `theRetention`, `leaseSession`, `deleteSession`, `forgetEmptySessions`, `resetGatekeeperForTest` (Task 6); `gatekeeperConfig` (Task 4); `DoorRefusalReason` (Task 6).
- Produces:
  - `export interface OutputSink { readonly detached: boolean; detach(): void; writeHead(status: number, headers?: Record<string, string>): void; setHeader(name: string, value: string): void; write(chunk: string): void; end(chunk?: string): void; json(status: number, body: unknown): void }`
  - `export function detachedSink(res: Response): OutputSink`
  - in `srv/lib/gatekeeper.ts`:
    - `export function theDoor(): Door | undefined` — `undefined` when no capacity is configured
    - `export interface PipelineSession { readonly signal: AbortSignal | undefined; run<T>(fn: () => T): T; drain(): Promise<void>; release(): void }`
    - `export type PipelineAdmission = { admitted: PipelineSession } | { refused: DoorRefusalReason }`
    - `export function admitPipeline(userId: string, sessionId: string, signal?: AbortSignal): Promise<PipelineAdmission>`

**Why a disconnect detaches the sink rather than guarding writes.** A client that leaves ends nothing — the pipeline runs on, because SAP is still waiting for the rest of the chain. What the pipeline must not do is fail on a dead socket. So after `detach`, every chunk and closing envelope is dropped before the socket, and a write that throws detaches the sink rather than raising into the pipeline.

**Why `admitPipeline` exists with no door configured.** Nothing is refused and nothing waits, but the session still takes a pipeline lease, so a logout during the run waits for it instead of deleting under it, and calls still register, so teardown still waits for them. Absent means no admission limit; it does not mean deleting state out from under a running write.

**Why the gatekeeper pokes the door.** A retention place frees when a RAG lease settles, when a logout's cleanup runs, and when an empty session is forgotten — none of which the door sees. A waiter blocked only on retention is admitted the moment one of them happens, not at the next unrelated release.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/detached-sink.test.ts`:

```ts
import type { Response } from 'express';
import { detachedSink } from '../../srv/lib/detached-sink';

function fakeRes(opts: { throwOnWrite?: boolean } = {}) {
  const out: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      out.push(`head ${status}`);
      res.headersSent = true;
    },
    setHeader(n: string, v: string) {
      out.push(`header ${n}=${v}`);
    },
    write(c: string) {
      if (opts.throwOnWrite) throw new Error('EPIPE');
      out.push(c);
    },
    end(c?: string) {
      if (c) out.push(c);
      out.push('end');
      res.writableEnded = true;
    },
    status(s: number) {
      out.push(`status ${s}`);
      return res;
    },
    json(b: unknown) {
      out.push(JSON.stringify(b));
      res.writableEnded = true;
    },
  };
  return { res: res as unknown as Response, out };
}

describe('the detached sink', () => {
  it('passes writes through while attached', () => {
    const { res, out } = fakeRes();
    const sink = detachedSink(res);
    sink.writeHead(200, {});
    sink.write('a');
    sink.end('b');
    expect(out).toEqual(['head 200', 'a', 'b', 'end']);
  });

  it('drops every chunk and closing envelope once detached, and none throws', () => {
    const { res, out } = fakeRes();
    const sink = detachedSink(res);
    sink.write('before');
    sink.detach();
    expect(() => {
      sink.write('chunk');
      sink.end('[DONE]');
      sink.json(500, { error: 'late' });
    }).not.toThrow();
    expect(out).toEqual(['before']);
    expect(sink.detached).toBe(true);
  });

  it('detaches itself when the socket is already dead, rather than raising into the pipeline', () => {
    const { res } = fakeRes({ throwOnWrite: true });
    const sink = detachedSink(res);
    expect(() => sink.write('x')).not.toThrow();
    expect(sink.detached).toBe(true);
  });

  it('writes nothing after the response has ended', () => {
    const { res, out } = fakeRes();
    const sink = detachedSink(res);
    sink.end();
    sink.write('late');
    expect(out).toEqual(['end']);
  });
});
```

Create `test/unit/gatekeeper-door.test.ts`:

```ts
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      context: undefined,
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
  getRequestHistory: () => [],
}));

import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { isRefusal, type Lease } from '../../srv/lib/session-retention';
import { trackCall } from '../../srv/lib/admission-scope';

const tick = () => new Promise((r) => setImmediate(r));

function configure(live?: number, retained?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (retained === undefined) delete process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_RETAINED_SESSIONS = String(retained);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

afterEach(() => configure());

function admitted(r: gatekeeper.PipelineAdmission) {
  if (!('admitted' in r)) throw new Error(`refused: ${r.refused}`);
  return r.admitted;
}

describe('with a door', () => {
  it('admits up to the capacity and queues the rest', async () => {
    configure(1);
    const a = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let bAdmitted = false;
    const b = gatekeeper.admitPipeline('u', 'B').then((r) => {
      bAdmitted = true;
      return r;
    });
    await tick();
    expect(bAdmitted).toBe(false);
    a.release();
    admitted(await b).release();
  });

  it('admits a retention-blocked waiter the moment a RAG lease settles', async () => {
    configure(2, 2);
    const ragA = gatekeeper.leaseSession('u', 'A', 'rag') as Lease;
    const ragB = gatekeeper.leaseSession('u', 'B', 'rag') as Lease;
    expect(isRefusal(ragA) || isRefusal(ragB)).toBe(false);
    let admittedC = false;
    const c = gatekeeper.admitPipeline('u', 'C').then((r) => {
      admittedC = true;
      return r;
    });
    await tick();
    // Both slots free, no place: no pipeline starts.
    expect(admittedC).toBe(false);
    ragA.release();
    admitted(await c).release();
    ragB.release();
  });

  it('registers calls made inside run, and drains after them', async () => {
    configure(1);
    const s = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let finish!: () => void;
    s.run(() => {
      void trackCall(new Promise<void>((r) => (finish = r)));
    });
    let drained = false;
    void s.drain().then(() => (drained = true));
    await tick();
    expect(drained).toBe(false);
    finish();
    await tick();
    expect(drained).toBe(true);
    s.release();
  });
});

describe('logout with a door', () => {
  it('waits for the admitted pipeline and does not abort it', async () => {
    // A logout is a disconnect with a better name: it may not cut an ADT write
    // between create and activate.
    configure(1);
    const s = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let removed = false;
    const removal = gatekeeper.deleteSession('u', 'A').then(() => (removed = true));
    await tick();
    expect(s.signal?.aborted).toBe(false);
    expect(removed).toBe(false);
    s.release();
    await removal;
    expect(removed).toBe(true);
  });
});

describe('without a door', () => {
  it('admits at once and refuses nothing', async () => {
    configure();
    expect(gatekeeper.theDoor()).toBeUndefined();
    const sessions = await Promise.all(
      Array.from({ length: 10 }, (_, i) => gatekeeper.admitPipeline('u', `S${i}`)),
    );
    for (const s of sessions) admitted(s).release();
  });

  it('still leases the session, so a logout waits for the run', async () => {
    configure();
    const s = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let removed = false;
    const removal = gatekeeper.deleteSession('u', 'A').then(() => (removed = true));
    await tick();
    expect(removed).toBe(false);
    s.release();
    await removal;
    expect(removed).toBe(true);
  });

  it('still registers calls, so teardown waits for them', async () => {
    configure();
    const s = admitted(await gatekeeper.admitPipeline('u', 'A'));
    let finish!: () => void;
    s.run(() => {
      void trackCall(new Promise<void>((r) => (finish = r)));
    });
    let drained = false;
    void s.drain().then(() => (drained = true));
    await tick();
    expect(drained).toBe(false);
    finish();
    await tick();
    expect(drained).toBe(true);
    s.release();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest test/unit/detached-sink.test.ts test/unit/gatekeeper-door.test.ts`
Expected: FAIL — `srv/lib/detached-sink` is not found; `admitPipeline` is not exported.

- [ ] **Step 3: The sink**

Create `srv/lib/detached-sink.ts`:

```ts
import type { Response } from 'express';

/**
 * Where a pipeline's output goes, detachable.
 *
 * A client that disconnects ends nothing: SAP is still waiting for the rest of
 * a write chain, and nobody else is. What the pipeline must not do is fail on
 * the dead socket. After `detach`, every write is dropped before the socket;
 * a write that throws detaches the sink instead of raising into the pipeline.
 */
export interface OutputSink {
  readonly detached: boolean;
  detach(): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(chunk?: string): void;
  json(status: number, body: unknown): void;
}

export function detachedSink(res: Response): OutputSink {
  let detached = false;
  const guard = (fn: () => void) => {
    if (detached || res.writableEnded) return;
    try {
      fn();
    } catch {
      detached = true;
    }
  };
  return {
    get detached() {
      return detached;
    },
    detach() {
      detached = true;
    },
    writeHead: (status, headers) =>
      guard(() => {
        if (!res.headersSent) res.writeHead(status, headers);
      }),
    setHeader: (name, value) =>
      guard(() => {
        if (!res.headersSent) res.setHeader(name, value);
      }),
    write: (chunk) =>
      guard(() => {
        res.write(chunk);
      }),
    end: (chunk) =>
      guard(() => {
        if (chunk === undefined) res.end();
        else res.end(chunk);
      }),
    json: (status, body) =>
      guard(() => {
        res.status(status).json(body);
      }),
  };
}
```

- [ ] **Step 4: The door inside the gatekeeper**

In `srv/lib/gatekeeper.ts`, add imports:

```ts
import cds from '@sap/cds';
import { createCallRegister, runWithAdmission } from './admission-scope';
import { Door } from './door';
import { isRefusal } from './session-retention';
import type { DoorRefusalReason } from './throttle-surfacing';
```

Add, after `theRetention`:

```ts
/** `null` once built and not configured; `undefined` before the first call. */
let door: Door | null | undefined;

/** The door, or `undefined` when no capacity is configured. */
export function theDoor(): Door | undefined {
  if (door === undefined) {
    const cfg = gatekeeperConfig();
    door =
      cfg.maxLiveSessions === undefined
        ? null
        : new Door({
            capacity: cfg.maxLiveSessions,
            queueLength: cfg.queueLength ?? cfg.maxLiveSessions,
            retention: theRetention(),
            onPressure: (depth, queueLength) =>
              cds.log('gatekeeper').warn('admission queue three quarters full', {
                depth,
                queueLength,
              }),
          });
  }
  return door ?? undefined;
}

/** A running pipeline's hold on its session, door or no door. */
export interface PipelineSession {
  /** Aborted by shutdown, and by nothing else. `undefined` with no door. */
  readonly signal: AbortSignal | undefined;
  /** Run the pipeline so that its calls register against this session. */
  run<T>(fn: () => T): T;
  /** Resolves when every registered call has settled. */
  drain(): Promise<void>;
  /** Last in teardown. Idempotent. */
  release(): void;
}

export type PipelineAdmission =
  | { admitted: PipelineSession }
  | { refused: DoorRefusalReason };

/**
 * Admit a pipeline for this user's session.
 *
 * With a door: waits in the queue or is refused. Without one: admitted at once,
 * and still leased and registered, so a logout waits for the run and teardown
 * waits for its calls.
 */
export async function admitPipeline(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<PipelineAdmission> {
  const d = theDoor();
  if (d) {
    const r = await d.admit(userId, sessionId, signal);
    if ('refused' in r) return r;
    const a = r.admitted;
    return {
      admitted: {
        signal: a.signal,
        run: (fn) => runWithAdmission(a, fn),
        drain: () => a.drain(),
        release: () => a.release(),
      },
    };
  }
  // Refused only when the session is already closing, which the middleware
  // makes rare: run without a lease rather than refuse where no limit is set.
  const lease = theRetention().lease(userId, sessionId, 'pipeline');
  const register = createCallRegister();
  let released = false;
  return {
    admitted: {
      signal: undefined,
      run: (fn) => runWithAdmission(register, fn),
      drain: () => register.drain(),
      release: () => {
        if (released) return;
        released = true;
        if (!isRefusal(lease)) lease.release();
      },
    },
  };
}
```

Make the three functions that free a place poke the door. Replace `leaseSession`, `deleteSession` and `forgetEmptySessions`:

```ts
export function leaseSession(
  userId: string,
  sessionId: string,
  kind: LeaseKind,
): Lease | LeaseRefusal {
  const lease = theRetention().lease(userId, sessionId, kind);
  if (isRefusal(lease)) return lease;
  return {
    kind: lease.kind,
    signal: lease.signal,
    release: () => {
      lease.release();
      // A place may have freed that a queued pipeline is waiting for.
      theDoor()?.poke();
    },
  };
}

export function deleteSession(userId: string, sessionId: string): Promise<void> {
  return theRetention()
    .close(userId, sessionId)
    .finally(() => theDoor()?.poke());
}

export function forgetEmptySessions(): number {
  const n = theRetention().forgetEmpty();
  if (n > 0) theDoor()?.poke();
  return n;
}
```

and extend `resetGatekeeperForTest`:

```ts
export function resetGatekeeperForTest(): void {
  door?.abortAll(new Error('test reset'));
  door = undefined;
  retention = undefined;
}
```

Wrapping `leaseSession` changes nothing for Task 6's callers: the returned object has the same `Lease` shape.

- [ ] **Step 5: Run, lint, commit**

```bash
npx jest test/unit/detached-sink.test.ts test/unit/gatekeeper-door.test.ts test/unit/retention-wiring.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/detached-sink.ts srv/lib/gatekeeper.ts test/unit/detached-sink.test.ts test/unit/gatekeeper-door.test.ts
git add srv/lib/detached-sink.ts srv/lib/gatekeeper.ts test/unit/detached-sink.test.ts test/unit/gatekeeper-door.test.ts
git commit -m "feat(gatekeeper): a detachable sink, and one admission call for every channel, door or no door"
```

---

### Task 11: Both chat channels — admitted after the agent, detached on disconnect, torn down in order

**Files:**
- Create: `test/unit/helpers/channel-harness.ts`
- Modify: `srv/openai-handler.ts` (the `res.on('close')` teardown at `:560-576`; admission before the pipeline `try`; `opts.signal`; the runs; writes through the sink; the `finally`)
- Modify: `srv/anthropic-handler.ts` (the same, at `:126-138`, before `agentOpts`, and the `finally`)
- Test: `test/unit/openai-channel.test.ts`, `test/unit/anthropic-channel.test.ts`

**Interfaces:**
- Consumes: `admitPipeline`, `PipelineSession`, `theDoor`, `resetGatekeeperForTest` (Task 10); `detachedSink` (Task 10); `openAiDoorRefusal`, `anthropicDoorRefusal` (Task 8); `trackCall` (Task 9); `clearGatekeeperConfig` (Task 4).
- Produces: nothing new for later tasks. The harness is reused by Task 12.

**Where admission sits.** After `getSmartAgent`. A caller waiting for a destination to warm, or for the shared tool corpus to build, waits outside the door holding an HTTP request and no session; that wait is already bounded by `LLM_AGENT_DESTINATION_INIT_WAIT_MS`.

**What a disconnect does now.** It detaches the sink and removes the caller from the queue if it is still waiting. It does not tear down the connection, and it does not reach the pipeline: the pipeline's signal is the admission's, which only shutdown aborts.

**Teardown order.** The pipeline returns, which is when it stops starting calls; then wait for the register to empty; then `safeStop`; then `dropRequest`; then release the slot, last. `safeStop` first would close the ADT session under a live write.

- [ ] **Step 1: The harness**

Create `test/unit/helpers/channel-harness.ts`:

```ts
/**
 * Drive a chat channel in-process: a fake request and response, and the agent,
 * connection and config seams mocked. Each test file wires the mocks with
 *
 *   jest.mock('../../srv/agent-manager', () => require('./helpers/channel-harness').agentManagerMock());
 *   jest.mock('../../srv/agent-config', () => require('./helpers/channel-harness').agentConfigMock());
 *   jest.mock('../../srv/lib/request-connection', () => require('./helpers/channel-harness').requestConnectionMock());
 *   jest.mock('../../srv/lib/ai-core-models', () => ({ getAvailableModels: async () => [] }));
 *
 * and a `@sap/cds` mock whose `context.user` is `harness.user`.
 */

type Chunk = { ok: true; value: Record<string, unknown> } | { ok: false; error: Error };

export const harness = {
  user: { id: 'alice', is: () => true, roles: ['MCP_Full'] } as {
    id: string;
    is: (r: string) => boolean;
    roles: string[];
  },
  events: [] as string[],
  seenOptions: [] as Array<Record<string, unknown>>,
  process: async (_messages: unknown, _opts: Record<string, unknown>): Promise<Chunk> => ({
    ok: true,
    value: { content: 'done', stopReason: 'stop' },
  }),
  stream: async function* (_messages: unknown, _opts: Record<string, unknown>): AsyncIterable<Chunk> {
    yield { ok: true, value: { content: 'done' } };
    yield { ok: true, value: { finishReason: 'stop' } };
  },
  reset() {
    harness.events = [];
    harness.seenOptions = [];
    harness.process = async () => ({ ok: true, value: { content: 'done', stopReason: 'stop' } });
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'done' } };
      yield { ok: true, value: { finishReason: 'stop' } };
    };
  },
};

const handle = {
  agent: {
    deps: { ragStores: {} },
    process: (m: unknown, o: Record<string, unknown>) => {
      harness.seenOptions.push(o);
      harness.events.push('pipeline');
      return harness.process(m, o);
    },
    streamProcess: (m: unknown, o: Record<string, unknown>) => {
      harness.seenOptions.push(o);
      harness.events.push('pipeline');
      return harness.stream(m, o);
    },
  },
  recMcp: { dropRequest: () => harness.events.push('dropRequest') },
};

export function agentManagerMock() {
  const { CollectionRegistry } = jest.requireActual('../../../srv/rag-collections');
  const registry = new CollectionRegistry();
  return {
    isAgentReady: () => true,
    getSmartAgent: async () => {
      harness.events.push('getSmartAgent');
      return handle;
    },
    getCurrentDestination: () => 'DEST',
    setSessionDestination: () => {},
    forgetSessionDestination: () => {},
    getCollectionRegistry: () => registry,
    getCurrentModel: () => 'm',
    getCurrentClassifierModel: () => 'm',
    getDestinationStates: () => [],
    getSharedHistoryRag: () => undefined,
    runWithRequestConnection: (_c: unknown, fn: () => unknown) => fn(),
    ExpositionFilteringRag: class {
      constructor(readonly inner: unknown) {}
    },
    // Mocked ahead of Tasks 15 and 18, which add these to the handlers' imports;
    // without them every channel test would break at Task 15.
    isDestinationClosed: () => false,
    retryAfterForDestination: () => undefined,
    closeDestination: () => {},
    knownDestinations: () => [],
  };
}

export function agentConfigMock() {
  return {
    isAiCoreConfigured: () => true,
    getAgentConfig: () => ({ llm: { model: 'm' }, mcp: { destination: 'DEST' }, agent: {} }),
  };
}

export function requestConnectionMock() {
  return {
    establishRequestConnection: async () => ({
      handled: false,
      connection: { id: 'conn' },
      dumpScope: undefined,
    }),
    safeStop: async () => {
      harness.events.push('safeStop');
    },
  };
}

export function fakeReq(body: unknown, sessionId = 's-1') {
  return {
    body,
    headers: { 'x-sap-destination': 'DEST', cookie: `clh_session=${sessionId}` },
    sessionId,
    sessionMinted: false,
    secure: false,
  };
}

export function fakeRes() {
  const closeListeners: Array<() => void> = [];
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '' as string,
    headersSent: false,
    writableEnded: false,
    writeHead(status: number, headers?: Record<string, string>) {
      r.statusCode = status;
      Object.assign(r.headers, headers ?? {});
      r.headersSent = true;
      return r;
    },
    setHeader(n: string, v: string) {
      r.headers[n] = v;
    },
    status(s: number) {
      r.statusCode = s;
      return r;
    },
    json(b: unknown) {
      r.body = JSON.stringify(b);
      r.headersSent = true;
      r.writableEnded = true;
      return r;
    },
    write(c: string) {
      r.body += c;
      return true;
    },
    end(c?: string) {
      if (c) r.body += c;
      r.writableEnded = true;
      return r;
    },
    on(event: string, fn: () => void) {
      if (event === 'close') closeListeners.push(fn);
      return r;
    },
    /** The client goes away before the response ends. */
    disconnect() {
      for (const fn of closeListeners) fn();
    },
  };
  return r;
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export const tick = () => new Promise((r) => setImmediate(r));
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/openai-channel.test.ts`:

```ts
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return { user: require('./helpers/channel-harness').harness.user };
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/agent-manager', () => require('./helpers/channel-harness').agentManagerMock());
jest.mock('../../srv/agent-config', () => require('./helpers/channel-harness').agentConfigMock());
jest.mock('../../srv/lib/request-connection', () =>
  require('./helpers/channel-harness').requestConnectionMock(),
);
jest.mock('../../srv/lib/ai-core-models', () => ({ getAvailableModels: async () => [] }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { trackCall } from '../../srv/lib/admission-scope';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { openAiDoorRefusal } from '../../srv/lib/throttle-surfacing';
import { handleChatCompletions } from '../../srv/openai-handler';
import { deferred, fakeReq, fakeRes, harness, tick } from './helpers/channel-harness';

function configure(live?: number, queue?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (queue === undefined) delete process.env.LLM_GATEKEEPER_QUEUE_LENGTH;
  else process.env.LLM_GATEKEEPER_QUEUE_LENGTH = String(queue);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

const body = (stream = false) => ({ model: 'm', stream, messages: [{ role: 'user', content: 'hi' }] });

function call(b: unknown, res = fakeRes(), sessionId = 's-1') {
  const done = handleChatCompletions(
    fakeReq(b, sessionId) as unknown as Request,
    res as unknown as Response,
  );
  return { res, done };
}

beforeEach(() => harness.reset());
afterEach(() => configure());

describe('/v1/chat/completions at the door', () => {
  it('refuses in the OpenAI envelope, with no Retry-After, after resolving the agent', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    void gatekeeper.admitPipeline('carol', 'queued');
    await tick();

    const { res, done } = call(body());
    await done;

    const refusal = openAiDoorRefusal('capacity');
    expect(res.statusCode).toBe(refusal.status);
    expect(JSON.parse(res.body)).toEqual(refusal.body);
    expect(res.headers['Retry-After']).toBeUndefined();
    expect(harness.events).toEqual(['getSmartAgent', 'safeStop']);
    if ('admitted' in hold) hold.admitted.release();
  });

  it('hands the pipeline the admission signal, not the caller', async () => {
    configure(2);
    const { done } = call(body());
    await done;
    expect(harness.seenOptions[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('a disconnect ends nothing, a dead socket cannot fail the run, and teardown is in order', async () => {
    configure(1);
    const tool = deferred();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      // A write chain in flight, registered as the embedded handler registers it.
      void trackCall(tool.promise.then(() => harness.events.push('tool settled')));
      yield { ok: true, value: { content: 'more' } };
      yield { ok: true, value: { finishReason: 'stop' } };
    };

    const res = fakeRes();
    const { done } = call(body(true), res);
    await tick();
    res.disconnect();
    await tick();
    expect(harness.events).not.toContain('safeStop');

    tool.resolve();
    await expect(done).resolves.toBeUndefined();
    expect(harness.events).toEqual([
      'getSmartAgent',
      'pipeline',
      'tool settled',
      'safeStop',
      'dropRequest',
    ]);
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });

  it('the slot outlives an aborted tool call', async () => {
    configure(1, 1);
    const tool = deferred();
    harness.process = async () => {
      // The library answered its caller; the ADT write underneath is still out.
      void trackCall(tool.promise);
      return { ok: true, value: { content: 'aborted', stopReason: 'stop' } };
    };
    const { done } = call(body());
    await tick();

    let admitted = false;
    const next = gatekeeper.admitPipeline('bob', 'next').then((r) => {
      admitted = true;
      return r;
    });
    await tick();
    expect(admitted).toBe(false);

    tool.resolve();
    await done;
    const r = await next;
    expect(admitted).toBe(true);
    if ('admitted' in r) r.admitted.release();
  });

  it('a caller that leaves while queued starts no pipeline', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    const res = fakeRes();
    const { done } = call(body(), res);
    await tick();
    res.disconnect();
    await done;
    expect(harness.events).not.toContain('pipeline');
    expect(harness.events).toContain('safeStop');
    if ('admitted' in hold) hold.admitted.release();
    expect(gatekeeper.theDoor()?.snapshot()).toMatchObject({ live: 0, queued: 0, left: 1 });
  });

  it('absent means no door: nothing refused, and teardown still waits for calls', async () => {
    configure();
    const tool = deferred();
    harness.process = async () => {
      void trackCall(tool.promise.then(() => harness.events.push('tool settled')));
      return { ok: true, value: { content: 'x', stopReason: 'stop' } };
    };
    const { res, done } = call(body());
    await tick();
    tool.resolve();
    await done;
    expect(res.statusCode).toBe(200);
    expect(harness.events.indexOf('tool settled')).toBeLessThan(harness.events.indexOf('safeStop'));
  });
});

describe('a shared corpus build holds no caller slot', () => {
  it('resolves the agent before admitting', () => {
    const src = readFileSync(join(__dirname, '../../srv/openai-handler.ts'), 'utf8');
    expect(src.indexOf('getSmartAgent(')).toBeLessThan(src.indexOf('admitPipeline('));
  });
});
```

Create `test/unit/anthropic-channel.test.ts` with the same five `jest.mock` calls and `configure`, and:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { trackCall } from '../../srv/lib/admission-scope';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { anthropicDoorRefusal } from '../../srv/lib/throttle-surfacing';
import { handleAnthropicMessages } from '../../srv/anthropic-handler';
import { deferred, fakeReq, fakeRes, harness, tick } from './helpers/channel-harness';

const body = (stream = false) => ({
  model: 'm',
  max_tokens: 100,
  stream,
  messages: [{ role: 'user', content: 'hi' }],
});

function call(b: unknown, res = fakeRes()) {
  const done = handleAnthropicMessages(fakeReq(b) as unknown as Request, res as unknown as Response);
  return { res, done };
}

beforeEach(() => harness.reset());
afterEach(() => configure());

describe('/v1/messages at the door', () => {
  it("refuses with Anthropic's overloaded_error under 529, and no Retry-After", async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    void gatekeeper.admitPipeline('carol', 'queued');
    await tick();
    const { res, done } = call(body());
    await done;
    const refusal = anthropicDoorRefusal('capacity');
    expect(res.statusCode).toBe(refusal.status);
    expect(JSON.parse(res.body)).toEqual(refusal.body);
    expect(res.headers['Retry-After']).toBeUndefined();
    if ('admitted' in hold) hold.admitted.release();
  });

  it('a disconnect ends nothing, and teardown waits for the call in flight', async () => {
    configure(1);
    const tool = deferred();
    harness.stream = async function* () {
      yield { ok: true, value: { content: 'working' } };
      void trackCall(tool.promise.then(() => harness.events.push('tool settled')));
      yield { ok: true, value: { finishReason: 'stop' } };
    };
    const res = fakeRes();
    const { done } = call(body(true), res);
    await tick();
    res.disconnect();
    await tick();
    expect(harness.events).not.toContain('safeStop');
    tool.resolve();
    await done;
    expect(harness.events.slice(-3)).toEqual(['tool settled', 'safeStop', 'dropRequest']);
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });

  it('resolves the agent before admitting', () => {
    const src = readFileSync(join(__dirname, '../../srv/anthropic-handler.ts'), 'utf8');
    expect(src.indexOf('getSmartAgent(')).toBeLessThan(src.indexOf('admitPipeline('));
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx jest test/unit/openai-channel.test.ts test/unit/anthropic-channel.test.ts`
Expected: FAIL — no refusal is written (the handlers never ask the door), and `safeStop` runs on disconnect.

- [ ] **Step 4: `/v1/chat/completions`**

In `srv/openai-handler.ts`, add imports:

```ts
import { detachedSink } from './lib/detached-sink';
import { admitPipeline, type PipelineSession } from './lib/gatekeeper';
```

and add `openAiDoorRefusal` to the `./lib/throttle-surfacing` import.

Replace the `res.on('close', ...)` block and its comment (`:560-576`) with:

```ts
  // A client disconnect ends nothing. Tearing the connection down on `close` is
  // the recorded cause of the orphaned ADT locks in SM12: nobody is waiting for
  // the answer, and SAP is waiting for the rest of the chain. So the sink is
  // detached — nothing written afterwards reaches the socket or fails the run —
  // and a caller still queued is removed from the queue.
  const out = detachedSink(res);
  const callerLeft = new AbortController();
  res.on('close', () => {
    if (res.writableEnded) return;
    log.info('Caller disconnected; the session runs to its end', { sessionId });
    out.detach();
    callerLeft.abort(new Error('caller disconnected'));
  });
```

Immediately before the line `  try {` that is followed by `    const pipelineLog = cds.log('smart-pipeline');`, insert:

```ts
  // Admitted after the agent is resolved: a caller waiting for a destination to
  // warm waits outside the door, holding a request and no session.
  let pipeline: PipelineSession;
  try {
    const admission = await admitPipeline(userId, sessionId, callerLeft.signal);
    if ('refused' in admission) {
      restoreRagStores();
      await safeStop(requestConnection);
      const refusal = openAiDoorRefusal(admission.refused);
      out.json(refusal.status, refusal.body);
      return;
    }
    pipeline = admission.admitted;
  } catch {
    // Left while queued. Nothing was started, so nothing is owed but the connection.
    restoreRagStores();
    await safeStop(requestConnection);
    return;
  }
```

In the `opts` object, after `sessionId,`, add:

```ts
      // The admission's signal, which only shutdown aborts. Not the caller's.
      signal: pipeline.signal,
```

Wrap both pipeline runs. The streaming one:

```ts
      await pipeline.run(() =>
        runWithSessionId(
          sessionId,
          () =>
            withRequestConnectionAuthorized(
              // ... unchanged ...
            ),
          priorTurns,
        ),
      );
```

and the non-streaming one:

```ts
    const result = await pipeline.run(() =>
      runWithSessionId(
        sessionId,
        () =>
          withRequestConnectionAuthorized(requestConnection, requestDumpScope, async () => {
            return handle.agent.process(normalizedMessages, opts);
          }),
        priorTurns,
      ),
    );
```

Route every write after admission through the sink:

```bash
python3 - <<'PY'
p = 'srv/openai-handler.ts'
s = open(p).read()
start = s.index("const pipelineLog = cds.log('smart-pipeline');")
end = s.index('export async function handleModels')
body = s[start:end]
for old, new in [
    ('if (!res.writableEnded) res.write(', 'out.write('),
    ('res.writeHead(', 'out.writeHead('),
    ('res.write(', 'out.write('),
    ('res.end(', 'out.end('),
]:
    body = body.replace(old, new)
open(p, 'w').write(s[:start] + body + s[end:])
PY
```

`res.on('close', () => clearInterval(keepAlive));` is deliberately left on `res`.

Replace the `finally` at the end of `handleChatCompletions`:

```ts
  } finally {
    restoreRagStores();
    // The pipeline has returned, so it starts no more calls. Wait for the ones it
    // started, then end the ADT session, then give the slot back — last.
    await pipeline.drain();
    await safeStop(requestConnection);
    // Free the per-trace telemetry bucket — nobody else calls dropRequest, so
    // omitting this leaks memory per request (Verified fact 10).
    (handle as unknown as HandleWithRecMcp)?.recMcp?.dropRequest(traceId);
    pipeline.release();
  }
```

- [ ] **Step 5: `/v1/messages`**

In `srv/anthropic-handler.ts`, add the same two imports and `anthropicDoorRefusal` to the `./lib/throttle-surfacing` import.

Replace the `res.on('close', ...)` block and its comment (`:126-138`) with the same block as in Step 4, logging `{ sessionId }`.

Immediately before `  const agentOpts = {`, insert:

```ts
  let pipeline: PipelineSession;
  try {
    const admission = await admitPipeline(userId, sessionId ?? traceId, callerLeft.signal);
    if ('refused' in admission) {
      await safeStop(requestConnection);
      const refusal = anthropicDoorRefusal(admission.refused);
      out.json(refusal.status, refusal.body);
      return;
    }
    pipeline = admission.admitted;
  } catch {
    await safeStop(requestConnection);
    return;
  }
```

In `agentOpts`, after `stream,`, add `signal: pipeline.signal,`.

`runAgent` becomes:

```ts
  const runAgent = <T>(fn: () => Promise<T>): Promise<T> =>
    pipeline.run(() =>
      runWithSessionId(
        undefined,
        () =>
          requestConnection
            ? runWithRequestConnection(requestConnection, fn, requestDumpScope, callerExposition)
            : fn(),
        priorTurns,
      ),
    );
```

Route the writes through the sink. The streaming branch:

- `res.writeHead(200, {` → `out.writeHead(200, {`
- `if (!res.writableEnded) res.write(': keep-alive\n\n');` → `out.write(': keep-alive\n\n');`
- `res.write(\`event: ${event.event}\ndata: ${event.data}\n\n\`);` → `out.write(\`event: ${event.event}\ndata: ${event.data}\n\n\`);`
- in the stream `catch`, `if (!res.writableEnded) { res.write(` → `out.write(` with the guard removed
- `res.end();` → `out.end();`

and the non-streaming result becomes:

```ts
    if (result.ok) {
      out.json(200, adapter.formatResult(result.value, context));
    } else {
      const limit = throttleOf(result.error);
      log.error('Agent processing failed', {
        error: result.error.message,
        throttled: limit?.reason,
      });
      if (limit) {
        const retryAfter = retryAfterHeader(result.error);
        if (retryAfter) out.setHeader('Retry-After', retryAfter);
        out.json(statusForError(result.error), anthropicErrorPayload(result.error));
      } else {
        out.json(500, adapter.formatError(result.error, context as ApiRequestContext));
      }
    }
```

Replace the `finally`:

```ts
  } finally {
    await pipeline.drain();
    await safeStop(requestConnection);
    (handle as unknown as HandleWithRecMcp)?.recMcp?.dropRequest(traceId);
    pipeline.release();
  }
```

The `Retry-After` kept here is the throttle one — an interval the server named — and not the door's, which has none.

- [ ] **Step 6: Run, lint, commit**

```bash
npx jest test/unit/openai-channel.test.ts test/unit/anthropic-channel.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/openai-handler.ts srv/anthropic-handler.ts test/unit/helpers/channel-harness.ts test/unit/openai-channel.test.ts test/unit/anthropic-channel.test.ts
git add srv/openai-handler.ts srv/anthropic-handler.ts test/unit/helpers/channel-harness.ts test/unit/openai-channel.test.ts test/unit/anthropic-channel.test.ts
git commit -m "feat(gatekeeper): chat channels admit after the agent, detach on disconnect, and tear down in order"
```

---

### Task 12: `execute_step` goes through the same door

**Files:**
- Modify: `srv/agent-mcp.ts` (the tool body becomes the exported `executeStep`; the door replaces the semaphore when configured)
- Test: `test/unit/execute-step-channel.test.ts`

**Interfaces:**
- Consumes: `admitPipeline`, `theDoor`, `PipelineSession`, `resetGatekeeperForTest` (Task 10); `executeStepDoorRefusal` (Task 8); `trackCall` (Task 9); the channel harness (Task 11).
- Produces:
  - `export interface StepCaller { userId: string; exposition: ExpositionLevel | undefined }`
  - `export async function executeStep(req: Request, caller: StepCaller, args: { destination?: string; task: string }): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }>`

**One counter, every channel.** `execute_step` spends the same memory as the chat channels, so with a capacity configured it counts against the same door. Two caps on one resource would each be wrong about the other, so the semaphore is off for this route whenever the door is on.

**Absent means today.** With no capacity, the semaphore of two stays exactly where it is, and `admitPipeline` still leases the session and registers calls.

**Its session.** Each call already mints `agent-step-<uuid>`, so parallel steps are parallel sessions — as they always were.

**Why the body is extracted.** `McpServer.registerTool` keeps its callbacks private. A function the callback delegates to can be driven by a test directly, which is the only way to assert what this channel sends.

- [ ] **Step 1: Write the failing test**

Create `test/unit/execute-step-channel.test.ts`:

```ts
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: {
      log: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      get context() {
        return { user: require('./helpers/channel-harness').harness.user };
      },
    },
  }),
  { virtual: true },
);
jest.mock('../../srv/env-setup', () => ({}));
jest.mock('../../srv/agent-manager', () => require('./helpers/channel-harness').agentManagerMock());
jest.mock('../../srv/lib/request-connection', () =>
  require('./helpers/channel-harness').requestConnectionMock(),
);
jest.mock('../../srv/connections/destinationResolver', () => ({
  resolveDestinationSapConfig: async () => ({
    proxyType: 'Internet',
    authenticationType: 'OAuth2JWTBearer',
    sapConfig: { authType: 'jwt' },
    destinationName: 'DEST',
  }),
}));
jest.mock('../../srv/connections/connectionFactory', () => ({
  createConnection: () => ({ connect: async () => {} }),
}));
jest.mock('../../srv/lib/responsible', () => ({ setRequestResponsible: () => {} }));
jest.mock('../../srv/lib/principal', () => ({ computeDumpScope: () => undefined }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { executeStep } from '../../srv/agent-mcp';
import { trackCall } from '../../srv/lib/admission-scope';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import { executeStepDoorRefusal } from '../../srv/lib/throttle-surfacing';
import { deferred, harness, tick } from './helpers/channel-harness';

function configure(live?: number, queue?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (queue === undefined) delete process.env.LLM_GATEKEEPER_QUEUE_LENGTH;
  else process.env.LLM_GATEKEEPER_QUEUE_LENGTH = String(queue);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

const req = { headers: { 'x-sap-destination': 'DEST' } } as unknown as Request;
const caller = { userId: 'alice', exposition: undefined };
const step = () => executeStep(req, caller, { task: 'read class ZCL_X' });

beforeEach(() => harness.reset());
afterEach(() => configure());

describe('execute_step at the door', () => {
  it('refuses with the prefixed line, after resolving the agent', async () => {
    configure(1, 1);
    const hold = await gatekeeper.admitPipeline('bob', 'busy');
    void gatekeeper.admitPipeline('carol', 'queued');
    await tick();
    const result = await step();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(executeStepDoorRefusal('capacity'));
    expect(harness.events).toEqual(['getSmartAgent', 'safeStop']);
    if ('admitted' in hold) hold.admitted.release();
  });

  it('counts against the one door, not a second cap', async () => {
    configure(3);
    const gates = [deferred(), deferred(), deferred()];
    let n = 0;
    harness.process = async () => {
      await gates[n++].promise;
      return { ok: true, value: { content: 'x' } };
    };
    const running = [step(), step(), step()];
    await tick();
    // Three at once: the semaphore of two is off while the door is on.
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(3);
    for (const g of gates) g.resolve();
    await Promise.all(running);
  });

  it('tears down in order: calls, then safeStop, then the slot', async () => {
    configure(1);
    const tool = deferred();
    harness.process = async () => {
      void trackCall(tool.promise.then(() => harness.events.push('tool settled')));
      return { ok: true, value: { content: 'done' } };
    };
    const running = step();
    await tick();
    expect(harness.events).not.toContain('safeStop');
    tool.resolve();
    await running;
    expect(harness.events.slice(-3)).toEqual(['tool settled', 'safeStop', 'dropRequest']);
    expect(gatekeeper.theDoor()?.snapshot().live).toBe(0);
  });
});

describe('absent means today', () => {
  it('keeps the semaphore of two', async () => {
    configure();
    const gates = [deferred(), deferred(), deferred()];
    let n = 0;
    harness.process = async () => {
      await gates[n++].promise;
      return { ok: true, value: { content: 'x' } };
    };
    const running = [step(), step(), step()];
    await tick();
    expect(harness.events.filter((e) => e === 'pipeline')).toHaveLength(2);
    for (const g of gates) g.resolve();
    await Promise.all(running);
  });

  it('still resolves the agent before admitting', () => {
    const src = readFileSync(join(__dirname, '../../srv/agent-mcp.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function executeStep'));
    expect(body.indexOf('getSmartAgent(')).toBeLessThan(body.indexOf('admitPipeline('));
  });
});
```

The `pipeline` event fires for the gated third call only after one of the first two releases; the gates above resolve in order, so the test waits on all three.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/execute-step-channel.test.ts`
Expected: FAIL — `executeStep` is not exported.

- [ ] **Step 3: Extract the body and put it behind the door**

In `srv/agent-mcp.ts`, add imports:

```ts
import type { ExpositionLevel } from './lib/exposition';
import { admitPipeline, type PipelineSession, theDoor } from './lib/gatekeeper';
```

and add `executeStepDoorRefusal` to the `./lib/throttle-surfacing` import.

Replace the comment above `EXEC_STEP_MAX_CONCURRENCY` with:

```ts
/**
 * The cap on concurrent `execute_step` runs when no door is configured.
 *
 * The ancestor of the gatekeeper's door: parallel steps each spike memory, and
 * an unbounded fan-out OOMed a 1 GB container. With `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`
 * set, this route counts against the shared door instead and the semaphore is
 * not taken — two caps on one resource would each be wrong about the other.
 */
```

Add, after `textResult`:

```ts
export interface StepCaller {
  userId: string;
  exposition: ExpositionLevel | undefined;
}

/** One `execute_step` call. The tool callback delegates here so a test can drive it. */
export async function executeStep(
  req: Request,
  caller: StepCaller,
  { destination, task }: { destination?: string; task: string },
) {
  const log = cds.log('agent-mcp');
  const { userId, exposition } = caller;
  // With a door, this route counts against it; without one, today's semaphore.
  const releaseSemaphore = theDoor() ? undefined : await execStepSemaphore.acquire();
  let connection: IAbapConnection | undefined;
  let handle: Awaited<ReturnType<typeof getSmartAgent>> | undefined;
  let traceId: string | undefined;
  let pipeline: PipelineSession | undefined;
  try {
    // ... the existing body of the `try`, from `// Destination from the arg, else
    // the connection's default header.` down to `handle = await getSmartAgent(...)`
    // and `const agentHandle = handle;`, unchanged ...

    const sessionId = `agent-step-${randomUUID()}`;
    traceId = sessionId;

    // Admitted after the agent is resolved, like every channel.
    const admission = await admitPipeline(userId, sessionId);
    if ('refused' in admission) {
      return textResult(executeStepDoorRefusal(admission.refused), true);
    }
    pipeline = admission.admitted;
    const admitted = pipeline;

    const opts = {
      // ... the existing opts, unchanged, plus:
      signal: admitted.signal,
    };

    const conn = connection;
    const r = await admitted.run(() =>
      runWithSessionId(sessionId, () =>
        runWithRequestConnection(
          conn,
          () => agentHandle.agent.process([{ role: 'user', content: task }], opts),
          dumpScope,
          exposition,
        ),
      ),
    );

    // ... the existing handling of `r`, unchanged ...
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('execute_step failed', { destination, error: message });
    return textResult(`ERROR: ${message}`, true);
  } finally {
    // Wait for the calls this step started, then end the ADT session, then
    // release — the slot last, and the semaphore with it.
    await pipeline?.drain();
    await safeStop(connection);
    (handle as unknown as HandleWithRecMcp)?.recMcp?.dropRequest(traceId);
    pipeline?.release();
    releaseSemaphore?.();
  }
}
```

`sessionId` and `traceId` move up from their old place inside the `try` so that `admitPipeline` has the session; delete the old `const sessionId = ...` and `traceId = sessionId;` lines further down. The `if (execStepSemaphore.active >= ...)` queued-log block is deleted with the old acquisition.

In `createAgentMcpServerForRequest`, the `execute_step` registration's callback becomes:

```ts
    async (args: { destination?: string; task: string }) =>
      executeStep(req, { userId, exposition }, args),
```

- [ ] **Step 4: Run, lint, commit**

```bash
npx jest test/unit/execute-step-channel.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/agent-mcp.ts test/unit/execute-step-channel.test.ts
git add srv/agent-mcp.ts test/unit/execute-step-channel.test.ts
git commit -m "feat(gatekeeper): execute_step counts against the one door, and keeps its semaphore only without one"
```

---

### Task 13: Shutdown ends admitted work, and a `429` with an interval does not

**Files:**
- Modify: `srv/lib/gatekeeper.ts` (`shutdownGatekeeper`)
- Modify: `srv/server.ts` (the shutdown hook)
- Modify: `srv/agent-config.ts` (the strategy follows the door)
- Test: `test/unit/gatekeeper-shutdown.test.ts`, `test/unit/throttle-choice.test.ts`

**Interfaces:**
- Consumes: `theDoor`, `admitPipeline` (Task 10); `gatekeeperConfig` (Task 4); `WaitAsTold` from `@mcp-abap-adt/llm-agent`.
- Produces:
  - `export function shutdownGatekeeper(): void`

**Only shutdown ends an admitted session.** It aborts every live admission's controller and rejects every waiter. It is the one place teardown may be best-effort: it does not wait for the register before the process exits.

**Why `WaitAsTold` with a door.** The door now protects capacity, so a ceiling behind it would only kill work in flight — and `WaitIfShortEnough`'s twenty seconds is shorter than most intervals SAP AI Core names. An admitted session waits out exactly what the server named. A `429` naming no interval leaves nothing to wait out and fails the session: the one hole in the guarantee, asserted so it stays a decision.

**Why `WaitIfShortEnough` without a door.** Nothing is admitted, and an unbounded wait would hold a connection the client cuts at about a minute. Absent means today. (Decision 2 in the header.)

- [ ] **Step 1: Write the failing tests**

Create `test/unit/gatekeeper-shutdown.test.ts`:

```ts
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
  getRequestHistory: () => [],
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
});

describe('shutdown', () => {
  it('aborts every admitted session and every waiter', async () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '1';
    clearGatekeeperConfig();
    gatekeeper.resetGatekeeperForTest();
    const first = await gatekeeper.admitPipeline('u', 'A');
    if (!('admitted' in first)) throw new Error('refused');
    const waiting = gatekeeper.admitPipeline('u', 'B');
    waiting.catch(() => {});

    expect(first.admitted.signal?.aborted).toBe(false);
    gatekeeper.shutdownGatekeeper();
    expect(first.admitted.signal?.aborted).toBe(true);
    await expect(waiting).rejects.toThrow('shutdown');
  });

  it('is a no-op with no door', () => {
    expect(() => gatekeeper.shutdownGatekeeper()).not.toThrow();
  });

  it('is hooked to CAP shutdown', () => {
    const src = readFileSync(join(__dirname, '../../srv/server.ts'), 'utf8');
    expect(src).toMatch(/cds\.on\(\s*'shutdown'[\s\S]{0,120}shutdownGatekeeper\(\)/);
  });
});
```

Create `test/unit/throttle-choice.test.ts`:

```ts
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import { WaitAsTold } from '@mcp-abap-adt/llm-agent';
import { loadAgentConfig } from '../../srv/agent-config';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';

afterEach(() => {
  delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  clearGatekeeperConfig();
});

describe('the throttle strategy follows the door', () => {
  it('waits as told when a door protects capacity', () => {
    process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = '4';
    expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-as-told');
  });

  it('keeps the ceiling with no door, as today', () => {
    expect(loadAgentConfig().llm.whenThrottled.name).toBe('wait-if-short-enough');
  });
});

describe('an admitted session and a 429', () => {
  const strategy = new WaitAsTold();
  const ctx = (retryAfterSeconds?: number) =>
    ({ attempt: 1, retryAfterSeconds, waitedMs: 0, source: 'response' }) as Parameters<
      WaitAsTold['decide']
    >[0];

  it('waits out exactly what the server named, past the old twenty-second ceiling', () => {
    expect(strategy.decide(ctx(45))).toMatchObject({ retry: true, waitMs: 45_000 });
  });

  it('fails when the server named no interval — the one hole, kept a decision', () => {
    expect(strategy.decide(ctx(undefined)).retry).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest test/unit/gatekeeper-shutdown.test.ts test/unit/throttle-choice.test.ts`
Expected: FAIL — `shutdownGatekeeper` is not exported; with the door set the strategy is still `wait-if-short-enough`.

- [ ] **Step 3: The shutdown**

In `srv/lib/gatekeeper.ts`:

```ts
/**
 * End every admitted session and every waiter. The only thing that does.
 *
 * Best-effort by necessity: it aborts and returns without waiting for the
 * register, because the process is exiting.
 */
export function shutdownGatekeeper(): void {
  theDoor()?.abortAll(new Error('shutdown'));
}
```

In `srv/server.ts`, import `shutdownGatekeeper` from `./lib/gatekeeper` and add at module level, next to the `cds.on('served', ...)` block:

```ts
// Only shutdown ends an admitted session.
cds.on('shutdown', () => shutdownGatekeeper());
```

- [ ] **Step 4: The strategy**

In `srv/agent-config.ts`, add `WaitAsTold` to the `@mcp-abap-adt/llm-agent` imports and replace:

```ts
  const throttleStrategy = new WaitIfShortEnough(readThrottleMaxWaitMs());
```

and its comment with:

```ts
  // With a door, an admitted session is carried to the end: it waits out exactly
  // what the server named, and a ceiling behind the door would only kill work in
  // flight. With no door nothing is admitted, and the ceiling still keeps a wait
  // shorter than the client's own timeout.
  const throttleStrategy =
    gatekeeper.maxLiveSessions !== undefined
      ? new WaitAsTold()
      : new WaitIfShortEnough(readThrottleMaxWaitMs());
```

`gatekeeper` is the value Task 4 reads at the top of `loadAgentConfig`. Add to the startup log beside `throttleMaxWaitMs`:

```ts
    // Meaningless once the door is on, and said so rather than printed as if it applied.
    throttleMaxWaitMs:
      gatekeeper.maxLiveSessions !== undefined ? 'not applied (door on)' : readThrottleMaxWaitMs(),
```

replacing the existing `throttleMaxWaitMs: readThrottleMaxWaitMs(),` line.

- [ ] **Step 5: Run, lint, commit**

```bash
npx jest test/unit/gatekeeper-shutdown.test.ts test/unit/throttle-choice.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/gatekeeper.ts srv/server.ts srv/agent-config.ts test/unit/gatekeeper-shutdown.test.ts test/unit/throttle-choice.test.ts
git add srv/lib/gatekeeper.ts srv/server.ts srv/agent-config.ts test/unit/gatekeeper-shutdown.test.ts test/unit/throttle-choice.test.ts
git commit -m "feat(gatekeeper): shutdown ends admitted work, and behind a door a 429 waits as told"
```

---

## Phase 4 — a dependency that is down

### Task 14: Tell an outage from a tool that failed

**Files:**
- Create: `srv/lib/mcp-outage.ts`
- Modify: `srv/agent-manager.ts` (the dispatch helper, the raise and the builder wiring), `srv/connections/CloudSdkAbapConnection.ts` (ask about a plain network failure), `srv/lib/probe-classifier.ts` (recognise one)
- Test: `test/unit/mcp-outage.test.ts`, `test/unit/probe-classifier-network.test.ts`

**Interfaces:**
- Consumes: `ProbeStatus` from `srv/lib/probe-classifier.ts`, whose verdict `CloudSdkAbapConnection` has already written into the message, and `isMcpUnavailable` from `@mcp-abap-adt/llm-agent`.
- Produces:
  - `export const OUTAGE_STATUSES: ReadonlySet<ProbeStatus>`
  - `export function asOutage(error: unknown, destination: string): McpUnavailableError | undefined` — the connector's failure, classified, or nothing
  - `export class McpUnavailableError extends Error { readonly code = 'mcp_unavailable'; readonly destination: string; readonly status: ProbeStatus }`
  - `export function isUnavailable(error: unknown): boolean` — our typed marker, valid only **before** the embedded wrapper
  - `export function isOutageError(error: unknown): boolean` — for everything **after** it, where only a mapped `McpError` survives
  - `export const OUTAGE_MCP_CODES: ReadonlySet<string>`
  - `export function describeCause(error: unknown): string`
  - `export const outageClassifier: IMcpFailureClassifier`

**The connector already catches it, classifies it, and writes the verdict
down.** When the SAP system goes away it is the connection layer that sees the
failure, and `CloudSdkAbapConnection` puts it through `classifyProbe` and
appends `[tunnel_timeout]`, `[dns_or_network]` and the rest to the error's own
message. That tag is the fact, and this task reads it. Re-deriving
unreachability here — from a fresh list of substrings, or by calling
`classifyProbe` a second time without the response object or the proxy type
that the first call had — would be a worse copy of a verdict that already
exists, and the two would disagree under exactly the conditions that matter.

So this task adds no detection. It adds **preservation** — carrying a fact the
connector already established across a boundary that drops it.

**The boundary.** This service builds its MCP client with
`transport: 'embedded'` and its own `callToolHandler`, and the embedded branch
of `MCPClientWrapper` neither reconnects nor retries: it catches the handler's
exception and returns an ordinary tool result carrying an `error` **string**.
The class, the `code` and the `cause` do not survive. `McpClientAdapter` then
escalates a returned error only when `toMcpError` recognises that string as
`MCP_NOT_CONNECTED` or `MCP_NO_RESPONSE`; everything else stays tool feedback
and no classifier is consulted at all.

**Which statuses mean the system is gone**, and which do not — the distinction
is the whole point, because escalating the wrong one closes a destination that
is working:

| `ProbeStatus` | Outage? |
|---|---|
| `tunnel_timeout`, `no_scc_registration`, `wrong_location_id`, `dns_or_network` | **yes** — nothing reached SAP |
| `backend_auth_failed` | no — the system answered, and said no |
| `backend_reachable_path_error` | no — the name says it |
| `backend_error` | no — SAP ran something and failed |
| `ok`, `unknown` | no |

**And "SAP system" means two different things here.** The one above is the
**ABAP** system, reached through the connector and exposed through MCP, and a
destination is exactly the unit that can be closed when it goes away. The other
is **BTP itself** — the platform this service runs on, and the source of AI
Core, XSUAA, the destination service and the connectivity service.

A BTP-side failure is not a destination problem and must not be reported as
one:

- **AI Core down.** The model calls fail. That error never passes through
  `classifyProbe` at all — it comes up the provider path and is not a `429`, so it surfaces as the failure it is. Nothing is
  closed, because there is no destination to close: every destination is
  equally affected and none is at fault.
- **The destination service down.** Resolution fails before admission, so
  callers are refused without taking a place. That is the existing
  `destination_unreachable` answer and it already works; what would be wrong is
  marking every destination closed on the way past.
- **The connectivity service down.** Every on-premise destination goes
  unreachable at once and each closes on its own account. Correct, and noisy:
  the shared cause is invisible in the per-destination view, which is a real
  gap and a named one.

None of that is built here. This task closes an ABAP system that has gone away,
which is the failure the gatekeeper's own guarantee has to survive. Recognising
a platform-wide outage as one thing rather than N is separate work, and the
observability scopes in Task 18 are where it would show first — every
destination closing within the same few seconds.

- [ ] **Step 1: Write the failing test**

Create `test/unit/mcp-outage.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asOutage,
  isOutageError,
  isUnavailable,
  McpUnavailableError,
  outageClassifier,
} from '../../srv/lib/mcp-outage';

describe('telling an outage from a tool that ran and failed', () => {
  it('recognises our own unavailability marker', () => {
    expect(
      isUnavailable(new McpUnavailableError('S4HANA_DEV', 'tunnel down', 'tunnel_timeout')),
    ).toBe(true);
  });

  it('survives being rewrapped, because every layer rewraps', () => {
    const inner = new McpUnavailableError('S4HANA_DEV', 'tunnel down', 'tunnel_timeout');
    const outer = new Error('Tool execution failed');
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(isUnavailable(outer)).toBe(true);
  });

  it('leaves domain feedback alone', () => {
    // A tool's own "forbidden" or "currently editing" is feedback, not an
    // outage, and escalating it would close a destination that is fine.
    expect(isUnavailable(new Error('User DEVELOPER is currently editing ZCL_X'))).toBe(false);
    expect(isUnavailable(new Error('403 Forbidden'))).toBe(false);
    expect(isUnavailable(new Error('The operation timed out'))).toBe(false);
  });
});

describe('asOutage — the connector decides, through the classifier we already have', () => {
  it('marks a failure the connector tagged as never having reached SAP', () => {
    // The tag is what the connector wrote; this reads it rather than guessing
    // again from the prose around it.
    const err = new Error('connect ECONNRESET 10.0.0.1:44300 [tunnel_timeout]');
    const outage = asOutage(err, 'S4HANA_DEV');
    expect(outage).toBeDefined();
    expect(outage?.destination).toBe('S4HANA_DEV');
    // The original survives verbatim, which is what carries the signature
    // across the wrapper's string-only return.
    expect(outage?.message).toContain('ECONNRESET');
  });

  it('leaves an authentication failure alone, because SAP answered', () => {
    // The system is up and said no. Closing it would take a working
    // destination out of service for everyone over one caller's credentials.
    expect(asOutage(new Error('401 Unauthorized [backend_auth_failed]'), 'D')).toBeUndefined();
  });

  it('leaves a backend error alone, because SAP ran something', () => {
    expect(asOutage(new Error('500 [backend_error]'), 'D')).toBeUndefined();
  });

  it('says nothing when the connector tagged nothing', () => {
    // No tag means the connector did not classify this as a connectivity
    // problem at all — a tool-level failure, most often.
    expect(asOutage(new Error('object ZCL_X not found'), 'D')).toBeUndefined();
  });

  it('closes on transport codes and not on ones the server answered', () => {
    const { McpError } = require('@mcp-abap-adt/llm-agent') as typeof import('@mcp-abap-adt/llm-agent');
    const closes = ['MCP_NOT_CONNECTED', 'MCP_NO_RESPONSE', 'MCP_TIMEOUT', 'MCP_HTTP_503'];
    for (const code of closes) {
      expect(isOutageError(new McpError('x', code))).toBe(true);
    }
    // In the library's unavailable set, deliberately not in ours: a 403 is an
    // authorisation verdict and a 404 is a path. The server answered.
    for (const code of ['MCP_HTTP_403', 'MCP_HTTP_404']) {
      expect(isOutageError(new McpError('x', code))).toBe(false);
    }
  });

  it('classifies for the library seam, which is async and takes an McpError', async () => {
    const { McpError } = require('@mcp-abap-adt/llm-agent') as typeof import('@mcp-abap-adt/llm-agent');
    const down = new McpError('no response from S4HANA_DEV', 'MCP_NO_RESPONSE');
    const feedback = new McpError('object ZCL_X not found', 'MCP_ERROR');
    await expect(outageClassifier.classify(down)).resolves.toBe('unavailable');
    await expect(outageClassifier.classify(feedback)).resolves.toBe('tool-error');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/mcp-outage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the classifier**

Create `srv/lib/mcp-outage.ts`:

```ts
import { isMcpUnavailable } from '@mcp-abap-adt/llm-agent';
import type {
  IMcpFailureClassifier,
  McpError,
  McpFailureKind,
} from '@mcp-abap-adt/llm-agent';
import type { ProbeStatus } from './probe-classifier';

/**
 * The connection is gone, as distinct from a tool that ran and failed.
 *
 * The distinction cannot rest on how a message happens to read. A tool's own
 * "forbidden", "timed out" or "currently editing" is domain feedback: escalating
 * it would close a destination that is working. So the handler raises this type
 * deliberately, and everything else stays feedback.
 */
export class McpUnavailableError extends Error {
  readonly code = 'mcp_unavailable';
  constructor(
    readonly destination: string,
    reason: string,
    readonly status: ProbeStatus,
    options?: { cause?: unknown },
  ) {
    // The wording is not cosmetic. On the embedded transport the wrapper
    // catches this and returns only `error.message` as a string — the class,
    // the code and the cause are all dropped — and `McpClientAdapter` escalates
    // a returned error only when `toMcpError` recognises it as
    // MCP_NOT_CONNECTED or MCP_NO_RESPONSE. Anything else stays ordinary tool
    // feedback and the classifier is never consulted at all.
    //
    // So the message carries two things: the underlying cause verbatim, which
    // is where a real ECONNRESET, EHOSTUNREACH or "socket hang up" survives,
    // and the phrase "no response from", which is both true of a system we
    // could not reach and one of the signatures that mapper knows.
    super(`no response from SAP system ${destination}: ${reason}`, options);
    this.name = 'McpUnavailableError';
  }
}

/**
 * The statuses that mean nothing reached SAP.
 *
 * Not a new judgement: `classifyProbe` already draws these lines for
 * `ProbeDestination` and for the `destination_unreachable` answer the chat
 * handlers give. All this does is say which of its verdicts close a
 * destination. An auth failure does not — the system answered, and said no —
 * and neither does a path error or a backend error, both of which mean SAP ran
 * something.
 */
export const OUTAGE_STATUSES: ReadonlySet<ProbeStatus> = new Set([
  'tunnel_timeout',
  'no_scc_registration',
  'wrong_location_id',
  'dns_or_network',
]);

/**
 * Read the verdict the connector already reached, and mark it only if it means
 * the system is gone.
 *
 * `CloudSdkAbapConnection` classifies its own failures and appends `[status]`
 * to the message (`srv/connections/CloudSdkAbapConnection.ts`). Reading that
 * tag is the point: calling `classifyProbe` again from here would re-classify
 * with fields this side does not have — the real HTTP status lives at
 * `error.response.status`, not `error.status`, and the proxy type is not on the
 * error at all — so the second verdict would sometimes disagree with the first,
 * and the one with less information would win.
 *
 * The message keeps the original verbatim, which is where a real ECONNRESET or
 * "socket hang up" survives the string-only crossing described above.
 */
export function asOutage(
  error: unknown,
  destination: string,
): McpUnavailableError | undefined {
  const message = describeCause(error);
  const tagged = /\[([a-z_]+)\]/.exec(message);
  const status = tagged?.[1] as ProbeStatus | undefined;
  if (!status || !OUTAGE_STATUSES.has(status)) return undefined;
  return new McpUnavailableError(destination, message, status, { cause: error });
}

const MAX_CAUSE_DEPTH = 5;

/** The marker, on the error or anywhere in its cause chain. */
export function isUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof cur !== 'object' || cur === null || seen.has(cur)) return false;
    seen.add(cur);
    if ((cur as { code?: unknown }).code === 'mcp_unavailable') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** The library's seam for the fact. The decision stays ours. */
/**
 * The library's seam for the fact. The decision stays ours.
 *
 * `classify` is **async** and takes an `McpError` — the shape the adapter has
 * already mapped the failure into — not a bare `Error`. It also offers
 * `probeHealth`, which this implementation does not use: an outage we have
 * already identified needs no second opinion, and probing here would put a
 * network call on a failure path.
 */
/**
 * The mapped codes that close a destination.
 *
 * The library's `MCP_UNAVAILABLE_CODES` is close but not the same list, and the
 * difference is deliberate rather than an oversight in either place. That set
 * answers "did this fail at the transport level", and includes `MCP_HTTP_403`
 * and `MCP_HTTP_404` — which for us mean the server **answered**: a 403 is an
 * authorisation verdict and a 404 is a path. Closing a destination on either
 * would take a working system out of service for every caller because one
 * request was wrong.
 *
 * So the library establishes the fact and this narrows it, which is the same
 * division of labour as everywhere else in this design.
 */
export const OUTAGE_MCP_CODES: ReadonlySet<string> = new Set([
  'MCP_NOT_CONNECTED',
  'MCP_NO_RESPONSE',
  'MCP_TIMEOUT',
  'MCP_TRANSPORT',
  'MCP_HTTP_502',
  'MCP_HTTP_503',
]);

/**
 * Whether a failure that has already crossed the wrapper means the system is
 * gone.
 *
 * This is the **downstream** predicate, and it exists because `isUnavailable`
 * cannot work here. Our typed marker does not survive the embedded transport —
 * the wrapper keeps only `error.message` — so by the time a handler reads
 * `result.error` there is an `McpError` with a mapped code and nothing else.
 * A handler asking `isUnavailable` would find no marker and close nothing,
 * which is precisely how this path failed silently.
 */
export function isOutageError(error: unknown): boolean {
  if (isUnavailable(error)) return true;
  return (
    isMcpUnavailable(error) &&
    OUTAGE_MCP_CODES.has((error as McpError).code)
  );
}

export const outageClassifier: IMcpFailureClassifier = {
  async classify(error: McpError): Promise<McpFailureKind> {
    return isOutageError(error) ? 'unavailable' : 'tool-error';
  },
};

/**
 * A short reason for a log line or a closed-destination record.
 *
 * Defined here because the three channels need the same one and none of them
 * has it: an earlier draft of this plan called `describeCause` an existing
 * helper, and there is no such symbol anywhere in `srv/`.
 */
export function describeCause(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

- [ ] **Step 4: Let the connector tag a plain network failure**

`CloudSdkAbapConnection` classifies only what already looks tunnel-shaped:
`httpCode >= 500` or a message matching `tunnel|SCC|Cloud Connector|Anmeldung|
Logon` (`srv/connections/CloudSdkAbapConnection.ts`). A bare `ENOTFOUND`,
`ECONNREFUSED`, `ECONNRESET` or `socket hang up` passes through untagged — and
those are the ordinary shapes of a system that has gone away. Reading a tag
that is never written would make this whole path work only for the failures
that announce themselves.

**Two files, not one.** The connector decides *whether to ask*; the classifier
decides *what the answer is*. Widening only the first would ask about errors the
second still reads as `unknown`, so no tag would be written and `asOutage` would
go on seeing nothing. `srv/lib/probe-classifier.ts:118` currently knows
`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN` and `getaddrinfo` — not
`ECONNRESET`, `EHOSTUNREACH`, `ENETUNREACH` or `socket hang up`.

First the classifier:

```ts
  if (
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up/i.test(
      msg,
    )
  ) {
    return {
      status: 'dns_or_network',
      hint: 'Backend host is unresolvable, refused TCP, or dropped the connection — check destination URL and on-premise network.',
    };
  }
```

with its own test, in `test/unit/probe-classifier-network.test.ts`:

```ts
import { classifyProbe } from '../../srv/lib/probe-classifier';

describe('classifyProbe — the plain shapes of a host that is gone', () => {
  for (const signature of [
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'socket hang up',
  ]) {
    it(`reads ${signature} as a network failure`, () => {
      expect(classifyProbe(0, `connect ${signature} 10.0.0.1:44300`, 'OnPremise').status)
        .toBe('dns_or_network');
    });
  }

  it('still leaves a backend answer alone', () => {
    // The host answered; it simply said no. Reading this as a network failure
    // would close a destination that is working.
    expect(classifyProbe(401, 'Unauthorized', 'OnPremise').status).not.toBe(
      'dns_or_network',
    );
  });
});
```

Then the connector, in the place that has the response object and knows the
proxy type. **The two lists must hold the same signatures** — a code the
classifier recognises but the connector never asks about is a code that closes
nothing, which is the whole of the failure this step exists to end:

```ts
        const looksTunnelRelated =
          httpCode >= 500 ||
          /tunnel|SCC|Cloud Connector|Anmeldung|Logon/i.test(rawMessage) ||
          // The plain shapes of a host that is not there. classifyProbe already
          // reads these as dns_or_network; it was simply never asked.
          /ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up/i.test(
            rawMessage,
          );
```

and assert it, in `test/unit/mcp-outage.test.ts`:

```ts
describe('the connector tags the failures it sees', () => {
  it('classifies a bare network error, not only a tunnel-shaped one', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/connections/CloudSdkAbapConnection.ts'),
      'utf8',
    );
    // Without this the tag is never written for the commonest outage of all,
    // and everything downstream reads an absence as "not an outage".
    expect(source).toMatch(/ECONNREFUSED/);
    expect(source).toMatch(/socket hang up/);
  });
});
```

- [ ] **Step 5: Raise it from the handler**

In `srv/agent-manager.ts`, `invokeEmbeddedTool` already registers the dispatch (Task 14: `await trackCall(Promise.resolve(toolCall))`) and already has a `catch (err)` that logs and rethrows. Classify on the way out, in that same `catch` — replace its final `throw err;` with:

```ts
      // The connector has already decided what happened and written its verdict
      // into the message; this re-raises it in a form that survives the
      // embedded wrapper's string-only return.
      throw asOutage(err, destinationName) ?? err;
```

and add `import { asOutage, outageClassifier } from './lib/mcp-outage';`. The registration and the classification wrap the same promise: registered before it is awaited, classified after it comes back.

`destinationName` is the closure the embedded adapter builder already has — the destination this adapter was built for. `connectionALS` carries `connection`, `context`, `dumpScope` and `exposition` but no destination, so it is not the source.

> Do not widen `OUTAGE_STATUSES`. A tool that reached SAP and was refused is
> feedback, and closing a destination on it would take a working system out of
> service for every caller.

- [ ] **Step 6: Wire it to the builder**

A strategy nothing installs is dead code, and the pipeline would go on using
`DefaultMcpFailureClassifier`. In `srv/agent-manager.ts`, on the builder that
constructs each destination's agent (`buildAgentForDestination`), add it beside
the other consumer-owned seams:

```ts
    .withMcpFailureClassifier(outageClassifier)
```

and assert it, in `test/unit/mcp-outage.test.ts`:

```ts
describe('the classifier is installed, not merely written', () => {
  it('is handed to the builder', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/agent-manager.ts'),
      'utf8',
    );
    expect(source).toMatch(/withMcpFailureClassifier\(\s*outageClassifier\s*\)/);
  });
});
```

- [ ] **Step 7: Run, lint, commit**

```bash
npx jest test/unit/mcp-outage.test.ts test/unit/probe-classifier-network.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/mcp-outage.ts srv/lib/probe-classifier.ts srv/agent-manager.ts srv/connections/CloudSdkAbapConnection.ts test/unit/mcp-outage.test.ts test/unit/probe-classifier-network.test.ts
git add srv/lib/mcp-outage.ts srv/lib/probe-classifier.ts srv/agent-manager.ts srv/connections/CloudSdkAbapConnection.ts test/unit/mcp-outage.test.ts test/unit/probe-classifier-network.test.ts
git commit -m "feat(outage): a lost connection is raised as one, not left to read like one"
```

---

### Task 15: A closed destination, and a `Retry-After` that is true

**Files:**
- Modify: `srv/agent-manager.ts` (destination state gains `nextProbeAt`; the probe scheduler records it), `srv/lib/throttle-surfacing.ts` (the refusal)
- Test: `test/unit/destination-closed.test.ts`, `test/unit/destination-close-wiring.test.ts`

**Interfaces:**
- Consumes: `isUnavailable` from Task 14.
- Produces:
  - `export function closeDestination(name: string, reason: string): void` in `agent-manager`
  - `export function retryAfterForDestination(name: string, now?: number): number | undefined`
  - `export function destinationClosedText(name: string): string` in `throttle-surfacing`

**The number:** not the probe interval. The retry today is one process-wide `setInterval`, whose phase has nothing to do with when any particular destination failed, so a caller refused a second before a tick would be told to wait five minutes while the recheck happens immediately. The scheduler records `nextProbeAt` per destination and the header is the remainder, rounded up. With nothing scheduled there is no header.

- [ ] **Step 1: Write the failing test**

Create `test/unit/destination-closed.test.ts`:

```ts
const load = () => {
  jest.resetModules();
  return require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
};

let current: ReturnType<typeof load> | undefined;

afterEach(() => {
  // closeDestination arms a five-minute probe timer. Left running, Jest either
  // reports an open handle or waits on it after the suite has finished.
  current?.clearDestinationStatesForTest();
  current = undefined;
  jest.resetModules();
});

describe('a closed destination', () => {
  it('reports the remainder to the next probe, not the whole interval', () => {
    const mod = load();
    current = mod;
    const now = 1_000_000;
    mod.closeDestination('S4HANA_DEV', 'tunnel down');
    mod.setNextProbeAtForTest('S4HANA_DEV', now + 12_000);
    // Refused eleven seconds before the tick: the honest answer is twelve
    // seconds, not three hundred.
    expect(mod.retryAfterForDestination('S4HANA_DEV', now)).toBe(12);
  });

  it('rounds up, because waking early walks back into the same refusal', () => {
    const mod = load();
    current = mod;
    const now = 1_000_000;
    mod.closeDestination('D', 'x');
    mod.setNextProbeAtForTest('D', now + 12_400);
    expect(mod.retryAfterForDestination('D', now)).toBe(13);
  });

  it('gives no number when no probe is scheduled', () => {
    const mod = load();
    current = mod;
    mod.closeDestination('D', 'x');
    mod.setNextProbeAtForTest('D', undefined);
    expect(mod.retryAfterForDestination('D', 1_000_000)).toBeUndefined();
  });

  it('leaves other destinations alone', () => {
    const mod = load();
    current = mod;
    mod.closeDestination('S4HANA_DEV', 'tunnel down');
    expect(mod.isDestinationClosed('S4HANA_DEV')).toBe(true);
    expect(mod.isDestinationClosed('S4HANA_QAS')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/destination-closed.test.ts`
Expected: FAIL — `closeDestination is not a function`.

- [ ] **Step 3: Record the next probe per destination**

In `srv/agent-manager.ts`, add `nextProbeAt?: number` to `DestinationState`, and in `scheduleUnreachableRetry` set it for every unreachable destination each time the timer is armed:

Replace the `setInterval` with a recursive `setTimeout`. That is not tidying:
with an interval, the next tick is measured from the start of the previous one,
so a stamp written at the end of a slow probe is later than the run it claims
to describe — and the `Retry-After` built from it tells callers to wait longer
than they need to. A timeout armed after the work has finished has a deadline
that is true by construction.

```ts
  const armProbe = () => {
    const at = Date.now() + UNREACHABLE_RETRY_INTERVAL_MS;
    for (const [, state] of destinationStates) {
      if (state.status === 'unreachable') state.nextProbeAt = at;
    }
    unreachableRetryTimer = setTimeout(runProbe, UNREACHABLE_RETRY_INTERVAL_MS);
  };

  const runProbe = async () => {
    unreachableRetryTimer = null;
    // ... the existing tick body ...
    if (stillUnreachable.length === 0) {
      for (const [, state] of destinationStates) state.nextProbeAt = undefined;
      return; // nothing left to probe; the loop stops until something closes
    }
    armProbe(); // stamped and armed together, after the work, from the same now
  };
```

`scheduleUnreachableRetry` becomes: if a timer is already pending, do nothing; otherwise `armProbe()`.

- [ ] **Step 4: Add the three exports**

```ts
/**
 * Mark a destination unreachable because MCP could not be reached.
 *
 * Creates the entry when there is none: a destination that fails on its very
 * first call has no state yet, and returning early there would silently keep
 * the door open on the system we just found to be gone.
 *
 * The field is `error` — the one `DestinationState` already has — not a second
 * one beside it.
 */
export function closeDestination(name: string, reason: string): void {
  const existing = destinationStates.get(name);
  if (existing) {
    existing.status = 'unreachable';
    existing.error = reason;
  } else {
    // The same shape the background discovery pass builds for a pending
    // destination (`srv/agent-manager.ts`, where `status: 'pending'` entries
    // are created). `toolsRag` is not optional on `DestinationState` and is
    // read without a guard in several places, so a half-built entry would
    // surface later as a different bug.
    destinationStates.set(name, {
      mcpAdapter: null,
      toolsRag: new ExpositionFilteringRag(new InMemoryRag(), new InMemoryRag()),
      toolCount: 0,
      status: 'unreachable',
      error: reason,
    });
  }
  cds.log('agent-manager').warn('destination closed', { destination: name, reason });
  scheduleUnreachableRetry();
}

export function isDestinationClosed(name: string): boolean {
  return destinationStates.get(name)?.status === 'unreachable';
}

/** Every destination this process knows about, closed or not. */
export function knownDestinations(): string[] {
  return [...destinationStates.keys()];
}

/**
 * Seconds until we next LOOK at this destination — not an estimate of when SAP
 * returns, which we cannot know. Coming back sooner is certainly wasted.
 */
export function retryAfterForDestination(name: string, now = Date.now()): number | undefined {
  const at = destinationStates.get(name)?.nextProbeAt;
  if (at === undefined) return undefined;
  return Math.max(1, Math.ceil((at - now) / 1000));
}

/** Test seam: set the scheduled probe without running the real timer. */
export function setNextProbeAtForTest(name: string, at: number | undefined): void {
  const state = destinationStates.get(name);
  if (state) state.nextProbeAt = at;
}

/**
 * Test seam: forget every destination and stop the probe timer.
 *
 * The timer matters as much as the state. `closeDestination` arms a five-minute
 * `setTimeout`, so a test that closes a destination and returns leaves Jest
 * holding an open handle — reported as a leak, or waited on after the suite
 * has finished.
 */
export function clearDestinationStatesForTest(): void {
  if (unreachableRetryTimer) clearTimeout(unreachableRetryTimer);
  unreachableRetryTimer = null;
  destinationStates.clear();
}
```

`ExpositionFilteringRag` and `InMemoryRag` are already imported in this module for the pending-state path; no new import and no new helper.

- [ ] **Step 5: Refuse arrivals, spare the admitted**

Three channels, three shapes. `execute_step` has no HTTP response in scope at
all — its callback returns an MCP result — and the two chat dialects do not
share an envelope, so one snippet for all three would not compile in two of
them.

**`srv/openai-handler.ts`** — `destAfter`:

```ts
  if (isDestinationClosed(destAfter)) {
    const seconds = retryAfterForDestination(destAfter);
    res.writeHead(503, {
      'Content-Type': 'application/json',
      ...(seconds !== undefined ? { 'Retry-After': String(seconds) } : {}),
    });
    res.end(
      JSON.stringify({
        error: { type: 'overloaded_error', message: destinationClosedText(destAfter) },
      }),
    );
    return;
  }
```

**`srv/anthropic-handler.ts`** — `destination`, and the dialect's own envelope,
which wraps the error in a `type: 'error'` object:

```ts
  if (isDestinationClosed(destination)) {
    const seconds = retryAfterForDestination(destination);
    res.writeHead(503, {
      'Content-Type': 'application/json',
      ...(seconds !== undefined ? { 'Retry-After': String(seconds) } : {}),
    });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: destinationClosedText(destination),
        },
      }),
    );
    return;
  }
```

**`srv/agent-mcp.ts`** — `targetDestination`, and an MCP error result. There is
no header here, so the interval goes into the text where a planner can read it:

```ts
      if (isDestinationClosed(targetDestination)) {
        const seconds = retryAfterForDestination(targetDestination);
        const when =
          seconds !== undefined ? ` Try again in about ${seconds} seconds.` : '';
        return textResult(`${destinationClosedText(targetDestination)}${when}`, true);
      }
```

A pipeline already admitted is **not** cut: it fails only if it actually calls the missing server.

Each check sits **before** `admitPipeline` (Tasks 11 and 12): a closed destination refuses before the caller takes a slot or a place, and `safeStop(requestConnection)` runs first in the two HTTP channels, as on every other early return there.

And in `srv/lib/throttle-surfacing.ts`:

```ts
/** A destination we have closed. Temporary, and a 5xx because it is ours. */
export function destinationClosedText(destination: string): string {
  return `SAP system ${destination} is not reachable right now. Other systems are unaffected.`;
}
```

- [ ] **Step 6: Close it from the three error paths, by name**

"Where a turn ends in failure" is not an instruction — the three channels
receive a failure in three different shapes, and a plan that waves at them
leaves the production path unwired while the unit tests, which call
`closeDestination` themselves, stay green.

**A failure does not always arrive as a throw, and that is where an earlier
draft of this step went wrong.** The pipeline returns a `Result`, so the
ordinary case is `ok === false` reaching the same code that formats the answer
— never the `catch`. Wiring only the `catch` and the stream chunk would leave
the two most common paths silently open. And each channel names its destination
differently, so the snippets below use the variable each file actually has.

**`srv/agent-mcp.ts`** — the destination is `targetDestination`, normalised at
`srv/agent-mcp.ts:274`. Two places:

```ts
      // 1. the Result the executor returns
      if (!r.ok) {
        if (isOutageError(r.error)) {
          closeDestination(targetDestination, describeCause(r.error));
        }
        return textResult(failureText(r.error), true);
      }

      // 2. and a throw, for the paths that do not come back as a Result
      } catch (err) {
        if (isOutageError(err)) closeDestination(targetDestination, describeCause(err));
        return textResult(failureText(err), true);
      }
```

**`srv/openai-handler.ts`** — the destination is `destAfter`. Three places:
the non-streaming `Result`, the streaming error chunk, and the `catch`.

```ts
      // 1. non-streaming
      if (!result.ok) {
        if (isOutageError(result.error)) {
          closeDestination(destAfter, describeCause(result.error));
        }
        ...
      }

      // 2. streaming
      if (!chunk.ok) {
        if (isOutageError(chunk.error)) {
          closeDestination(destAfter, describeCause(chunk.error));
        }
        ...
      }

      // 3. thrown
      } catch (err) {
        if (isOutageError(err)) closeDestination(destAfter, describeCause(err));
        ...
```

**`srv/anthropic-handler.ts`** — two places, the returned `Result` and the `catch` (its stream reaches the handler as adapter events, so a stream failure arrives as a throw), and the variable is
`destination` (`srv/anthropic-handler.ts:113`); there is no `destAfter` in this
file at all.

```ts
        if (isOutageError(result.error)) {
          closeDestination(destination, describeCause(result.error));
        }
```

`describeCause` comes from `./lib/mcp-outage`, added in Step 3 of Task 14 — add
it to each channel's imports alongside `isOutageError` and `closeDestination`.

- [ ] **Step 7: Assert the production paths are wired**

Create `test/unit/destination-close-wiring.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural, deliberately. The unit tests for `closeDestination` call it
 * themselves, so they pass whether or not anything in production ever does —
 * which is the failure this file exists to catch.
 */
const read = (f: string) => readFileSync(join(__dirname, '../../srv', f), 'utf8');

/** The destination variable each channel actually has in scope. */
const DEST_VAR: Record<string, string> = {
  'agent-mcp.ts': 'targetDestination',
  'openai-handler.ts': 'destAfter',
  'anthropic-handler.ts': 'destination',
};

describe('a closed destination is refused in each channel\'s own shape', () => {
  it('uses the Anthropic envelope in the Anthropic handler', () => {
    // `{ error }` is the OpenAI shape; this dialect wraps it in `type: 'error'`,
    // and a client reading the wrong one sees an unparsable body.
    const src = read('anthropic-handler.ts');
    expect(src).toMatch(/isDestinationClosed\(\s*destination\s*\)/);
    expect(src).toMatch(/type: 'error'[\s\S]{0,200}destinationClosedText/);
  });

  it('uses the OpenAI envelope in the OpenAI handler', () => {
    expect(read('openai-handler.ts')).toMatch(
      /isDestinationClosed\(\s*destAfter\s*\)/,
    );
  });

  it('returns an MCP result from execute_step, which has no response object', () => {
    const src = read('agent-mcp.ts');
    expect(src).toMatch(/isDestinationClosed\(\s*targetDestination\s*\)/);
    expect(src).toMatch(/textResult\([\s\S]{0,160}destinationClosedText/);
    // A writeHead here would not compile: there is no res in scope.
    expect(src).not.toMatch(/res\.writeHead\(503/);
  });
});

describe('every channel closes a destination it finds unreachable', () => {
  for (const [file, dest] of Object.entries(DEST_VAR)) {
    it(`${file} closes on a returned failure`, () => {
      // The common path: the pipeline returns a Result, and ok === false never
      // reaches a catch. Wiring only the catch leaves this open.
      expect(read(file)).toMatch(
        new RegExp(`isOutageError\\((?:r|result)\\.error\\)[\\s\\S]{0,160}closeDestination\\(\\s*${dest}`),
      );
    });

    it(`${file} closes on a thrown failure`, () => {
      expect(read(file)).toMatch(
        new RegExp(`isOutageError\\(err\\)[\\s\\S]{0,160}closeDestination\\(\\s*${dest}`),
      );
    });
  }

  // Only the OpenAI handler reads chunks. The Anthropic stream reaches its
  // handler as adapter events, so a failure there arrives as a throw.
  for (const file of ['openai-handler.ts']) {
    it(`${file} closes on an error chunk too`, () => {
      // Three shapes, three wirings. Covering two of them leaves a whole
      // transport silently open.
      expect(read(file)).toMatch(
        new RegExp(`isOutageError\\(chunk\\.error\\)[\\s\\S]{0,160}closeDestination\\(\\s*${DEST_VAR[file]}`),
      );
    });
  }
});
```

and an end-to-end one, which is the only kind that catches the marker being
lost inside the embedded wrapper. Append to
`test/unit/destination-close-wiring.test.ts`:

```ts
import { McpClientAdapter, MCPClientWrapper } from '@mcp-abap-adt/llm-agent-mcp';
import { isOutageError, McpUnavailableError } from '../../srv/lib/mcp-outage';

describe('an unreachable system survives the embedded transport', () => {
  it('reaches the adapter as a failure, not as tool feedback', async () => {
    // The whole path: our handler throws, the embedded wrapper catches it and
    // keeps only the message string, and the adapter decides from that string
    // alone whether this was an outage or a tool that ran and failed. A wording
    // the mapper does not recognise ends here as ok:true, and the classifier is
    // never consulted — which no unit test of closeDestination would show.
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      callToolHandler: async () => {
        throw new McpUnavailableError(
          'S4HANA_DEV',
          'connect ECONNRESET [tunnel_timeout]',
          'tunnel_timeout',
        );
      },
    });
    const adapter = new McpClientAdapter(wrapper);
    const result = await adapter.callTool('ReadClass', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The predicate a handler will actually use. `isUnavailable` would be
      // false here — the typed marker did not survive the crossing — which is
      // exactly how this path closed nothing while every other assertion
      // passed.
      expect(isOutageError(result.error)).toBe(true);
      const manager = require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
      manager.closeDestination('S4HANA_DEV', result.error.message);
      expect(manager.isDestinationClosed('S4HANA_DEV')).toBe(true);
      manager.clearDestinationStatesForTest();
    }
    if (!result.ok) {
      // MCP_NO_RESPONSE, not MCP_NOT_CONNECTED: `toMcpError` tests "no
      // response" before the ECONNRESET family, and our marker opens with it.
      // Both are in the library's unavailable set, which is why the classifier
      // asks that set rather than naming a code.
      expect(result.error.code).toBe('MCP_NO_RESPONSE');
    }
  });

  it('leaves a tool that ran and failed as feedback', async () => {
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      callToolHandler: async () => {
        throw new Error('User DEVELOPER is currently editing ZCL_X');
      },
    });
    const adapter = new McpClientAdapter(wrapper);
    const result = await adapter.callTool('CreateClass', {});
    // Escalating this would close a destination that is working perfectly.
    expect(result.ok).toBe(true);
  });
});
```

and a behavioural one, appended to `test/unit/destination-closed.test.ts`:

```ts
describe('the classifier closes the destination it names', () => {
  it('turns an unavailability error into a closed destination', () => {
    const mod = load();
    const { McpUnavailableError, isUnavailable } =
      require('../../srv/lib/mcp-outage') as typeof import('../../srv/lib/mcp-outage');
    const err = new McpUnavailableError('S4HANA_DEV', 'tunnel down', 'tunnel_timeout');
    expect(isUnavailable(err)).toBe(true);
    mod.closeDestination('S4HANA_DEV', err.message);
    expect(mod.isDestinationClosed('S4HANA_DEV')).toBe(true);
    expect(mod.isDestinationClosed('S4HANA_QAS')).toBe(false);
  });
});
```

- [ ] **Step 8: Run, lint, commit**

```bash
npx jest test/unit/destination-closed.test.ts test/unit/destination-close-wiring.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/agent-manager.ts srv/lib/throttle-surfacing.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/agent-mcp.ts test/unit/destination-closed.test.ts test/unit/destination-close-wiring.test.ts
git add -A
git commit -m "feat(outage): a closed destination refuses arrivals, with the time until we next look"
```

### Task 16: An unanswered write is reported, never repeated

**Files:**
- Modify: `srv/lib/recording-mcp-client.ts` (open the record at dispatch), `srv/lib/throttle-surfacing.ts` (the failure text)
- Test: `test/unit/unanswered-write.test.ts`

**Interfaces:**
- Consumes: `isUnavailable` from Task 14.
- Produces:
  - `RecordingMcpClient.unanswered(traceId): ToolCallRecord[]` — calls dispatched and never answered
  - `export function unverifiedWriteText(calls: Array<{ name: string }>, cause: string): string`

**Why it cannot come from the finalizer:** `NoticeFinalizer` runs only when the interpreter returned a result; on an execution failure the coordinator sets its error and returns without calling it. An outage is an execution failure, so there is no executor response to append anything to. The notice belongs on our error path, beside the failure text the channels already compose.

**Why the record must open at dispatch:** `RecordingMcpClient` writes its record *after* awaiting the call, so a transport error that throws leaves no trace that a write was ever sent, which is precisely the case being reported.

- [ ] **Step 1: Write the failing test**

Create `test/unit/unanswered-write.test.ts`:

```ts
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';

function hangingClient(never: Promise<never>) {
  return {
    callTool: () => never,
    listTools: async () => ({ ok: true as const, value: [] }),
  };
}

describe('an unanswered write', () => {
  it('is visible while it is still in flight', async () => {
    const rec = new RecordingMcpClient(hangingClient(new Promise(() => {})) as never);
    void rec.callTool('CreateClass', { name: 'ZCL_X' }, { trace: { traceId: 't1' } } as never);
    await Promise.resolve();
    // Recorded at dispatch. Written after the await, a throw would leave no
    // trace that the write was ever sent, which is the case we report.
    expect(rec.unanswered('t1').map((r) => r.call.name)).toEqual(['CreateClass']);
  });

  it('stops being unanswered once an answer arrives', async () => {
    const client = {
      callTool: async () => ({ ok: true as const, value: { content: 'done' } }),
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec.callTool('CreateClass', {}, { trace: { traceId: 't2' } } as never);
    expect(rec.unanswered('t2')).toHaveLength(0);
  });

  it('says nothing about an unanswered read', async () => {
    // A lost answer to a read is a lost answer. Calling it a possibly-applied
    // write would teach a planner to re-check objects nothing touched.
    const client = {
      callTool: async () => {
        throw new Error('socket hang up');
      },
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec
      .callTool('ReadClass', { name: 'ZCL_X' }, { trace: { traceId: 't4' } } as never)
      .catch(() => undefined);
    expect(rec.unanswered('t4')).toHaveLength(0);
  });

  it('is reported once, naming the write, and never called again', async () => {
    let calls = 0;
    const client = {
      callTool: async () => {
        calls++;
        throw new Error('socket hang up');
      },
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec
      .callTool('CreateClass', { name: 'ZCL_X' }, { trace: { traceId: 't3' } } as never)
      .catch(() => undefined);
    expect(calls).toBe(1);
    expect(rec.unanswered('t3').map((r) => r.call.name)).toEqual(['CreateClass']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/unanswered-write.test.ts`
Expected: FAIL, `rec.unanswered is not a function`.

- [ ] **Step 3: Open the record at dispatch**

In `srv/lib/recording-mcp-client.ts`, import the existing classifier —
`import { isWriteTool } from './write-guardrail';` — and replace the body of
`callTool`:

```ts
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
    const traceId = options?.trace?.traceId;
    // Opened BEFORE the call, so "sent, unanswered" is a state the error path
    // can read rather than an absence it has to infer. Written after the await,
    // a thrown transport error leaves nothing at all.
    const record: ToolCallRecord & { answered?: boolean } = {
      call: { id: '', name, arguments: args },
      result: { content: '', isError: false },
      answered: false,
    };
    if (traceId) this.deltaFor(traceId).push(record);

    const res = await this.inner.callTool(name, args, options);
    // Reached only when an answer came back. A throw leaves `answered` false,
    // deliberately: we do not know whether SAP applied the change, and a retry
    // here would be a second attempt at it.
    record.result = res.ok
      ? res.value
      : { content: res.error?.message ?? String(res.error), isError: true };
    record.answered = true;
    return res;
  }

  /**
   * Writes dispatched under this trace that never received an answer.
   *
   * Writes only. An unanswered `ReadClass` is a lost answer and nothing more;
   * reporting it as possibly-applied would teach a planner to distrust reads
   * and to re-check objects nothing touched. `isWriteTool` is the same
   * classifier the write guardrail already uses, so the two cannot drift.
   */
  unanswered(traceId: string): ToolCallRecord[] {
    return (this.deltas.get(traceId) ?? []).filter(
      (r) =>
        (r as ToolCallRecord & { answered?: boolean }).answered !== true &&
        isWriteTool(r.call.name),
    );
  }
```

- [ ] **Step 4: Compose the failure on the error path**

In `srv/lib/throttle-surfacing.ts`:

```ts
/**
 * A write we sent and never got an answer for.
 *
 * We cannot tell an applied change from a lost one, because an ADT call is
 * asynchronous in substance. So this neither retries nor assumes. It says what
 * happened and leaves the reading to the consumer, which is what a planner and
 * a human are both for.
 */
export function unverifiedWriteText(
  calls: Array<{ name: string }>,
  cause: string,
): string {
  const names = calls.map((c) => c.name).join(', ');
  return `UNVERIFIED_WRITE: ${names} was sent and no answer came back (${cause}). It may or may not have been applied, so read the object back before deciding. It was NOT retried.`;
}
```

In each channel's error path, before formatting the failure:

```ts
  const pending = handle.recMcp?.unanswered(traceId) ?? [];
  const message =
    pending.length > 0
      ? unverifiedWriteText(pending.map((r) => r.call), describeCause(err))
      : failureText(err);
```

`recMcp` is typed in each handler by a local `HandleWithRecMcp`; widen it to `{ recMcp?: { dropRequest(traceId?: string): void; unanswered?(traceId: string): Array<{ call: { name: string } }> } }` so the call above type-checks.

- [ ] **Step 5: Run, lint, commit**

```bash
npx jest test/unit/unanswered-write.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/recording-mcp-client.ts srv/lib/throttle-surfacing.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/agent-mcp.ts test/unit/unanswered-write.test.ts
git add -A
git commit -m "feat(outage): an unanswered write is named in the failure, and never sent twice"
```

---

---

## Phase 5 — surface and record

### Task 17: Remove the fourth entrance

**Files:**
- Modify: `srv/agent-service.ts` (the `Chat` handler)
- Modify: `srv/agent-service.cds` (the `Chat` function)
- Test: `test/unit/agent-service-surface.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. `AgentService.Health`, `GetHistory` and `ClearHistory` are unchanged.

**Why removed rather than gated.** `AgentService.Chat` starts a pipeline and is not an Express route, which makes it easy to miss. It calls `agent.process` straight through — no destination, no per-request credentials, no connection scope, no `safeStop` — so its embedded ABAP tool calls already throw, and it has neither a door nor a session lifecycle. A door with one way around it is not a door, and gating dead surface would be work spent keeping it alive.

**Why `Health` stays.** It probes and returns, starting no pipeline and opening no session. `GetHistory` and `ClearHistory` are stubs that touch nothing and are outside this spec.

- [ ] **Step 1: Write the failing test**

Create `test/unit/agent-service-surface.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(__dirname, '../../srv', f), 'utf8');

describe('AgentService starts no pipeline', () => {
  it('declares no Chat function', () => {
    expect(read('agent-service.cds')).not.toMatch(/function\s+Chat\s*\(/);
  });

  it('registers no Chat handler', () => {
    expect(read('agent-service.ts')).not.toMatch(/on\(\s*'Chat'/);
    expect(read('agent-service.ts')).not.toMatch(/agent\.process\(/);
  });

  it('keeps Health, which probes and starts nothing', () => {
    expect(read('agent-service.cds')).toMatch(/function\s+Health\s*\(/);
    expect(read('agent-service.ts')).toMatch(/on\(\s*'Health'/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/agent-service-surface.test.ts`
Expected: FAIL — `Chat` is still declared and registered.

- [ ] **Step 3: Remove it**

In `srv/agent-service.cds`, delete:

```cds
  /**
   * Send a message to the agent and get response
   */
  function Chat(message: String) returns String;

```

In `srv/agent-service.ts`, delete the whole `srv.on('Chat', ...)` block together with its doc comment (`Chat endpoint - send message to SmartAgent ...`). `getSmartAgent` stays imported: `Health` uses it.

Then confirm nothing else calls it:

```bash
grep -rn "agent/Chat\|on('Chat'\|AgentService.*Chat" srv test app
```

Expected: no output. Documentation that mentions it is updated in Task 19.

- [ ] **Step 4: Build, run, lint, commit**

```bash
npx cds build --production >/dev/null
npx jest test/unit/agent-service-surface.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/agent-service.ts test/unit/agent-service-surface.test.ts
git add srv/agent-service.ts srv/agent-service.cds test/unit/agent-service-surface.test.ts
git commit -m "feat(gatekeeper)!: remove AgentService.Chat, the entrance with neither a door nor a session"
```

---

### Task 18: Four scopes, kept apart

**Files:**
- Create: `srv/lib/gatekeeper-metrics.ts`
- Modify: `srv/openai-handler.ts`, `srv/anthropic-handler.ts`, `srv/agent-mcp.ts` (count a closed-destination refusal where Task 15 refuses)
- Modify: `srv/mcp-proxy.ts`, `srv/mcp-proxy.cds` (`Health` carries the snapshot)
- Modify: `srv/server.ts` (install the throttle observer)
- Test: `test/unit/gatekeeper-metrics.test.ts`

**Interfaces:**
- Consumes: `theDoor`, `theRetention` (Tasks 6, 10); `DoorSnapshot` (Task 7); `RetentionSnapshot` (Task 5); `knownDestinations`, `isDestinationClosed` (Task 15); `setThrottleObserver`, `ThrottleEvent` from `@mcp-abap-adt/llm-agent`.
- Produces:
  - `export function recordDestinationRefusal(destination: string): void`
  - `export function installThrottleObserver(): void`
  - `export interface GatekeeperSnapshot { door: DoorSnapshot | { configured: false }; retention: RetentionSnapshot; destinations: Array<{ name: string; closed: boolean; refusals: number }>; throttling: { events: number; gaveUp: number; noInterval: number; byQuota: Record<string, number> } }`
  - `export function gatekeeperSnapshot(): GatekeeperSnapshot`
  - `export function clearGatekeeperMetrics(): void` — test seam

**Why apart.** They answer different questions, and adding them up answers none.

- **Door** — capacity questions. `capacity` refusals argue for more slots, `retention` refusals for a larger cap, `session_busy` for neither: a client retrying against itself.
- **Retention** — memory at rest. Evictions climbing while the door is quiet means no amount of capacity tuning will help. `closing` should read zero for longer than an upload takes; a number that stays up is a lease that never settled.
- **Per destination** — availability. Mixed into the door's numbers, an unreachable SAP system would look like a full container.
- **Throttling** — the tenant's limit. Since nothing here tries to stay inside it, this is how anyone would know it became the binding constraint.

**Why a JSON string on `Health`.** CDS types are closed. One `gatekeeper : LargeString` field carries the snapshot without a CDS type per scope that would have to change whenever a counter is added.

- [ ] **Step 1: Write the failing test**

Create `test/unit/gatekeeper-metrics.test.ts`:

```ts
jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);
jest.mock('../../srv/request-session', () => ({
  runWithSessionId: (_sid: unknown, fn: () => unknown) => fn(),
  getRequestSessionId: () => undefined,
  getRequestHistory: () => [],
}));

const observers: Array<(e: unknown) => void> = [];
jest.mock('@mcp-abap-adt/llm-agent', () => ({
  ...jest.requireActual('@mcp-abap-adt/llm-agent'),
  setThrottleObserver: (fn: (e: unknown) => void) => observers.push(fn),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as gatekeeper from '../../srv/lib/gatekeeper';
import { clearGatekeeperConfig } from '../../srv/lib/gatekeeper-config';
import {
  clearGatekeeperMetrics,
  gatekeeperSnapshot,
  installThrottleObserver,
  recordDestinationRefusal,
} from '../../srv/lib/gatekeeper-metrics';

function configure(live?: number, queue?: number) {
  if (live === undefined) delete process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS;
  else process.env.LLM_GATEKEEPER_MAX_LIVE_SESSIONS = String(live);
  if (queue === undefined) delete process.env.LLM_GATEKEEPER_QUEUE_LENGTH;
  else process.env.LLM_GATEKEEPER_QUEUE_LENGTH = String(queue);
  clearGatekeeperConfig();
  gatekeeper.resetGatekeeperForTest();
}

afterEach(() => {
  configure();
  clearGatekeeperMetrics();
});

describe('the door scope', () => {
  it('says it is off when no capacity is configured', () => {
    expect(gatekeeperSnapshot().door).toEqual({ configured: false });
  });

  it('counts live sessions and refusals by reason', async () => {
    configure(1, 1);
    const held = await gatekeeper.admitPipeline('u', 'A');
    void gatekeeper.admitPipeline('u', 'B');
    await new Promise((r) => setImmediate(r));
    await gatekeeper.admitPipeline('u', 'C');
    const door = gatekeeperSnapshot().door;
    expect(door).toMatchObject({ live: 1, queued: 1, refusals: { capacity: 1 } });
    if ('admitted' in held) held.admitted.release();
  });
});

describe('the scopes do not mix', () => {
  it('a closed-destination refusal is not a door refusal', async () => {
    configure(2);
    recordDestinationRefusal('S4HANA_DEV');
    recordDestinationRefusal('S4HANA_DEV');
    const snap = gatekeeperSnapshot();
    expect(snap.destinations).toContainEqual(
      expect.objectContaining({ name: 'S4HANA_DEV', refusals: 2 }),
    );
    expect(snap.door).toMatchObject({
      refusals: { session_busy: 0, capacity: 0, retention: 0 },
    });
  });

  it('retention reports held, evictions and sessions awaiting cleanup', () => {
    expect(gatekeeperSnapshot().retention).toEqual(
      expect.objectContaining({ retained: 0, evictions: 0, closing: 0 }),
    );
  });
});

describe('the throttling scope', () => {
  it('counts what the provider observed, including a 429 with no interval', () => {
    installThrottleObserver();
    const observe = observers[observers.length - 1];
    const base = { strategy: 'wait-as-told', attempt: 1, waitMs: 0, waitedMs: 0 };
    observe({ ...base, key: 'q1', source: 'response', retryAfterSeconds: 30, willRetry: true });
    observe({ ...base, key: 'q1', source: 'response', willRetry: false, reason: 'no-interval' });
    expect(gatekeeperSnapshot().throttling).toEqual({
      events: 2,
      gaveUp: 1,
      noInterval: 1,
      byQuota: { q1: 2 },
    });
  });
});

describe('wired where it is read and where it is counted', () => {
  const read = (f: string) => readFileSync(join(__dirname, '../../srv', f), 'utf8');

  it('Health carries the snapshot', () => {
    expect(read('mcp-proxy.ts')).toMatch(/gatekeeper:\s*JSON\.stringify\(\s*gatekeeperSnapshot\(\)\s*\)/);
    expect(read('mcp-proxy.cds')).toMatch(/gatekeeper\s*:\s*LargeString/);
  });

  it('the observer is installed at startup', () => {
    expect(read('server.ts')).toMatch(/installThrottleObserver\(\)/);
  });

  it('every channel counts the closed-destination refusals it sends', () => {
    for (const f of ['openai-handler.ts', 'anthropic-handler.ts', 'agent-mcp.ts']) {
      expect(read(f)).toMatch(/recordDestinationRefusal\(/);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest test/unit/gatekeeper-metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: The metrics**

Create `srv/lib/gatekeeper-metrics.ts`:

```ts
import { setThrottleObserver, type ThrottleEvent } from '@mcp-abap-adt/llm-agent';
import { isDestinationClosed, knownDestinations } from '../agent-manager';
import type { DoorSnapshot } from './door';
import { theDoor, theRetention } from './gatekeeper';
import type { RetentionSnapshot } from './session-retention';

/**
 * Four scopes, because they answer different questions and adding them up
 * answers none. A closed SAP system counted as a door refusal would look like
 * a full container and send someone to buy memory that changes nothing.
 */
export interface GatekeeperSnapshot {
  door: DoorSnapshot | { configured: false };
  retention: RetentionSnapshot;
  destinations: Array<{ name: string; closed: boolean; refusals: number }>;
  throttling: {
    events: number;
    gaveUp: number;
    /** A server refusal that named no interval: the one case an admitted session cannot survive. */
    noInterval: number;
    byQuota: Record<string, number>;
  };
}

const destinationRefusals = new Map<string, number>();
const throttling = { events: 0, gaveUp: 0, noInterval: 0, byQuota: new Map<string, number>() };

export function recordDestinationRefusal(destination: string): void {
  destinationRefusals.set(destination, (destinationRefusals.get(destination) ?? 0) + 1);
}

/** Watch the provider's throttling. Since nothing here tries to stay inside the tenant's limit, this is how anyone would know it binds. */
export function installThrottleObserver(): void {
  setThrottleObserver((e: ThrottleEvent) => {
    throttling.events++;
    if (!e.willRetry) throttling.gaveUp++;
    if (e.source === 'response' && e.retryAfterSeconds === undefined) throttling.noInterval++;
    throttling.byQuota.set(e.key, (throttling.byQuota.get(e.key) ?? 0) + 1);
  });
}

export function gatekeeperSnapshot(): GatekeeperSnapshot {
  const names = new Set([...knownDestinations(), ...destinationRefusals.keys()]);
  return {
    door: theDoor()?.snapshot() ?? { configured: false },
    retention: theRetention().snapshot(),
    destinations: [...names].sort().map((name) => ({
      name,
      closed: isDestinationClosed(name),
      refusals: destinationRefusals.get(name) ?? 0,
    })),
    throttling: {
      events: throttling.events,
      gaveUp: throttling.gaveUp,
      noInterval: throttling.noInterval,
      byQuota: Object.fromEntries(throttling.byQuota),
    },
  };
}

/** Test seam. */
export function clearGatekeeperMetrics(): void {
  destinationRefusals.clear();
  throttling.events = 0;
  throttling.gaveUp = 0;
  throttling.noInterval = 0;
  throttling.byQuota.clear();
}
```

- [ ] **Step 4: Count, expose, install**

In each of `srv/openai-handler.ts`, `srv/anthropic-handler.ts` and `srv/agent-mcp.ts`, import `recordDestinationRefusal` from `./lib/gatekeeper-metrics` and call it as the first statement inside the `if (isDestinationClosed(...)) {` block Task 15 added, with that block's own destination variable (`destAfter`, `destination`, `targetDestination`).

In `srv/mcp-proxy.cds`:

```cds
type HealthStatus {
  status     : String;
  timestamp  : DateTime;
  /** JSON: the four gatekeeper scopes — door, retention, destinations, throttling. */
  gatekeeper : LargeString;
}
```

In `srv/mcp-proxy.ts`, import `gatekeeperSnapshot` from `./lib/gatekeeper-metrics` and return:

```ts
    return {
      status: 'UP',
      timestamp: now,
      gatekeeper: JSON.stringify(gatekeeperSnapshot()),
    };
```

In `srv/server.ts`, import `installThrottleObserver` and call it at the top of the `cds.on('served', () => { ... })` callback, before `initSmartAgents()`:

```ts
  installThrottleObserver();
```

- [ ] **Step 5: Build, run, lint, commit**

```bash
npx cds build --production >/dev/null
npx jest test/unit/gatekeeper-metrics.test.ts && npm run test:unit && npm run test:check
npx biome check --write srv/lib/gatekeeper-metrics.ts srv/mcp-proxy.ts srv/server.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/agent-mcp.ts test/unit/gatekeeper-metrics.test.ts
git add srv/lib/gatekeeper-metrics.ts srv/mcp-proxy.ts srv/mcp-proxy.cds srv/server.ts srv/openai-handler.ts srv/anthropic-handler.ts srv/agent-mcp.ts test/unit/gatekeeper-metrics.test.ts
git commit -m "feat(gatekeeper): four observability scopes on Health, kept apart"
```

---

### Task 19: The documentation says what the service now does

**Files:**
- Modify: `docs/llm-agent/CONFIG_USAGE.md`, `docs/architecture/API_REFERENCE.md`, `docs/architecture/ARCHITECTURE.md`, `docs/architecture/EXTENSION_GUIDE.md`, `docs/llm-agent/TESTING.md`, `docs/llm-agent/EMBEDDED_USAGE.md`, `docs/deployment/TESTING_AFTER_DEPLOYMENT.md`, `docs/tutorials/code-review/examples/ZDEMO_REPORT/curl/run-checks.sh`
- Test: `npm run docs:check`

**Interfaces:** none.

**Why this is a task and not a footnote.** Stale docs describing the previous contract are believed. Three things changed that a reader acts on: a header no longer names a session, a door can refuse, and an OData function is gone. The spec is deleted when the work lands, so what it explained has to live in the docs by then.

- [ ] **Step 1: Configuration**

In `docs/llm-agent/CONFIG_USAGE.md`, replace the `LLM_AGENT_THROTTLE_MAX_WAIT_MS` row with these four:

```markdown
| `LLM_AGENT_THROTTLE_MAX_WAIT_MS` | `20000` | The longest LLM-side `429` interval we wait out **when no door is configured**. Anything longer is reported with the number attached. Not applied once `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` is set: behind a door an admitted session waits exactly the interval the server named. A value that is not a whole number of milliseconds is refused at startup |
| `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` | unset | How many sessions may run a pipeline at once, across `/v1/chat/completions`, `/v1/messages` and `execute_step`. Unset: no door on the chat channels, and `execute_step` keeps its cap of two. Size it against the container's memory |
| `LLM_GATEKEEPER_QUEUE_LENGTH` | the capacity | How many callers may wait to be admitted — for a slot, for their own session, or for a retention place. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS`. The queue passing three quarters is logged as pressure |
| `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` | unbounded | How many sessions may hold history and session collections. The least recently used idle one is evicted — history, collections and their files — to make room; a session with a pipeline or a RAG operation running is never evicted. Requires `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` and may not be smaller. With `/v1/rag/*` in use, set it above the capacity by the number of concurrent uploads |
```

Below the table, add:

```markdown
All `LLM_GATEKEEPER_*` values: unset means off, and a value that is not a positive integer — or a combination the notes above forbid — stops the service at startup, naming the variable. The values in force are logged at startup and returned in `Health()`.
```

- [ ] **Step 2: The API contract**

In `docs/architecture/API_REFERENCE.md`, replace the paragraph starting `**Inbound** — no limit is enforced on callers of this service.` with:

```markdown
**Inbound — the gatekeeper.** With `LLM_GATEKEEPER_MAX_LIVE_SESSIONS` set, every
pipeline-starting channel counts against one door. A caller that cannot start
at once waits in a bounded queue; once admitted it is carried to the end — only
a shutdown ends it. When the queue is full the caller is refused, with the reason
and **without** a `Retry-After`: how long the sessions ahead will run is not
something the service measures.

| Reason | Meaning | `/v1/chat/completions` | `/v1/messages` | `execute_step` |
|---|---|---|---|---|
| `session_busy` | this session is still running a request | `503`, `error.code: gatekeeper_session_busy` | `529` `overloaded_error` | text prefixed `gatekeeper_session_busy:` |
| `capacity` | every slot is taken | `503`, `error.code: gatekeeper_capacity` | `529` `overloaded_error` | text prefixed `gatekeeper_capacity:` |
| `retention` | no room to keep another session | `503`, `error.code: gatekeeper_retention` | `529` `overloaded_error` | text prefixed `gatekeeper_retention:` |

A client disconnect does not stop a running session: SAP may be halfway through
a write, and cutting it leaves objects locked. The session finishes and its
output is discarded.
```

In the paragraph starting `The wait budget is **20 seconds** here`, append:

```markdown
With a door configured this budget is not applied: an admitted session waits
out exactly the interval the server named, and a `429` that names none fails it.
```

Add a new section, `### Sessions`, after the rate-limiting section:

```markdown
### Sessions

The service issues the session in an `HttpOnly` cookie, `clh_session`, on the
first `/v1` response that has none, and keys every session by that value
**together with the authenticated user**. Request headers do not name a
session: `x-session-id` and `mcp-session-id` are not read.

**Migrating from `x-session-id`.** A client that wants a session across
requests keeps the cookie and sends it back — `curl -c jar -b jar`. A
`/v1/rag/collections` request with `scope: 'session'` that still sends
`x-session-id` is answered `400`, naming the cookie. A client that keeps no
cookies gets a fresh session per request; use `scope: 'user'` instead, with its
different lifetime and visibility.

**Ending a session.** `DELETE /v1/session` answers `204` at once. The session is
unreachable from that moment; its history, collections and their files are
removed once whatever is running against it has stopped — a RAG upload is
cancelled and then waited for, a running pipeline is waited for. A request
against a session being removed is answered `410` with `error.code:
session_closed`. The next request carrying the old cookie is given a new
session.

**Retention.** With `LLM_GATEKEEPER_MAX_RETAINED_SESSIONS` set, creating a
session-scoped collection when every place is taken by something running is
answered `503` with `error.code: gatekeeper_retention`. An idle session is
evicted instead when one exists — silently, so its next question arrives
without the earlier context.
```

- [ ] **Step 3: The architecture**

In `docs/architecture/ARCHITECTURE.md`:

- delete the blockquote starting `> The legacy \`AgentService\` OData path`
- in the **Agent / LLM surfaces** row, replace from `A legacy secondary surface, the OData \`AgentService\`` to the end of the cell with `The OData \`AgentService\` (\`/odata/v4/agent/*\`) keeps \`Health\` only; it starts no pipeline.`
- in the **Agent MCP** row, replace `concurrency capped by \`Semaphore\` (\`EXEC_STEP_MAX_CONCURRENCY=2\`)` with `counts against the gatekeeper's door when \`LLM_GATEKEEPER_MAX_LIVE_SESSIONS\` is set, and is otherwise capped at two by \`Semaphore\``
- delete the sentence `The legacy \`/odata/v4/agent/Chat\` endpoint (\`agent-service.ts\`) also delegates to \`getSmartAgent\`, but is a secondary surface — see §4 and §11.`
- in **Where the waiting decision sits**, append: `With a door configured the strategy is \`WaitAsTold\` instead: admission already decided the caller is carried to the end, so a ceiling behind the door would only kill work in flight.`

Then add a section before `### Honesty controller (executor + reviewer)`:

```markdown
### Gatekeeper

Memory is the binding resource, spent two ways: pipelines in flight, and
sessions at rest. `srv/lib/door.ts` bounds the first, `srv/lib/session-retention.ts`
the second; `srv/lib/gatekeeper.ts` joins them to the real stores.

- **One session, one pipeline.** The door keys by the authenticated user and
  the issued `clh_session`. A second request for a running session waits.
- **One queue.** Bounded by `LLM_GATEKEEPER_QUEUE_LENGTH`; the oldest waiter that
  can be served goes next. Admission takes a slot and a retention place
  together, or neither.
- **Carried to the end.** Only shutdown aborts an admitted session. A client
  disconnect detaches the output sink (`srv/lib/detached-sink.ts`) and nothing
  more.
- **Teardown order.** Wait for every model and tool call the session started
  (they register themselves through `srv/lib/admission-scope.ts`), then
  `safeStop`, then release the slot.
- **Leases.** Every operation on a session's state holds one. Eviction and the
  TTL sweep skip leased sessions. Every deletion closes the session to new
  leases, cancels RAG operations, waits for the rest, then removes history,
  collections and their directories through one primitive
  (`srv/lib/session-state.ts`).
- **Observability.** `Health()` returns door, retention, per-destination and
  throttling scopes separately (`srv/lib/gatekeeper-metrics.ts`).
```

Then check nothing else still describes the removed function:

```bash
grep -n "agent/Chat\|Chat(message\|Chat\`/\`Health" docs/architecture/ARCHITECTURE.md
```

Expected: no output. Any remaining mermaid node or table cell naming `Chat` under `AgentService` is edited to name `Health` alone.

- [ ] **Step 4: The guides and examples**

`docs/architecture/EXTENSION_GUIDE.md` — delete the tree line `├── /odata/v4/agent/Chat          → SmartAgent.process()`.

`docs/llm-agent/EMBEDDED_USAGE.md` — replace `which is why the legacy OData \`AgentService\` path has no working ABAP edge.` with `which is why every agent entrance runs its pipeline inside that scope.`

`docs/llm-agent/TESTING.md` — delete the blockquote starting `> **The legacy OData \`Chat\` is LLM-only.**` and the `curl` block after it. Replace **Scenario 1** with:

```markdown
### Scenario 1: The model answers — no SAP involved

`Health()` asks the LLM provider whether the configured model is available,
without a completion and without a connection:

```bash
curl "http://localhost:4004/odata/v4/agent/Health()" -H "Authorization: Basic YWxpY2U6"
```

`agentReady: true` means the model is reachable.
```

`docs/deployment/TESTING_AFTER_DEPLOYMENT.md` — replace section `#### 2. Simple Chat (LLM Only)` and its `curl` with:

```markdown
#### 2. Simple Chat, keeping the session

The session lives in the `clh_session` cookie the service issues; keep it with a
cookie jar so the second request continues the first.

```bash
curl -s -c jar -b jar -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello! Remember the word PINE."}]}' | jq '.choices[0].message.content'

curl -s -c jar -b jar -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Which word did I ask you to remember?"}]}' | jq '.choices[0].message.content'
```
```

and correct its **Expected Response** to an OpenAI `chat.completion` whose second answer names `PINE`.

`docs/tutorials/code-review/examples/ZDEMO_REPORT/curl/run-checks.sh:292` — `stateless per call (no x-session-id)` → `stateless per call (no clh_session cookie kept)`.

- [ ] **Step 5: Check, commit**

```bash
npm run docs:check
grep -rn "x-session-id" docs README.md --include='*.md' | grep -v "docs/superpowers/"
```

Expected: `docs:check — OK`; the grep prints only the migration paragraph in `API_REFERENCE.md`.

```bash
git add docs
git commit -m "docs: the door, sessions the service issues, and the removed OData Chat"
```

The spec and this plan are deleted in the merge commit's follow-up on `main`, after the PR is merged — not in the PR, so a reviewer can read both against the code.

---

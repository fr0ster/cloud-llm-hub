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

type Chunk =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: Error };

export const harness = {
  user: { id: 'alice', is: () => true, roles: ['MCP_Full'] } as {
    id: string;
    is: (r: string) => boolean;
    roles: string[];
  },
  events: [] as string[],
  seenOptions: [] as Array<Record<string, unknown>>,
  /** Hold agent resolution open, as a destination still warming would. */
  agentGate: Promise.resolve() as Promise<void>,
  /** Set to a destination name to make `isDestinationClosed` say yes to it. */
  closedDestination: undefined as string | undefined,
  /** What `retryAfterForDestination` reports while a destination is closed. */
  retryAfterSeconds: undefined as number | undefined,
  /** What `recMcp.unanswered(traceId)` reports for the current test. */
  unanswered: [] as Array<{ call: { name: string } }>,
  /** Every `closeDestination(name, reason)` call a test observed. */
  closeDestinationCalls: [] as Array<{ destination: string; reason: string }>,
  /** Every destination `establishRequestConnection` was asked to connect to. */
  establishCalls: [] as string[],
  /** Make `recMcp.dropRequest` throw, after it is recorded. */
  dropRequestThrows: false,
  /** What `resolveRequestSystem` answers. */
  requestSystem: { responsible: 'ALICE', masterSystem: 'DEV' } as {
    responsible?: string;
    masterSystem?: string;
  },
  /** The headers every `resolveRequestSystem` call was given. */
  requestSystemHeaders: [] as Array<Record<string, unknown>>,
  /** The request-system scope the run is inside, if any. */
  activeRequestSystem: undefined as Record<string, unknown> | undefined,
  /** The scope each pipeline call ran in: `undefined` means none. */
  requestSystemAtPipeline: [] as Array<Record<string, unknown> | undefined>,
  /** Last destination per `JSON.stringify([userId, sessionId])`; unset reads as `DEST`. */
  sessionDestinations: new Map<string, string>(),
  /** Every `setSessionDestination(userId, sessionId, destination)` call. */
  destinationSets: [] as Array<{
    userId: string;
    sessionId: string;
    destination: string;
  }>,
  process: async (
    _messages: unknown,
    _opts: Record<string, unknown>,
  ): Promise<Chunk> => ({
    ok: true,
    value: { content: 'done', stopReason: 'stop' },
  }),
  stream: async function* (
    _messages: unknown,
    _opts: Record<string, unknown>,
  ): AsyncIterable<Chunk> {
    yield { ok: true, value: { content: 'done' } };
    yield { ok: true, value: { finishReason: 'stop' } };
  },
  reset() {
    harness.events = [];
    harness.seenOptions = [];
    harness.agentGate = Promise.resolve();
    harness.closedDestination = undefined;
    harness.retryAfterSeconds = undefined;
    harness.unanswered = [];
    harness.closeDestinationCalls = [];
    harness.establishCalls = [];
    harness.dropRequestThrows = false;
    harness.requestSystem = { responsible: 'ALICE', masterSystem: 'DEV' };
    harness.requestSystemHeaders = [];
    harness.activeRequestSystem = undefined;
    harness.requestSystemAtPipeline = [];
    harness.sessionDestinations = new Map();
    harness.destinationSets = [];
    harness.process = async () => ({
      ok: true,
      value: { content: 'done', stopReason: 'stop' },
    });
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
      harness.requestSystemAtPipeline.push(harness.activeRequestSystem);
      return harness.process(m, o);
    },
    streamProcess: (m: unknown, o: Record<string, unknown>) => {
      harness.seenOptions.push(o);
      harness.events.push('pipeline');
      harness.requestSystemAtPipeline.push(harness.activeRequestSystem);
      return harness.stream(m, o);
    },
  },
  recMcp: {
    dropRequest: () => {
      harness.events.push('dropRequest');
      if (harness.dropRequestThrows) throw new Error('dropRequest failed');
    },
    unanswered: (_traceId: string) => harness.unanswered,
  },
};

export function agentManagerMock() {
  const { CollectionRegistry } = jest.requireActual(
    '../../../srv/rag-collections',
  );
  const registry = new CollectionRegistry();
  const { createRagStoreFactory } = jest.requireActual(
    '../../../srv/lib/rag-store-factory',
  );
  // What server startup builds with the default configuration. Not taken from
  // ./providers: that module imports agent-manager, which this object mocks.
  const providers = {
    embedding: null,
    stores: createRagStoreFactory(
      {
        embedder: null,
        backends: {
          tools: 'in-memory',
          session: 'in-memory',
          persistent: 'in-memory',
        },
      },
      null,
    ),
    destinations: { list: async () => [], clearCache: () => {} },
  };
  return {
    isAgentReady: () => true,
    isProvidersReady: () => true,
    getProviders: () => providers,
    getSmartAgent: async () => {
      harness.events.push('getSmartAgent');
      await harness.agentGate;
      return handle;
    },
    getCurrentDestination: (userId?: string, sessionId?: string) =>
      (userId &&
        sessionId &&
        harness.sessionDestinations.get(JSON.stringify([userId, sessionId]))) ||
      'DEST',
    setSessionDestination: (
      userId: string,
      sessionId: string,
      destination: string,
    ) => {
      harness.destinationSets.push({ userId, sessionId, destination });
      harness.sessionDestinations.set(
        JSON.stringify([userId, sessionId]),
        destination,
      );
    },
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
    // without them every channel test would break at Task 15. Driven off
    // `harness.closedDestination`/`harness.retryAfterSeconds` so a test can
    // simulate a closed destination per-call instead of a fixed stub.
    isDestinationClosed: (name: string) => harness.closedDestination === name,
    retryAfterForDestination: () => harness.retryAfterSeconds,
    closeDestination: (destination: string, reason: string) => {
      harness.closeDestinationCalls.push({ destination, reason });
    },
    knownDestinations: () => [],
  };
}

export function agentConfigMock() {
  return {
    isAiCoreConfigured: () => true,
    getAgentConfig: () => ({
      llm: { model: 'm' },
      mcp: { destination: 'DEST' },
      agent: {},
    }),
  };
}

export function requestConnectionMock() {
  return {
    // Recorded, because the real one CSRF-fetches over the network: a channel
    // that calls it for a closed destination hammers the dead system and
    // answers 401 before its closed-destination check is ever reached.
    establishRequestConnection: async (
      _req: unknown,
      _res: unknown,
      destination: string | undefined,
    ) => {
      if (destination) harness.establishCalls.push(destination);
      return {
        handled: false,
        connection: { id: 'conn' },
        dumpScope: undefined,
      };
    },
    safeStop: async () => {
      harness.events.push('safeStop');
    },
  };
}

/**
 * The responsible person and master system are resolved, and their scope
 * entered, only once admitted and right before the pipeline: both recorded
 * into `harness.events`, and the scope into `harness.activeRequestSystem` for
 * as long as the run inside it lasts.
 */
export function requestSystemMock() {
  return {
    resolveRequestSystem: (headers: Record<string, unknown>) => {
      harness.events.push('resolveRequestSystem');
      harness.requestSystemHeaders.push(headers);
      return harness.requestSystem;
    },
    runWithRequestSystem: async <T>(
      values: Record<string, unknown>,
      fn: () => Promise<T>,
    ): Promise<T> => {
      harness.events.push('requestSystemScope');
      harness.activeRequestSystem = values;
      try {
        return await fn();
      } finally {
        harness.activeRequestSystem = undefined;
      }
    },
  };
}

/** `minted: false` is a cookie the middleware kept because the session was live. */
export function fakeReq(body: unknown, sessionId = 's-1', minted = true) {
  return {
    body,
    headers: {
      'x-sap-destination': 'DEST',
      cookie: `clh_session=${sessionId}`,
    },
    sessionId,
    sessionMinted: minted,
    secure: false,
  };
}

/**
 * `throwOnWriteAfter`: once this many writes have gone through successfully,
 * the next `write` throws — simulating a dead socket (EPIPE) rather than a
 * clean disconnect. `detachedSink` must swallow it, not the handler.
 */
export function fakeRes(opts: { throwOnWriteAfter?: number } = {}) {
  const closeListeners: Array<() => void> = [];
  let writeCount = 0;
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
      writeCount++;
      if (
        opts.throwOnWriteAfter !== undefined &&
        writeCount > opts.throwOnWriteAfter
      ) {
        throw new Error('EPIPE');
      }
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

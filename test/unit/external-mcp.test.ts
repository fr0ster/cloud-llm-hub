import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import { ExternalMcp, parseExternalMcp } from '../../srv/lib/external-mcp';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';

const adapter: IMcpClient = {
  listTools: async () => ({
    ok: true,
    value: [{ name: 'search', description: 'docs', inputSchema: {} }],
  }),
  callTool: async () => ({ ok: true, value: { content: 'documentation' } }),
};
const resolver = new TrustResolver(
  undefined,
  undefined,
  parseTrustDefaults(undefined),
);
test('role lists, read-only registration, collision dispatch and profile trust precedence', async () => {
  const connect = jest.fn(async () => adapter);
  const external = new ExternalMcp(
    parseExternalMcp({
      LLM_AGENT_PLANNER_MCP: 'public',
      LLM_AGENT_ANALYST_MCP: 'private',
      LLM_AGENT_MCP_TRUST: 'private=5',
    }),
    () => ['search'],
    connect,
  );
  expect(await external.clients('executor')).toEqual([]);
  const clients = await external.clients('planner');
  expect(await clients[0].listTools()).toEqual({
    ok: true,
    value: [{ name: 'public__search', description: 'docs', inputSchema: {} }],
  });
  expect(await clients[0].callTool('public__search', {})).toEqual({
    ok: true,
    value: { content: 'documentation' },
  });
  expect(external.catalogue()).toContainEqual({
    name: 'public__search',
    effect: 'read',
  });
  for (const docs of [1, 4])
    expect(
      external.toolTrust(
        'public__search',
        resolver.forProfile({ trust: { docs } }),
      ),
    ).toEqual({ source: 'docs:search', trust: docs });
  expect(external.toolTrust('public__search', resolver)).toEqual({
    source: 'docs:search',
    trust: 4.2,
  });
  await external.clients('analyst');
  expect(
    external.toolTrust(
      'private__search',
      resolver.forProfile({ trust: { docs: 1 } }),
    ),
  ).toEqual({ source: 'docs:search', trust: 5 });
  expect(external.toolTrust('client_tool', resolver)).toBeUndefined();
});
test('unreachable destination warns, cools down and retries without failing preparation', async () => {
  let now = 0;
  const warn = jest.fn();
  const connect = jest.fn(async () => {
    throw new Error('offline');
  });
  const external = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_CHECKER_MCP: 'offline' }),
    () => [],
    connect,
    warn,
    () => now,
  );
  expect(connect).not.toHaveBeenCalled();
  expect(await external.clients('checker')).toEqual([]);
  expect(await external.clients('checker')).toEqual([]);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('External docs MCP unavailable', {
    destination: 'offline',
  });
  now = 30001;
  await external.clients('checker');
  expect(connect).toHaveBeenCalledTimes(2);
});
test.each(['bad', 'x=', 'x=6', 'x=NaN', 'x=2=3'])(
  'invalid trust fails configuration: %s',
  (value) => {
    expect(() => parseExternalMcp({ LLM_AGENT_MCP_TRUST: value })).toThrow(
      'LLM_AGENT_MCP_TRUST',
    );
  },
);

test('ToolTrust produces the docs source envelope for model-facing review text', async () => {
  const external = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
    () => [],
    async () => adapter,
  );
  await external.clients('executor');
  const { buildReviewMessages } = await import('../../srv/lib/step-reviewer');
  const messages = buildReviewMessages({
    task: 'read docs',
    content: 'done',
    executedTools: [{ name: 'search', ok: true }],
    toolTrust: (name) => external.toolTrust(name, resolver),
  });
  expect(messages[1].content).toContain('[source: docs:search; trust 4.2]');
});

test.each(['planner', 'executor', 'checker', 'analyst'])(
  '%s consistently receives only its configured destination',
  async (role) => {
    const connect = jest.fn(
      async (destination: string): Promise<IMcpClient> => ({
        ...adapter,
        listTools: async () => ({
          ok: true,
          value: [
            {
              name: `${destination}_search`,
              description: 'docs',
              inputSchema: {},
            },
          ],
        }),
      }),
    );
    const external = new ExternalMcp(
      parseExternalMcp({ [`LLM_AGENT_${role.toUpperCase()}_MCP`]: 'public' }),
      () => [],
      connect,
    );
    for (const candidate of ['planner', 'executor', 'checker', 'analyst']) {
      const clients = await external.clients(candidate);
      expect(clients).toHaveLength(candidate === role ? 1 : 0);
    }
    const again = await external.clients(role);
    expect(await again[0].listTools()).toEqual({
      ok: true,
      value: [{ name: 'public_search', description: 'docs', inputSchema: {} }],
    });
    expect(connect).toHaveBeenCalledTimes(1);
    const deploy = new TrustResolver(
      undefined,
      undefined,
      parseTrustDefaults('docs=2.5'),
    );
    expect(external.toolTrust('public_search', deploy)).toEqual({
      source: 'docs:public_search',
      trust: 2.5,
    });
  },
);

test.each([
  ['A', 'B'],
  ['B', 'A'],
])(
  'collisions are independent of discovery order %s then %s in every role',
  async (first, second) => {
    const pending = new Map<string, (client: IMcpClient) => void>();
    const external = new ExternalMcp(
      {
        roles: {
          planner: ['A', 'B'],
          executor: ['A'],
          checker: ['B'],
          analyst: ['B', 'A'],
        },
        trust: {},
      },
      () => ['embedded'],
      (destination) =>
        new Promise<IMcpClient>((resolve) => {
          pending.set(destination, resolve);
        }),
    );
    const ready = external.clients('planner');
    const client: IMcpClient = {
      ...adapter,
      listTools: async () => ({
        ok: true,
        value: ['search', 'embedded'].map((name) => ({
          name,
          description: '',
          inputSchema: {},
        })),
      }),
    };
    pending.get(first)?.(client);
    await Promise.resolve();
    pending.get(second)?.(client);
    await ready;
    for (const role of ['planner', 'executor', 'checker', 'analyst'] as const) {
      const destinations =
        role === 'executor' ? ['A'] : role === 'checker' ? ['B'] : ['A', 'B'];
      expect(
        external
          .catalogue(role)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(
        destinations
          .flatMap((destination) => [
            `${destination}__embedded`,
            `${destination}__search`,
          ])
          .sort(),
      );
      const clients = await external.clients(role);
      for (const client of clients) {
        const listed = await client.listTools();
        expect(listed.ok).toBe(true);
        if (listed.ok)
          for (const tool of listed.value)
            expect(tool.name).toMatch(/^[AB]__(search|embedded)$/);
      }
    }
  },
);

test('background discovery returns immediately and publishes when discovery completes', async () => {
  let finish: (client: IMcpClient) => void = () => {};
  const pending = new Promise<IMcpClient>((resolve) => {
    finish = resolve;
  });
  const external = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
    () => [],
    () => pending,
    jest.fn(),
  );
  external.refresh();
  expect(external.catalogue('executor')).toEqual([]);
  finish(adapter);
  await external.clients('executor');
  expect(external.catalogue('executor')).toEqual([
    { name: 'search', effect: 'read' },
  ]);
});

test('recovery preserves names and routes existing agents to the replacement', async () => {
  let now = 0;
  let online = false;
  const oldCall = jest.fn(adapter.callTool);
  const disconnect = jest.fn(async () => {});
  const first = { ...adapter, callTool: oldCall, disconnect };
  const replacementCall = jest.fn(adapter.callTool);
  const replacement = { ...adapter, callTool: replacementCall };
  let connections = 0;
  const external = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'A,B' }),
    () => [],
    async (destination) => {
      if (destination === 'B' && !online) throw new Error('offline');
      if (destination === 'A') return connections++ === 0 ? first : replacement;
      return adapter;
    },
    jest.fn(),
    () => now,
  );
  const clients = await external.clients('executor');
  expect(external.catalogue()).toEqual([{ name: 'A__search', effect: 'read' }]);
  oldCall.mockRejectedValueOnce(new Error('lost connection'));
  await clients[0].callTool('A__search', {});
  online = true;
  now = 30001;
  await external.clients('executor');
  expect(external.catalogue()).toEqual([
    { name: 'A__search', effect: 'read' },
    { name: 'B__search', effect: 'read' },
  ]);
  await clients[0].callTool('A__search', {});
  expect(replacementCall).toHaveBeenCalledWith('search', {}, undefined);
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('healthy refresh lists tools again without reconnecting', async () => {
  let now = 0;
  const listTools = jest.fn(adapter.listTools);
  const disconnect = jest.fn(async () => {});
  const connect = jest.fn(async () => ({ ...adapter, listTools, disconnect }));
  const external = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
    () => [],
    connect,
    jest.fn(),
    () => now,
  );
  await external.clients('executor');
  now = 30001;
  await external.clients('executor');
  expect(connect).toHaveBeenCalledTimes(1);
  expect(listTools).toHaveBeenCalledTimes(2);
  expect(disconnect).not.toHaveBeenCalled();
});

test('clients use a live cached connection while a refresh hangs', async () => {
  jest.useFakeTimers();
  try {
    let now = 0;
    const listTools = jest.fn(adapter.listTools);
    const callTool = jest.fn(adapter.callTool);
    const external = new ExternalMcp(
      parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
      () => [],
      async () => ({ ...adapter, listTools, callTool }),
      jest.fn(),
      () => now,
    );
    await external.clients('executor');
    listTools.mockImplementationOnce(() => new Promise(() => {}));
    now = 30001;
    external.refresh();
    const clients = await external.clients('executor');
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(1);
    expect(await clients[0].listTools()).toEqual(await adapter.listTools());
    await clients[0].callTool('search', {});
    expect(callTool).toHaveBeenCalledWith('search', {}, undefined);
    // Release the background refresh before restoring real timers.
    await jest.advanceTimersByTimeAsync(600_000);
  } finally {
    jest.useRealTimers();
  }
});

test('the discovery safety net releases a hung first listing and warns', async () => {
  jest.useFakeTimers();
  try {
    const warn = jest.fn();
    const disconnect = jest.fn(async () => {});
    const listTools = jest.fn(
      (): ReturnType<IMcpClient['listTools']> => new Promise(() => {}),
    );
    const external = new ExternalMcp(
      parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
      () => [],
      async () => ({ ...adapter, listTools, disconnect }),
      warn,
    );
    const ready = external.clients('executor');
    await jest.advanceTimersByTimeAsync(599_999);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(await ready).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('External docs MCP unavailable', {
      destination: 'docs',
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(external.catalogue()).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('discovery cleans up after a failed tool listing', async () => {
  const disconnect = jest.fn(async () => {});
  const external = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
    () => [],
    async () => ({
      ...adapter,
      disconnect,
      listTools: async () => {
        throw new Error('list failed');
      },
    }),
    jest.fn(),
  );
  expect(await external.clients('executor')).toEqual([]);
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('undiscovered external policy entries match nothing and retain strict validation without destinations', async () => {
  const { effectiveProfileTools } = await import(
    '../../srv/lib/agent-profile-tools'
  );
  for (const configured of [false, true]) {
    const external = new ExternalMcp(
      parseExternalMcp(configured ? { LLM_AGENT_EXECUTOR_MCP: 'docs' } : {}),
      () => [],
      async () => adapter,
    );
    for (const name of ['search', 'docs__search']) {
      const validate = () =>
        effectiveProfileTools({
          catalogue: [],
          grants: new Set([name]),
          result: 'report',
          policy: { allow: [name], deny: ['docs__other'] },
          acceptsPolicyName: (candidate) =>
            external.acceptsPolicyName(candidate),
        });
      if (configured) expect(validate().allows(name)).toBe(false);
      else expect(validate).toThrow('Unregistered policy tool');
    }
    expect(external.acceptsPolicyName('other__search')).toBe(false);
  }
});

test('replacement waits for in-flight calls before disconnecting the old client', async () => {
  let now = 0;
  let finish: (() => void) | undefined;
  const disconnect = jest.fn(async () => {});
  const first: IMcpClient & { disconnect(): Promise<void> } = {
    ...adapter,
    disconnect,
    callTool: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true, value: { content: 'finished' } };
    },
  };
  let attempts = 0;
  const external = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
    () => [],
    async () => (attempts++ === 0 ? first : adapter),
    jest.fn(),
    () => now,
  );
  const clients = await external.clients('executor');
  const running = clients[0].callTool('search', {});
  // A concurrent failure marks the same connection unhealthy.
  first.callTool = async () => {
    throw new Error('offline');
  };
  await clients[0].callTool('search', {});
  now = 30001;
  await external.clients('executor');
  expect(disconnect).not.toHaveBeenCalled();
  finish?.();
  await running;
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(await clients[0].callTool('search', {})).toEqual({
    ok: true,
    value: { content: 'documentation' },
  });
});

test('empty MTA MCP parameters disable connections and use default trust', () => {
  expect(
    parseExternalMcp({
      LLM_AGENT_PLANNER_MCP: '',
      LLM_AGENT_EXECUTOR_MCP: '',
      LLM_AGENT_CHECKER_MCP: '',
      LLM_AGENT_ANALYST_MCP: '',
      LLM_AGENT_MCP_TRUST: '',
    }),
  ).toEqual({
    roles: { planner: [], executor: [], checker: [], analyst: [] },
    trust: {},
    selection: {},
    directMax: 12,
  });
});

test('executor waits only for its destinations while other discovery stalls', async () => {
  let finish: (client: IMcpClient) => void = () => {};
  const stalled = new Promise<IMcpClient>((resolve) => {
    finish = resolve;
  });
  const connect = jest.fn((destination: string) =>
    destination === 'DOCS_A' ? Promise.resolve(adapter) : stalled,
  );
  const external = new ExternalMcp(
    parseExternalMcp({
      LLM_AGENT_EXECUTOR_MCP: 'DOCS_A',
      LLM_AGENT_PLANNER_MCP: 'DOCS_B',
    }),
    () => [],
    connect,
  );
  try {
    const clients = await external.clients('executor');
    expect(connect).toHaveBeenCalledWith('DOCS_B');
    expect(clients).toHaveLength(1);
    expect(await clients[0].listTools()).toEqual({
      ok: true,
      value: [{ name: 'DOCS_A__search', description: 'docs', inputSchema: {} }],
    });
  } finally {
    finish(adapter);
    await external.clients('planner');
  }
  expect(external.toolNames('executor')).toEqual(['DOCS_A__search']);
});

test('caller abort settles a stalled first discovery without cancelling it', async () => {
  let finish: (client: IMcpClient) => void = () => {};
  const stalled = new Promise<IMcpClient>((resolve) => {
    finish = resolve;
  });
  const connect = jest.fn(() => stalled);
  const external = new ExternalMcp(
    parseExternalMcp({ LLM_AGENT_EXECUTOR_MCP: 'docs' }),
    () => [],
    connect,
  );
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  const ready = external.clients('executor', { signal: controller.signal });
  controller.abort(reason);
  try {
    await expect(ready).rejects.toBe(reason);
    expect(external.catalogue()).toEqual([]);
  } finally {
    finish(adapter);
  }
  const clients = await external.clients('executor');
  expect(connect).toHaveBeenCalledTimes(1);
  expect(clients).toHaveLength(1);
  expect(await clients[0].listTools()).toEqual(await adapter.listTools());
});

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
    trust: 3.5,
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
  expect(messages[1].content).toContain('[source: docs:search; trust 3.5]');
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

test('background discovery never waits for a hung destination and retries after cooldown', async () => {
  jest.useFakeTimers();
  try {
    let reachable = false;
    const external = new ExternalMcp(
      parseExternalMcp({
        LLM_AGENT_EXECUTOR_MCP: 'docs',
        LLM_AGENT_CHECKER_MCP: 'docs',
        LLM_AGENT_PLANNER_MCP: 'docs',
      }),
      () => [],
      () =>
        reachable
          ? Promise.resolve(adapter)
          : new Promise<IMcpClient>(() => {}),
      jest.fn(),
    );
    external.refresh();
    for (const role of ['executor', 'checker', 'planner'] as const)
      expect(external.catalogue(role)).toEqual([]);
    await jest.advanceTimersByTimeAsync(10000);
    reachable = true;
    await jest.advanceTimersByTimeAsync(30001);
    external.refresh();
    await jest.advanceTimersByTimeAsync(0);
    for (const role of ['executor', 'checker', 'planner'] as const)
      expect(external.catalogue(role)).toEqual([
        { name: 'search', effect: 'read' },
      ]);
  } finally {
    jest.useRealTimers();
  }
});

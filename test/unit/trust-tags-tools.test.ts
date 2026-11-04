import {
  InMemoryRag,
  type ISkill,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { systemToolTrust } from '../../srv/lib/system-tool-trust';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';
import { TrustStore } from '../../srv/lib/trust-store';
import {
  trustedSkillResults,
  withSkillTrust,
} from '../../srv/lib/trusted-skill';

function fixtureSkill(name = 'info', kind = 'informational'): ISkill {
  return {
    name,
    description: 'description',
    meta: { name, description: 'description', kind },
    getContent: async () => ({ ok: true, value: 'body' }),
    listResources: async () => ({ ok: true, value: [] }),
    readResource: async () => ({ ok: true, value: 'resource' }),
  };
}
const resolver = new TrustResolver(
  undefined,
  undefined,
  parseTrustDefaults(undefined),
);
test.each(['chat', 'planner', 'executor', 'checker'])(
  '%s uses only registry tool names and its profile',
  (role) => {
    const trust = systemToolTrust(
      (n) => n === 'GetClass',
      resolver.forProfile({ trust: { target: role === 'checker' ? 5 : 4 } }),
    );
    expect(trust('GetClass')).toEqual({
      source: 'target:GetClass',
      trust: role === 'checker' ? 5 : 4,
    });
    for (const name of ['rag_read', 'get_task', 'delegate_task'])
      expect(trust(name)).toBeUndefined();
  },
);
test('skill bodies and descriptions resolve live without modifying raw content or tool groups', async () => {
  const store = new TrustStore(new InMemoryRag(), 1);
  const live = new TrustResolver(
    undefined,
    store,
    parseTrustDefaults(undefined),
  );
  const skill = fixtureSkill();
  const wrapped = withSkillTrust(skill, () => live.skill(skill.name));
  const rows = [
    { text: 'description', score: 1, metadata: { id: 'skill:info' } },
    { text: 'tool group', score: 1, metadata: { id: 'tool:GetClass' } },
  ];
  expect(await wrapped.getContent()).toEqual({
    ok: true,
    value: '[source: system:skills/info; trust 4.8]\nbody',
  });
  expect((await trustedSkillResults(rows, live))[0].metadata.trust).toBe(4.8);
  await store.setRecord('skills', 'info', 2, 'admin');
  expect(await wrapped.getContent()).toEqual({
    ok: true,
    value: '[source: system:skills/info; trust 2]\nbody',
  });
  const next = await trustedSkillResults(rows, live);
  expect(next[0].metadata).toEqual({
    id: 'skill:info',
    source: 'system:skills/info',
    trust: 2,
  });
  expect(next[1]).toEqual(rows[1]);
  expect(await skill.getContent()).toEqual({ ok: true, value: 'body' });
  expect(await wrapped.readResource('x')).toEqual({
    ok: true,
    value: 'resource',
  });
});

import {
  type ILlm,
  type IMcpClient,
  type Message,
  type ToolCallRecord,
  type ToolTrace,
  ToolTraceCollector,
} from '@mcp-abap-adt/llm-agent';
import {
  PlannerToolsClient,
  runInPlannerScope,
  SmartAgentBuilder,
  TaskBoard,
} from '@mcp-abap-adt/llm-agent-libs';
import { ContextAssembler } from '../../node_modules/@mcp-abap-adt/llm-agent-libs/dist/context/context-assembler';
import { renderToolTrace } from '../../node_modules/@mcp-abap-adt/llm-agent-libs/dist/coordinator/dialogue/tool-trace-render';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { parseToolOutcome } from '../../srv/lib/reviewer-core';

test.each(['chat', 'planner', 'executor', 'checker'])(
  '%s real model boundary tags once after raw capture and truncation',
  async () => {
    const seen: Message[][] = [];
    const response: ILlm['chat'] = async (messages) => {
      seen.push(messages);
      if (messages.some((m) => m.role === 'tool'))
        return { ok: true, value: { content: 'done', finishReason: 'stop' } };
      return {
        ok: true,
        value: {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'sap', name: 'GetClass', arguments: {} },
            { id: 'rag', name: 'rag_read', arguments: {} },
            { id: 'hub', name: 'get_task', arguments: {} },
          ],
        },
      };
    };
    const llm: ILlm = {
      chat: response,
      streamChat: async function* (m, t, o) {
        yield await response(m, t, o);
      },
    };
    const raw: IMcpClient = {
      listTools: async () => ({
        ok: true,
        value: ['GetClass', 'rag_read', 'get_task'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object', properties: {} },
        })),
      }),
      callTool: async () => ({ ok: true, value: { content: 'x'.repeat(80) } }),
    };
    const recording = new RecordingMcpClient(raw, undefined, 20);
    const toolTrust = systemToolTrust((n) => n === 'GetClass', resolver);
    const collector = new ToolTraceCollector();
    const { agent } = await new SmartAgentBuilder({
      skipModelValidation: true,
      agent: { mode: 'hard', classificationEnabled: false, maxIterations: 4 },
    })
      .withMainLlm(llm)
      .withClassification(false)
      .withMcpClients([recording])
      .withToolTrust(toolTrust)
      .build();
    const result = await agent.process('read', {
      trace: { traceId: 'raw' },
      onToolTrace: (entry) => collector.observe(entry),
    });
    expect(result.ok).toBe(true);
    const model = seen.flat().filter((m) => m.role === 'tool');
    const sap = model.find((m) => m.tool_call_id === 'sap');
    expect(sap?.content).toContain('[source: target:GetClass; trust 4.3]\n');
    expect(String(sap?.content).match(/\[source:/g)).toHaveLength(1);
    expect(String(sap?.content).match(/\[result truncated:/g)).toHaveLength(1);
    for (const id of ['rag', 'hub'])
      expect(model.find((m) => m.tool_call_id === id)?.content).not.toContain(
        '[source:',
      );
    const records = recording.getToolRecords('raw');
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain('[source:');
      expect(parseToolOutcome(record).name).toBe(record.call.name);
    }
    const trace = collector.snapshot();
    expect(JSON.stringify(trace)).not.toContain('[source:');
    const evidence = renderToolTrace('t1', trace, toolTrust);
    expect(
      evidence.match(/\[source: target:GetClass; trust 4.3\]/g),
    ).toHaveLength(1);
    expect(evidence).toContain(
      '[source: target:GetClass; trust 4.3] result: "',
    );
    const assembled = await new ContextAssembler({ toolTrust }).assemble(
      { type: 'action', text: 'read' },
      { ragResults: {}, tools: [] },
      records,
    );
    expect(
      assembled.ok && assembled.value.map((m) => m.content).join('\n'),
    ).toContain('[source: target:GetClass; trust 4.3]');
  },
);

test('get_task projects embedded traces once without modifying board evidence', async () => {
  const trace: ToolTrace = {
    entries: [
      {
        sequence: 1,
        toolName: 'GetClass',
        arguments: '{}',
        resultExcerpt: 'raw',
        outcome: 'ok',
      },
    ],
    complete: true,
    omittedCount: 0,
  };
  const board = new TaskBoard({ workers: new Map(), onEvent: () => {} });
  board.restore([
    {
      id: 't1',
      worker: 'executor',
      goal: 'read',
      state: 'done',
      createdAt: 1,
      toolTrace: trace,
    },
  ]);
  const toolTrust = systemToolTrust((n) => n === 'GetClass', resolver);
  const client = new PlannerToolsClient(toolTrust);
  for (let i = 0; i < 2; i++) {
    const result = await runInPlannerScope(
      { board, getPlan: () => undefined, setPlan: () => {} },
      () =>
        client.callTool('get_task', {
          task_id: 't1',
          include_trace: true,
        }),
    );
    expect(
      result.ok &&
        JSON.stringify(result.value).match(
          /\[source: target:GetClass; trust 4.3\]/g,
        ),
    ).toHaveLength(1);
  }
  expect(board.get('t1')?.toolTrace).toEqual(trace);
  expect(JSON.stringify(trace)).not.toContain('[source:');
});

import type { IRag } from '@mcp-abap-adt/llm-agent';
import {
  NoopMetrics,
  NoopRequestLogger,
  NoopReranker,
  NoopSessionManager,
  NoopTracer,
} from '@mcp-abap-adt/llm-agent-libs';
import { RagOrchestrator } from '../../node_modules/@mcp-abap-adt/llm-agent-libs/dist/agent/rag-orchestrator';
import { ToolAvailabilityRegistry } from '../../node_modules/@mcp-abap-adt/llm-agent-libs/dist/policy/tool-availability-registry';
import { CompositeSkillManager } from '../../srv/lib/composite-skill-manager';

test.each(['pipeline', 'rag-orchestrator'])(
  '%s selects informational skills semantically and resolves body and description trust live on an existing agent',
  async (path) => {
    const store = new TrustStore(new InMemoryRag(), 1);
    const live = new TrustResolver(
      undefined,
      store,
      parseTrustDefaults(undefined),
    );
    const skill = {
      ...fixtureSkill(),
      name: 'shared display name',
      meta: { ...fixtureSkill().meta, id: 'info', name: 'shared display name' },
    };
    const base = {
      ...fixtureSkill('base', 'base'),
      name: 'shared display name',
      meta: {
        ...fixtureSkill('base', 'base').meta,
        id: 'base',
        name: 'shared display name',
      },
    };
    const manager = new CompositeSkillManager(
      [
        {
          source: 'plugin',
          manager: {
            listSkills: async () => ({
              ok: true,
              value: [skill, base],
            }),
            getSkill: async () => ({ ok: true, value: skill }),
            matchSkills: async () => ({ ok: true, value: [skill] }),
          },
        },
      ],
      () => live,
    );
    let selected = true;
    const rawRows = [
      { text: 'description', score: 1, metadata: { id: 'skill:info' } },
    ];
    const rag: IRag = {
      query: async () => ({
        ok: true,
        value: await trustedSkillResults(selected ? rawRows : [], live),
      }),
      getById: async () => ({ ok: true, value: null }),
      healthCheck: async () => ({ ok: true, value: undefined }),
    };
    let messages: Message[] = [];
    const response: ILlm['chat'] = async (m) => {
      messages = m;
      return { ok: true, value: { content: 'done', finishReason: 'stop' } };
    };
    const llm: ILlm = {
      chat: response,
      streamChat: async function* (m, t, o) {
        yield await response(m, t, o);
      },
    };
    const builder = new SmartAgentBuilder({
      skipModelValidation: true,
      agent: { mode: 'hard', classificationEnabled: false, ragQueryK: 5 },
    })
      .withMainLlm(llm)
      .withClassification(false)
      .withSkillManager(manager.informationalSkills())
      .setToolsRag(rag);
    const { agent } = await builder.build();
    const tracer = new NoopTracer();
    const orchestrator = new RagOrchestrator({
      mainLlm: llm,
      helperLlm: undefined,
      classifier: {
        classify: async () => ({
          ok: true,
          value: [{ type: 'action', text: 'q' }],
        }),
      },
      config: { mode: 'hard', classificationEnabled: false, maxIterations: 4 },
      tracer,
      metrics: new NoopMetrics(),
      reranker: new NoopReranker(),
      queryExpander: { expand: async (q) => ({ ok: true, value: q }) },
      sessionManager: new NoopSessionManager(),
      toolAvailabilityRegistry: new ToolAvailabilityRegistry(),
      mcpToolRegistry: {
        resolve: async () => ({ tools: [], toolClientMap: new Map() }),
        resolveActiveClients: async () => {},
        getActiveClients: () => [],
      },
      requestLogger: new NoopRequestLogger(),
      ragStores: { facts: rag },
      embedder: undefined,
      assembler: new ContextAssembler(),
      skillManager: manager.informationalSkills(),
      translateQueryStores: undefined,
    });
    const run = async () => {
      if (path === 'pipeline') {
        const result = await agent.process('q');
        if (!result.ok) throw result.error;
      } else {
        const result = await orchestrator.orchestrate('q', {
          mode: 'hard',
          opts: undefined,
          rootSpan: tracer.startSpan('test'),
          sessionId: 'test',
          externalTools: [],
        });
        if (!result.ok) throw result.error;
        messages = result.value.assembledMessages;
      }
      return messages.map((m) => m.content).join('\n');
    };
    expect(await run()).toContain(
      '[source: system:skills/info; trust 4.8]\nbody',
    );
    await store.setRecord('skills', 'info', 2, 'admin');
    const next = await run();
    expect(next).toContain('[source: system:skills/info; trust 2]\nbody');
    expect(next).toContain('[source: system:skills/info; trust 2] description');
    expect(next).not.toContain('trust 3]');
    selected = false;
    expect(await run()).not.toContain('## Active Skills');
  },
);

import {
  type IToolLoopContextStrategy,
  type ToolRound,
  toModelToolMessages,
} from '@mcp-abap-adt/llm-agent';
import {
  LegacyAccumulateContextStrategy,
  LegacyTranscriptContextStrategy,
  RagRecallContextStrategy,
  WindowContextStrategy,
} from '../../node_modules/@mcp-abap-adt/llm-agent-libs/dist/pipeline/context/tool-loop-context';

test('every history strategy replays one system tag and preserves raw state', async () => {
  const round: ToolRound = {
    assistant: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'sap',
          type: 'function',
          function: { name: 'GetClass', arguments: '{}' },
        },
      ],
    },
    results: [{ role: 'tool', tool_call_id: 'sap', content: 'raw' }],
  };
  const strategies: IToolLoopContextStrategy[] = [
    new LegacyAccumulateContextStrategy(),
    new LegacyTranscriptContextStrategy({ rawMessages: [] }),
    new WindowContextStrategy(),
    new RagRecallContextStrategy(
      { record: async () => {}, recall: async () => ({ rounds: [] }) },
      { runId: 'test' },
    ),
  ];
  const toolTrust = systemToolTrust((n) => n === 'GetClass', resolver);
  for (const strategy of strategies) {
    await strategy.record(round);
    for (let i = 0; i < 2; i++) {
      const model = toModelToolMessages(
        await strategy.form({ prefix: [], toolTrust }),
        toolTrust,
      );
      expect(
        model
          .map((m) => m.content)
          .join('\n')
          .match(/\[source: target:GetClass; trust 4.3\]/g),
      ).toHaveLength(1);
    }
    expect(JSON.stringify(strategy.snapshot())).not.toContain('[source:');
  }
  expect(round.results[0].content).toBe('raw');
});

import { ExpositionFilteringRag } from '../../srv/agent-manager';
import { runWithTrustResolver } from '../../srv/lib/trust-resolver';

test('hub tools/skills store projects live trust using the querying role and leaves MCP groups untagged', async () => {
  const store = new TrustStore(new InMemoryRag(), 1);
  const live = new TrustResolver(
    undefined,
    store,
    parseTrustDefaults(undefined),
    { global: 3 },
  );
  const rows = [
    { text: 'description', score: 1, metadata: { id: 'skill:info' } },
    {
      text: 'group',
      score: 0.9,
      metadata: { id: 'tool:GetClass', exposition: 'readonly' },
    },
  ];
  const inner: IRag = {
    query: async () => ({ ok: true, value: rows }),
    getById: async () => ({ ok: true, value: null }),
    healthCheck: async () => ({ ok: true, value: undefined }),
  };
  const rag = new ExpositionFilteringRag(
    inner,
    undefined,
    undefined,
    3,
    undefined,
    undefined,
    'off',
    'hard',
  );
  const query = () =>
    runWithTrustResolver(live, () =>
      rag.query(new TextOnlyEmbedding('q'), 10, {
        ragFilter: { exposition: ['readonly'] },
      }),
    );
  const first = await query();
  expect(
    first.ok &&
      first.value.find((row) => row.metadata.id === 'skill:info')?.metadata
        .trust,
  ).toBe(4.8);
  await store.setRecord('skills', 'info', 1, 'admin');
  const next = await query();
  expect(
    next.ok &&
      next.value.find((row) => row.metadata.id === 'skill:info')?.metadata,
  ).toEqual({
    id: 'skill:info',
    source: 'system:skills/info',
    trust: 1,
  });
  expect(
    next.ok &&
      next.value.find((row) => row.metadata.id === 'tool:GetClass')?.metadata,
  ).not.toHaveProperty('trust');
  expect(rows[0].metadata).not.toHaveProperty('trust');
});

import type { DialogueState } from '@mcp-abap-adt/llm-agent';
import { DialogueSession } from '@mcp-abap-adt/llm-agent-libs';

test('DialogueSession forwards coordinator trust to its internal get_task client without changing persisted traces', async () => {
  const trace: ToolTrace = {
    entries: [
      {
        sequence: 1,
        toolName: 'GetClass',
        arguments: '{}',
        resultExcerpt: 'raw',
        outcome: 'ok',
      },
    ],
    complete: true,
    omittedCount: 0,
  };
  let state: DialogueState = {
    conversation: [],
    tasks: [
      {
        id: 't1',
        worker: 'executor',
        goal: 'read',
        state: 'done',
        createdAt: 1,
        toolTrace: trace,
      },
    ],
    pending: [],
    savedAt: 1,
  };
  const session = await DialogueSession.open({
    id: 'trust',
    toolTrust: systemToolTrust(
      (n) => n === 'GetClass',
      resolver.forProfile({ trust: { target: 3 } }),
    ),
    board: { workers: new Map() },
    store: {
      load: async () => state,
      save: async (_id, next) => {
        state = next;
      },
      delete: async () => {},
    },
    planner: {
      process: async () => ({ ok: true, value: { content: 'done' } }),
    },
    maxCorrections: 0,
  });
  try {
    for (let i = 0; i < 2; i++) {
      const result = await session.callTool('get_task', {
        task_id: 't1',
        include_trace: true,
      });
      expect(
        result.ok &&
          JSON.stringify(result.value).match(
            /\[source: target:GetClass; trust 3\]/g,
          ),
      ).toHaveLength(1);
    }
    expect(session.snapshot().tasks[0].toolTrace).toEqual(trace);
    expect(JSON.stringify(state.tasks)).not.toContain('[source:');
  } finally {
    await session.close();
  }
});

import type { IMcpClient, ISubAgent } from '@mcp-abap-adt/llm-agent';
import { InMemoryRag, TextOnlyEmbedding } from '@mcp-abap-adt/llm-agent';
import type { z } from 'zod';
import { ExpositionFilteringRag } from '../../srv/agent-manager';
import {
  sessionCollectionId,
  userCollectionId,
} from '../../srv/collection-ids';
import {
  AgentToolPermissions,
  effectiveProfileTools,
  guardProfileWorker,
  type RegisteredProfileTool,
} from '../../srv/lib/agent-profile-tools';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { assertToolAllowed } from '../../srv/lib/tool-authorization';
import { CollectionRegistry } from '../../srv/rag-collections';
import {
  buildRagToolSchemas,
  dispatchRagTool,
} from '../../srv/rag-tool-dispatcher';
import {
  profileToolAllowed,
  runWithProfileTools,
  runWithReadOnlyTools,
  runWithRequiredProfileTools,
  runWithSessionId,
} from '../../srv/request-session';

const catalogue: RegisteredProfileTool[] = [
  { name: 'GetTable', effect: 'read' },
  { name: 'CreateTable', effect: 'write' },
  { name: 'GetDumpSection', effect: 'read' },
  { name: 'rag_list', effect: 'read' },
  { name: 'rag_add', effect: 'write' },
];
const grants = new Set(catalogue.map((tool) => tool.name));
test('ceilings, caller grants, deny and inherited permissions intersect', () => {
  const verdict = effectiveProfileTools({
    catalogue,
    grants,
    result: 'verdict',
    policy: 'all',
  });
  expect(verdict.allows('CreateTable')).toBe(false);
  expect(verdict.allows('GetTable')).toBe(true);
  expect(verdict.allows('Unknown')).toBe(false);
  const empty = effectiveProfileTools({
    catalogue,
    grants,
    result: 'report',
    policy: { allow: [] },
  });
  expect(empty.allows('GetTable')).toBe(false);
  const child = effectiveProfileTools({
    catalogue,
    grants,
    parent: verdict,
    result: 'report',
    policy: { allow: ['GetTable', 'CreateTable'], deny: ['GetTable'] },
  });
  expect(child.allows('GetTable')).toBe(false);
  expect(child.allows('CreateTable')).toBe(false);
  expect(
    effectiveProfileTools({
      catalogue,
      grants: new Set(),
      result: 'report',
      policy: 'all',
    }).allows('GetTable'),
  ).toBe(false);
  expect(() =>
    effectiveProfileTools({
      catalogue,
      grants,
      result: 'report',
      policy: { allow: ['Unknown'] },
    }),
  ).toThrow('Unregistered');
  expect(() =>
    effectiveProfileTools({
      catalogue: [...catalogue, ...catalogue],
      grants,
      result: 'report',
      policy: 'all',
    }),
  ).toThrow('Ambiguous');
});
test('nested scopes cannot widen; required lost scopes and forged local calls fail closed', () => {
  runWithRequiredProfileTools(() =>
    expect(profileToolAllowed('GetTable')).toBe(false),
  );
  runWithProfileTools(new AgentToolPermissions(['GetTable']), () => {
    runWithProfileTools(new AgentToolPermissions(['CreateTable']), () =>
      expect(profileToolAllowed('CreateTable')).toBe(false),
    );
    expect(() =>
      assertToolAllowed('GetDumpSection', 'system', ['system']),
    ).toThrow('forbids');
    expect(() => assertToolAllowed('CreateTable', 'high', ['high'])).toThrow(
      'forbids',
    );
    expect(() =>
      assertToolAllowed('GetTable', 'readonly', ['readonly']),
    ).not.toThrow();
  });
});
test('MCP filters definitions and rejects forged invocation before backend side effects', async () => {
  const call = jest.fn<
    ReturnType<IMcpClient['callTool']>,
    Parameters<IMcpClient['callTool']>
  >(async () => ({ ok: true, value: { content: 'read' } }));
  const inner: IMcpClient = {
    listTools: async () => ({
      ok: true,
      value: catalogue.map((tool) => ({
        name: tool.name,
        description: '',
        inputSchema: {},
      })),
    }),
    callTool: call,
  };
  const client = new RecordingMcpClient(inner);
  await runWithProfileTools(
    new AgentToolPermissions(['GetTable']),
    async () => {
      expect(await client.listTools()).toMatchObject({
        ok: true,
        value: [{ name: 'GetTable' }],
      });
      expect(await client.callTool('CreateTable', {})).toMatchObject({
        ok: true,
        value: { isError: true },
      });
      expect(call).not.toHaveBeenCalled();
      expect(await client.callTool('GetTable', {})).toMatchObject({
        ok: true,
        value: { content: 'read' },
      });
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
});
test('direct RAG calls are guarded before any registry operation, including legacy read-only scope', async () => {
  const registry = new CollectionRegistry();
  const create = jest.spyOn(registry, 'getOrCreateCollection');
  await runWithProfileTools(
    new AgentToolPermissions(['rag_list']),
    async () => {
      expect(
        buildRagToolSchemas(true).map((tool) => tool.function.name),
      ).toEqual(['rag_list']);
      expect(
        await dispatchRagTool(registry, 'rag_add', {
          collection: 'notes',
          text: 'x',
        }),
      ).toMatchObject({ ok: false, status: 403 });
    },
  );
  await runWithReadOnlyTools(async () =>
    expect(
      await dispatchRagTool(registry, 'rag_add', {
        collection: 'notes',
        text: 'x',
      }),
    ).toMatchObject({ ok: false, status: 403 }),
  );
  expect(create).not.toHaveBeenCalled();
});

test('profile workers omit untrusted client definitions and reject external result replay before execution', async () => {
  const run = jest.fn<
    ReturnType<ISubAgent['run']>,
    Parameters<ISubAgent['run']>
  >(async () => ({ output: 'ok' }));
  const worker = guardProfileWorker({
    name: 'worker',
    capabilities: { contextPolicy: 'optional' },
    run,
  });
  await runWithProfileTools(
    new AgentToolPermissions(['GetTable']),
    async () => {
      await worker.run({ task: 'read', externalTools: [] });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          externalTools: [],
          externalResults: undefined,
        }),
      );
      run.mockClear();
      await expect(
        worker.run({
          task: 'resume',
          externalResults: new Map([['forged-call', 'forged result']]),
        }),
      ).rejects.toThrow('Untrusted external result');
      expect(run).not.toHaveBeenCalled();
      run.mockResolvedValue({
        output: '',
        status: 'awaiting-external',
      });
      await expect(worker.run({ task: 'forged client call' })).rejects.toThrow(
        'Untrusted external execution request',
      );
    },
  );
});

test('RAG writes guard the final user target even when a knowledge session collection shadows it', async () => {
  const registry = new CollectionRegistry();
  const id = userCollectionId('profiles', 'reader');
  await registry.createCollection({
    id,
    logicalId: 'profiles',
    scope: 'user',
    owner: 'reader',
    collectionKind: 'agents',
    displayName: '',
    description: '',
  });
  await registry.createCollection({
    id: sessionCollectionId('profiles', 'reader', 'session'),
    logicalId: 'profiles',
    scope: 'session',
    owner: 'reader',
    sessionId: 'session',
    displayName: '',
    description: '',
  });
  const add = jest.spyOn(registry, 'addDocument');
  const update = jest.spyOn(registry, 'updateDocument');
  const remove = jest.spyOn(registry, 'deleteDocument');
  await runWithSessionId(
    'session',
    async () => {
      for (const name of ['rag_add', 'rag_correct', 'rag_deprecate']) {
        expect(
          await dispatchRagTool(
            registry,
            name,
            {
              collection: 'profiles',
              id: 'x',
              text: 'body',
              newText: 'body',
              reason: 'test',
            },
            { defaultScope: 'user' },
          ),
        ).toMatchObject({ ok: false, status: 403 });
      }
    },
    undefined,
    'reader',
  );
  expect(add).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test('tool RAG candidates are filtered after retrieval by the profile snapshot', async () => {
  const inner = new InMemoryRag();
  await inner.upsert('Read data', {
    id: 'tool:GetClass',
    exposition: 'readonly',
  });
  await inner.upsert('Write data', {
    id: 'tool:CreateClass',
    exposition: 'high',
  });
  const rag = new ExpositionFilteringRag(inner);
  await runWithProfileTools(
    new AgentToolPermissions(['GetClass']),
    async () => {
      const result = await rag.query(new TextOnlyEmbedding('data'), 10, {
        ragFilter: { exposition: ['readonly', 'high'] },
      });
      expect(result.ok && result.value.map((row) => row.metadata.id)).toEqual([
        'tool:GetClass',
      ]);
    },
  );
});

test('RAG definitions expose typed JSON schema keywords', () => {
  for (const tool of buildRagToolSchemas(true)) {
    const schemaType: z.core.JSONSchema.JSONSchema['type'] =
      tool.function.parameters.type;
    expect(schemaType).toBe('object');
    expect(tool.function.parameters.properties).toHaveProperty('collection');
  }
});

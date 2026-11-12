import {
  type IRagProvider,
  isRagScanner,
  symmetricEmbedder,
  VectorRag,
  validateRagMetadata,
} from '@mcp-abap-adt/llm-agent';
import {
  dialogueId,
  ProviderDialogueStore,
} from '../../srv/lib/dialogue-store';
import { scopedPlannerMemory } from '../../srv/lib/planner-memory-scope';
import {
  ProviderRunRecordStore,
  runRecordId,
} from '../../srv/lib/run-record-store';
import { ProviderSessionRecordStore } from '../../srv/lib/session-record-store';
import { runWithSessionId } from '../../srv/request-session';

const embedder = symmetricEmbedder({ embed: async () => ({ vector: [1, 0] }) });

it('hub stores write no library identity keys', async () => {
  const stores = new Map<string, VectorRag>();
  const scans = new Map<string, jest.SpyInstance>();
  const provider: IRagProvider = {
    name: 'test',
    kind: 'vector',
    editable: true,
    supportedScopes: ['global'],
    async createCollection(name) {
      const rag = stores.get(name) ?? new VectorRag(embedder);
      stores.set(name, rag);
      scans.set(name, jest.spyOn(rag, 'scan'));
      return {
        ok: true,
        value: {
          rag,
          editor: {
            upsert: async () => {
              throw new Error('Raw writes required');
            },
            deleteById: async () => {
              throw new Error('Raw writes required');
            },
          },
        },
      };
    },
  };
  const dialogue = new ProviderDialogueStore(provider, { dimension: 2 });
  const state = {
    conversation: [],
    plan: '',
    tasks: [],
    pending: [],
    savedAt: 1,
  };
  await dialogue.save('alice', 's1', state);
  expect(await dialogue.load('alice', 's1')).toEqual(state);
  expect(await dialogue.load('bob', 's1')).toBeUndefined();
  expect(await dialogue.load('alice', 's2')).toBeUndefined();

  const runs = new ProviderRunRecordStore(provider, { dimension: 2 });
  const record = {
    runId: 'r',
    request: 'hello',
    plan: { steps: [], createdAt: 1 },
    steps: [],
    outcome: 'answered' as const,
    finishedAt: 2,
  };
  await runWithSessionId('s1', () => runs.save('s1', record), [], 'alice');
  expect(
    await runWithSessionId('s1', () => runs.load('s1'), [], 'alice'),
  ).toEqual(record);
  expect(
    await runWithSessionId('s1', () => runs.load('s1'), [], 'bob'),
  ).toBeUndefined();
  expect(
    await runWithSessionId('s2', () => runs.load('s2'), [], 'alice'),
  ).toBeUndefined();

  const sessions = new ProviderSessionRecordStore(provider, { dimension: 2 });
  const session = {
    userId: 'alice',
    key: 's1',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    ttlMs: 3600000,
  };
  await sessions.put(session);
  expect(await sessions.get('alice', 's1')).toEqual(session);
  expect(await sessions.get('bob', 's1')).toBeUndefined();
  expect(await sessions.get('alice', 's2')).toBeUndefined();

  const planner = new VectorRag(embedder);
  stores.set('h_planner_memory', planner);
  await scopedPlannerMemory(planner, '["alice","s1"]', 's1')
    .writer?.()
    ?.upsertRaw('p', 'memory', {
      sessionId: 's1',
      userId: 'alice',
      roleId: 'r',
    });
  for (const [name, rag] of stores) {
    expect(isRagScanner(rag)).toBe(true);
    if (name !== 'h_planner_memory')
      expect(scans.get(name)).not.toHaveBeenCalled();
    const page = await rag.scan();
    if (!page.ok) throw page.error;
    expect(page.value.records).toHaveLength(1);
    const row = page.value.records[0];
    expect(row.metadata).not.toHaveProperty('userId');
    expect(row.metadata).not.toHaveProperty('sessionId');
    expect(row.metadata).not.toHaveProperty('roleId');
    expect(() => validateRagMetadata(row.metadata)).not.toThrow();
    expect(
      name === 'h_planner_memory'
        ? row.metadata.namespace
        : row.metadata.hubSessionId,
    ).toBe(name === 'h_planner_memory' ? '["alice","s1"]' : 's1');
    if (name !== 'h_planner_memory')
      expect(row.metadata.authorUserId).toBe('alice');
    if (name === 'h_dialogue') expect(row.id).toBe(dialogueId('alice', 's1'));
    if (name === 'h_runs') expect(row.id).toBe(runRecordId('alice', 's1'));
  }
});

import { InMemoryRag, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { parsePlannerKnowledge } from '../../srv/agent-config';
import {
  plannerContext,
  plannerMemoryStore,
} from '../../srv/lib/planner-context';

describe('planner context', () => {
  const rag = new InMemoryRag();
  const retrieval = symmetricEmbedder({
    embed: async (_text: string) => ({ vector: [1, 0] }),
  });
  const embedding = { retrieval, key: 'test-space' };

  it.each(['in-memory', 'vector', 'qdrant', 'hana-vector', 'pg-vector'])(
    'selects the session memory path for %s',
    (kind) => {
      const create = jest.fn(() => rag);
      const persistent = jest.fn(() => rag);
      const result = plannerMemoryStore({ kind, create, persistent });
      expect(result).toBe(kind === 'in-memory' ? undefined : rag);
      expect(create).toHaveBeenCalledTimes(
        kind === 'vector' || kind === 'qdrant' ? 1 : 0,
      );
      if (create.mock.calls.length)
        expect(create).toHaveBeenCalledWith('session', 'planner-memory');
      expect(persistent).toHaveBeenCalledTimes(
        kind === 'hana-vector' || kind === 'pg-vector' ? 1 : 0,
      );
    },
  );

  it('uses the same embedding space for both memory roles and knowledge', async () => {
    const result = await plannerContext({
      memory: () => rag,
      embedding,
      names: ['planning'],
      collection: async () => rag,
      warn: jest.fn(),
    });
    expect(result.plannerMemory).toEqual({
      rag,
      queryEmbedder: retrieval,
      documentEmbedder: retrieval,
      embeddingKey: embedding.key,
    });
    expect(result.plannerKnowledge?.[0].embeddingKey).toBe(embedding.key);
    expect(result.plannerKnowledge?.[0].name).toBe('planning');
  });

  it('omits unavailable memory and missing knowledge with one warning each', async () => {
    const warn = jest.fn();
    const result = await plannerContext({
      memory: () => {
        throw new Error('store down');
      },
      embedding,
      names: ['planning'],
      collection: async () => null,
      warn,
    });
    expect(result.plannerMemory).toBeUndefined();
    expect(result.plannerKnowledge).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      'Planner knowledge collection missing: planning',
    );
  });

  it('omits memory without an embedding backend', async () => {
    const memory = jest.fn(() => rag);
    expect(
      await plannerContext({
        memory,
        names: [],
        collection: async () => null,
        warn: jest.fn(),
      }),
    ).toEqual({});
    expect(memory).not.toHaveBeenCalled();
  });

  it('parses the default, a list, duplicates, and explicit disablement', () => {
    expect(parsePlannerKnowledge({})).toEqual(['planning']);
    expect(
      parsePlannerKnowledge({
        LLM_AGENT_PLANNER_KNOWLEDGE: ' planning, review,planning, ',
      }),
    ).toEqual(['planning', 'review']);
    expect(parsePlannerKnowledge({ LLM_AGENT_PLANNER_KNOWLEDGE: '' })).toEqual(
      [],
    );
  });

  it('rejects more than ten collections', () => {
    expect(() =>
      parsePlannerKnowledge({
        LLM_AGENT_PLANNER_KNOWLEDGE: Array.from(
          { length: 11 },
          (_, index) => `c${index}`,
        ).join(','),
      }),
    ).toThrow('at most 10');
  });
});

it('checks knowledge enablement on every search after opening', async () => {
  const rag = new InMemoryRag();
  const query = jest.spyOn(rag, 'query');
  let enabled = false;
  const result = await plannerContext({
    memory: () => undefined,
    embedding: {
      retrieval: symmetricEmbedder({ embed: async () => ({ vector: [1, 0] }) }),
      key: 'test',
    },
    names: ['planning'],
    collection: async () => rag,
    enabled: async () => enabled,
    warn: jest.fn(),
  });
  const knowledge = result.plannerKnowledge?.[0];
  if (!knowledge) throw new Error('missing knowledge');
  expect(await knowledge.search({ text: 'question' }, 3)).toEqual([]);
  expect(query).not.toHaveBeenCalled();
  enabled = true;
  await knowledge.search({ text: 'question' }, 3);
  expect(query).toHaveBeenCalledTimes(1);
  enabled = false;
  await knowledge.search({ text: 'question' }, 3);
  expect(query).toHaveBeenCalledTimes(1);
});

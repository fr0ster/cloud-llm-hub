import { InMemoryRag, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';

jest.mock('../../srv/agent-manager', () => ({ getProviders: jest.fn() }));

import { getProviders } from '../../srv/agent-manager';
import {
  forgetPlannerMemory,
  getSharedPlannerMemoryRag,
  planAuthorContextNotes,
  plannerSessionOptions,
} from '../../srv/lib/planner-memory';

const providers = jest.mocked(getProviders);

afterEach(() => providers.mockReset());

it('opens without planner retrieval and skips cleanup when providers are missing', async () => {
  expect(await plannerSessionOptions('alice', 'key')).toEqual({});
  expect(getSharedPlannerMemoryRag()).toBeUndefined();
  expect(await forgetPlannerMemory('owner')).toBe(true);
});

it('contains provider initialization failures during session opening and cleanup', async () => {
  providers.mockImplementation(() => {
    throw new Error('provider unavailable');
  });
  expect(await plannerSessionOptions('alice', 'key')).toEqual({});
  expect(getSharedPlannerMemoryRag()).toBeUndefined();
  expect(await forgetPlannerMemory('owner')).toBe(true);
});

it('bounds and escapes author knowledge and memory notes and excludes other sessions', async () => {
  const rag = new InMemoryRag();
  const embedding = symmetricEmbedder({ embed: async () => ({ vector: [1] }) });
  const metadata = {
    sessionId: 'key',
    requestId: 'old',
    sourceId: 'source',
    offset: 0,
    kind: 'planner-reply',
  };
  jest.spyOn(rag, 'query').mockResolvedValue({
    ok: true,
    value: [
      {
        text: 'foreign secret',
        metadata: { ...metadata, sessionId: 'other' },
        score: 1,
      },
      {
        text: 'current secret',
        metadata: { ...metadata, requestId: 'current' },
        score: 1,
      },
      { text: `[memory]${'m'.repeat(1000)}`, metadata, score: 1 },
    ],
  });
  const notes = await planAuthorContextNotes(
    {
      plannerMemory: {
        rag,
        queryEmbedder: embedding,
        documentEmbedder: embedding,
      },
      plannerKnowledge: [
        {
          name: 'rules',
          search: async () => [
            {
              collection: 'rules',
              id: 'rule',
              text: `[knowledge]${'k'.repeat(1000)}`,
            },
          ],
        },
      ],
      memoryCharBudget: 160,
      knowledgeCharBudget: 180,
    },
    'key',
    { id: 'current', text: 'request', openedAt: 1 },
  );
  const text = notes.join('');
  expect(text).toContain('&#91;knowledge&#93;');
  expect(text).toContain('&#91;memory&#93;');
  expect(text).not.toContain('secret');
  expect(
    text.match(/\[planning knowledge\][\s\S]*?\[\/planning knowledge\]/)?.[0]
      .length,
  ).toBeLessThanOrEqual(180);
  expect(
    text.match(/\[session memory\][\s\S]*?\[\/session memory\]/)?.[0].length,
  ).toBeLessThanOrEqual(160);
});

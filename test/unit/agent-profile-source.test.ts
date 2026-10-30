import type { CallOptions } from '@mcp-abap-adt/llm-agent';
import {
  type AgentProfileReader,
  AgentProfileSource,
} from '../../srv/lib/agent-profile-source';
import type { CollectionMeta, RagDocument } from '../../srv/rag-collections';

const profile = (name: string, enabled = true): RagDocument => ({
  id: name,
  text: `body:${name}`,
  createdAt: '',
  metadata: {
    canonicalKey: name,
    kind: 'profile',
    name,
    description: `description:${name}`,
    tools: 'all',
    result: 'report',
    enabled,
  },
});
const prompt = (
  name: string,
  kind: 'planner' | 'worker-base',
): RagDocument => ({
  id: name,
  text: '',
  createdAt: '',
  metadata: { canonicalKey: name, kind, name },
});
function fixture() {
  let selected = 'agents';
  let meta: CollectionMeta = {
    id: 'agents',
    logicalId: 'agents',
    displayName: '',
    description: '',
    scope: 'global',
    collectionKind: 'agents',
    createdAt: '',
    documentCount: 0,
    sourceCount: 0,
  };
  let documents = [
    profile('z'),
    profile('A'),
    profile('hidden', false),
    prompt('_worker-base', 'worker-base'),
    prompt('planner', 'planner'),
  ];
  const read = jest.fn<
    ReturnType<AgentProfileReader['readAgentCollection']>,
    Parameters<AgentProfileReader['readAgentCollection']>
  >(async () => ({ meta, documents }));
  const source = new AgentProfileSource(
    { readAgentCollection: read },
    {
      userId: 'reader',
      globalCollectionId: 'agents',
      selectedCollectionId: () => selected,
      plannerRecord: 'planner',
      timeoutMs: 30,
    },
  );
  return {
    source,
    read,
    select: (id: string) => {
      selected = id;
    },
    metadata: (value: Partial<CollectionMeta>) => {
      meta = { ...meta, ...value };
    },
    records: (value: RagDocument[]) => {
      documents = value;
    },
  };
}
test('fresh exact listing, disabled descriptions omitted, empty prompt text preserved', async () => {
  const f = fixture();
  expect(await f.source.list()).toEqual({
    ok: true,
    value: [
      { name: 'A', description: 'description:A', result: 'report' },
      { name: 'z', description: 'description:z', result: 'report' },
    ],
  });
  expect(await f.source.get('a')).toMatchObject({
    ok: false,
    error: { code: 'missing' },
  });
  expect(await f.source.get('hidden')).toMatchObject({
    ok: false,
    error: { code: 'disabled' },
  });
  expect(await f.source.getPrompts()).toEqual({
    ok: true,
    value: { workerBase: '', planner: '' },
  });
  f.records([profile('new')]);
  expect(await f.source.get('z')).toMatchObject({
    ok: false,
    error: { code: 'missing' },
  });
  expect(await f.source.get('new')).toMatchObject({
    ok: true,
    value: { name: 'new' },
  });
});
test('selection is exact and foreign, missing and wrong-kind selections fail closed', async () => {
  const f = fixture();
  f.select('own');
  expect(await f.source.list()).toMatchObject({ ok: false });
  f.metadata({ id: 'own', scope: 'user', owner: 'reader' });
  expect(await f.source.list()).toMatchObject({ ok: true });
  f.metadata({ owner: 'other' });
  expect(await f.source.list()).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  f.metadata({ owner: 'reader', collectionKind: 'knowledge' });
  expect(await f.source.list()).toMatchObject({ ok: false });
  f.read.mockResolvedValue(null);
  expect(await f.source.list()).toMatchObject({
    ok: false,
    error: { code: 'missing' },
  });
});
test('malformed visible records and duplicate keys are invalid without body leaks', async () => {
  const f = fixture();
  f.records([
    { ...profile('x'), metadata: { ...profile('x').metadata, ceiling: 'all' } },
  ]);
  expect(await f.source.list()).toEqual({
    ok: false,
    error: { code: 'invalid', message: 'Agent configuration invalid' },
  });
  f.records([profile('x'), profile('x')]);
  expect(await f.source.get('x')).toMatchObject({
    ok: false,
    error: { code: 'invalid' },
  });
  f.records([prompt('planner', 'planner')]);
  expect(await f.source.get('planner')).toMatchObject({
    ok: false,
    error: { code: 'invalid' },
  });
});
test('deadline aborts backend signal and ignores late completion', async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  f.read.mockImplementation((_id: string, options?: CallOptions) => {
    signal = options?.signal;
    return new Promise<never>(() => {});
  });
  expect(await f.source.list()).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  expect(signal?.aborted).toBe(true);
});
test('cancellation and backend errors return unavailable', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  expect(await f.source.list({ signal: controller.signal })).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  });
  f.read.mockRejectedValue(new Error('sensitive backend detail'));
  expect(await f.source.get('A')).toEqual({
    ok: false,
    error: { code: 'unavailable', message: 'Agent configuration unavailable' },
  });
});

test.each(['worker', 'planner'] as const)(
  '%s resolution keeps one collection when selection changes between reads',
  async (kind) => {
    const f = fixture();
    const options: CallOptions = { signal: new AbortController().signal };
    const first =
      kind === 'worker'
        ? await f.source.get('A', options)
        : await f.source.list(options);
    expect(first.ok).toBe(true);
    f.select('own');
    f.metadata({ id: 'own', scope: 'user', owner: 'reader' });
    f.records([
      { ...prompt('_worker-base', 'worker-base'), text: 'OTHER_BASE' },
      { ...prompt('planner', 'planner'), text: 'OTHER_PLANNER' },
    ]);
    expect(await f.source.getPrompts(options)).toEqual({
      ok: true,
      value: { workerBase: '', planner: '' },
    });
    expect(await f.source.getPrompts({})).toEqual({
      ok: true,
      value: { workerBase: 'OTHER_BASE', planner: 'OTHER_PLANNER' },
    });
  },
);

test.each(['executor', 'checker'] as const)(
  '%s compatibility resolution snapshots profile and base together',
  async (name) => {
    const f = fixture();
    f.records([
      profile(name),
      prompt('_worker-base', 'worker-base'),
      prompt('planner', 'planner'),
    ]);
    const read = f.read.getMockImplementation();
    if (!read) throw new Error('Missing reader');
    f.read.mockImplementation(async (id, options) => {
      const collection = await read(id, options);
      f.select('missing');
      return collection;
    });
    expect(await f.source.resolveWorker(name)).toMatchObject({
      ok: true,
      value: {
        profile: { name, systemPrompt: `body:${name}` },
        workerBase: '',
      },
    });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(await f.source.resolveWorker(name)).toMatchObject({ ok: false });
  },
);

test('parallel dialogue reads capture selection once before asynchronous selection completes', async () => {
  const f = fixture();
  const selected = jest.fn(async () => {
    const id = 'agents';
    f.select('missing');
    return id;
  });
  const source = new AgentProfileSource(
    { readAgentCollection: f.read },
    {
      userId: 'reader',
      globalCollectionId: 'agents',
      selectedCollectionId: selected,
      plannerRecord: 'planner',
      timeoutMs: 1000,
    },
  );
  const options: CallOptions = {};
  const results = await Promise.all([
    source.list(options),
    source.get('A', options),
    source.getPrompts(options),
  ]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(selected).toHaveBeenCalledTimes(1);
  expect(f.read).toHaveBeenCalledTimes(1);
});

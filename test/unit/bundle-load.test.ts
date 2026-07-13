import { fingerprintMatches, planBundleLoad } from '../../srv/agent-manager';

const FP = {
  provider: 'sap-ai-sdk',
  embeddingModel: 'text-embedding-3-small',
  resourceGroup: 'default',
};

function bundle(entries: { id: string; text: string; vector: number[] }[]) {
  return {
    header: { embedderFingerprint: FP, embeddingDim: 3 },
    entries: entries.map((e) => ({ name: e.id.replace('tool:', ''), ...e })),
  };
}

const doc = (name: string, text: string, exposition?: string) => ({
  id: `tool:${name}`,
  name,
  text,
  exposition,
  cached: true,
});

describe('fingerprintMatches', () => {
  it('matches identical fingerprints', () => {
    expect(fingerprintMatches({ ...FP }, { ...FP })).toBe(true);
  });
  it('rejects same model name on a different provider/endpoint', () => {
    expect(
      fingerprintMatches(
        {
          provider: 'openai',
          embeddingModel: 'text-embedding-3-small',
          baseURL: 'https://a',
        },
        {
          provider: 'openai',
          embeddingModel: 'text-embedding-3-small',
          baseURL: 'https://b',
        },
      ),
    ).toBe(false);
    expect(
      fingerprintMatches(FP, {
        provider: 'openai',
        embeddingModel: 'text-embedding-3-small',
      }),
    ).toBe(false);
  });
});

describe('planBundleLoad', () => {
  const runtimeDocs = [
    doc('ReadTable', 'Tool: ReadTable\ntext'),
    doc('GetX', 'Tool: GetX\ntext'),
  ];

  it('happy path: all texts match → everything loads, NOTHING to supplement (zero embedding)', () => {
    const b = bundle([
      {
        id: 'tool:ReadTable',
        text: 'Tool: ReadTable\ntext',
        vector: [1, 0, 0],
      },
      { id: 'tool:GetX', text: 'Tool: GetX\ntext', vector: [0, 1, 0] },
    ]);
    const plan = planBundleLoad(b, runtimeDocs, FP);
    expect(plan.usable).toBe(true);
    expect(plan.supplementNames).toEqual([]);
    expect(plan.toLoad.map((e) => e.id).sort()).toEqual([
      'tool:GetX',
      'tool:ReadTable',
    ]);
    expect(plan.toLoad.find((e) => e.id === 'tool:ReadTable')?.vector).toEqual([
      1, 0, 0,
    ]);
  });

  it('per-entry supplement — cached tool whose text CHANGED is supplemented, the rest load', () => {
    const b = bundle([
      { id: 'tool:ReadTable', text: 'OLD TEXT', vector: [1, 0, 0] },
      { id: 'tool:GetX', text: 'Tool: GetX\ntext', vector: [0, 1, 0] },
    ]);
    const plan = planBundleLoad(b, runtimeDocs, FP);
    expect(plan.toLoad.map((e) => e.id)).toEqual(['tool:GetX']);
    expect(plan.supplementNames).toEqual(['ReadTable']);
  });

  it('per-entry supplement — a runtime tool ABSENT from the bundle is supplemented', () => {
    const b = bundle([
      {
        id: 'tool:ReadTable',
        text: 'Tool: ReadTable\ntext',
        vector: [1, 0, 0],
      },
    ]);
    const plan = planBundleLoad(b, runtimeDocs, FP);
    expect(plan.toLoad.map((e) => e.id)).toEqual(['tool:ReadTable']);
    expect(plan.supplementNames).toEqual(['GetX']);
  });

  it('fingerprint mismatch → whole bundle unusable, everything supplements', () => {
    const b = bundle([
      {
        id: 'tool:ReadTable',
        text: 'Tool: ReadTable\ntext',
        vector: [1, 0, 0],
      },
    ]);
    const plan = planBundleLoad(b, runtimeDocs, {
      provider: 'openai',
      embeddingModel: 'text-embedding-3-small',
    });
    expect(plan.usable).toBe(false);
    expect(plan.toLoad).toEqual([]);
    expect(plan.supplementNames.sort()).toEqual(['GetX', 'ReadTable']);
  });

  it('no bundle → unusable, everything supplements', () => {
    const plan = planBundleLoad(null, runtimeDocs, FP);
    expect(plan.usable).toBe(false);
    expect(plan.supplementNames.sort()).toEqual(['GetX', 'ReadTable']);
  });

  it('carries exposition through to the loaded entry', () => {
    const docs = [doc('ReadTable', 'T', 'readonly')];
    const b = bundle([{ id: 'tool:ReadTable', text: 'T', vector: [1, 0, 0] }]);
    const plan = planBundleLoad(b, docs, FP);
    expect(plan.toLoad[0].exposition).toBe('readonly');
  });
});

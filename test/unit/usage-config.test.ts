import { MEASURES, readUsageConfig } from '../../srv/lib/usage/config';

describe('usage configuration', () => {
  it('defaults and off', () => {
    expect(readUsageConfig({})).toEqual({
      enabled: false,
      sinks: ['sqlite'],
      measure: [...MEASURES],
      sqlitePath: 'usage.sqlite',
      jsonlPath: undefined,
      jsonlRotateBytes: 104857600,
      memoryLimit: 100000,
      processIntervalMs: 30000,
      storageIntervalMs: 600000,
      retentionDays: 90,
      userId: 'hash',
    });
  });
  it.each(['0', '-1', '1e3', ' 5', '1.5', '9007199254740992'])(
    'rejects strict numeric value %s',
    (value) => {
      expect(() =>
        readUsageConfig({ LLM_AGENT_USAGE_MEMORY_LIMIT: value }),
      ).toThrow('LLM_AGENT_USAGE_MEMORY_LIMIT');
    },
  );
  it.each(['USAGE', 'USAGE_SINKS', 'USAGE_MEASURE', 'USAGE_USER_ID'])(
    'rejects invalid %s',
    (suffix) => {
      expect(() =>
        readUsageConfig({ [`LLM_AGENT_${suffix}`]: 'invalid' }),
      ).toThrow();
    },
  );
  it.each([
    ['hana-vector', 'hana'],
    ['pg-vector', 'pg'],
    ['sqlite', 'sqlite'],
    ['none', 'sqlite'],
  ])('follows %s', (store, sink) => {
    expect(readUsageConfig({ LLM_AGENT_SESSION_STORE: store }).sinks).toEqual([
      sink,
    ]);
  });
  it('override and inherited session backend', () => {
    expect(readUsageConfig({}, 'hana-vector').sinks).toEqual(['hana']);
    expect(
      readUsageConfig({
        LLM_AGENT_SESSION_STORE: 'hana-vector',
        LLM_AGENT_USAGE_SINKS: 'memory,pg',
      }).sinks,
    ).toEqual(['memory', 'pg']);
    expect(() =>
      readUsageConfig({
        LLM_AGENT_USAGE: 'on',
        LLM_AGENT_USAGE_SINKS: 'jsonl',
      }),
    ).toThrow('JSONL_PATH');
  });
});

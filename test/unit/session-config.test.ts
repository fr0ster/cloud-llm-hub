import { loadSessionConfig } from '../../srv/lib/session-config';

describe('loadSessionConfig', () => {
  it('defaults', () => {
    expect(loadSessionConfig({}, 'vector')).toEqual({
      ttlMs: 3600000,
      maxSessions: 50,
      maxPerUser: 5,
      queueLength: 2,
      store: 'none',
      storePath: '.data/sessions.db',
      plainApi: false,
      plainMcp: false,
    });
  });

  it('store follows a persistent session backend', () => {
    expect(loadSessionConfig({}, 'hana-vector').store).toBe('hana-vector');
    expect(loadSessionConfig({}, 'pg-vector').store).toBe('pg-vector');
    expect(loadSessionConfig({}, 'qdrant').store).toBe('none');
  });

  it('explicit store wins', () => {
    expect(
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: 'sqlite' }, 'hana-vector')
        .store,
    ).toBe('sqlite');
  });

  it('an empty store value reads as not set', () => {
    expect(
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: '' }, 'pg-vector').store,
    ).toBe('pg-vector');
  });

  it('malformed numbers throw', () => {
    expect(() =>
      loadSessionConfig({ LLM_AGENT_SESSION_TTL_MS: '10m' }, 'vector'),
    ).toThrow(/LLM_AGENT_SESSION_TTL_MS/);
    expect(() =>
      loadSessionConfig({ LLM_AGENT_MAX_SESSIONS_PER_USER: '0' }, 'vector'),
    ).toThrow(/LLM_AGENT_MAX_SESSIONS_PER_USER/);
    expect(() =>
      loadSessionConfig({ LLM_AGENT_MAX_SESSIONS: '1e3' }, 'vector'),
    ).toThrow(/LLM_AGENT_MAX_SESSIONS/);
  });

  it('reads set numbers', () => {
    const cfg = loadSessionConfig(
      {
        LLM_AGENT_SESSION_TTL_MS: '60000',
        LLM_AGENT_MAX_SESSIONS: '10',
        LLM_AGENT_MAX_SESSIONS_PER_USER: '2',
        LLM_AGENT_SESSION_QUEUE: '7',
        LLM_AGENT_SESSION_STORE_PATH: '/tmp/s.db',
      },
      'vector',
    );
    expect(cfg).toMatchObject({
      ttlMs: 60000,
      maxSessions: 10,
      maxPerUser: 2,
      queueLength: 7,
      storePath: '/tmp/s.db',
    });
  });

  it('per-user cap above total throws', () => {
    expect(() =>
      loadSessionConfig(
        { LLM_AGENT_MAX_SESSIONS: '2', LLM_AGENT_MAX_SESSIONS_PER_USER: '3' },
        'vector',
      ),
    ).toThrow(/LLM_AGENT_MAX_SESSIONS_PER_USER/);
  });

  it('unknown store throws', () => {
    expect(() =>
      loadSessionConfig({ LLM_AGENT_SESSION_STORE: 'qdrant' }, 'vector'),
    ).toThrow(/LLM_AGENT_SESSION_STORE/);
  });

  it('plain switches', () => {
    expect(
      loadSessionConfig(
        { LLM_AGENT_PLAIN_API: 'true', LLM_AGENT_PLAIN_MCP: 'true' },
        'vector',
      ),
    ).toMatchObject({ plainApi: true, plainMcp: true });
    expect(
      loadSessionConfig(
        { LLM_AGENT_PLAIN_API: '1', LLM_AGENT_PLAIN_MCP: 'TRUE' },
        'vector',
      ),
    ).toMatchObject({ plainApi: false, plainMcp: false });
  });
});

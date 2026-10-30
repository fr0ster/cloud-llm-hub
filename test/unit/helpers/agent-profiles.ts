import type {
  IAgentProfileRunner,
  IAgentProfileSource,
  ISmartAgent,
  ISubAgent,
} from '@mcp-abap-adt/llm-agent';

/** Profile-aware adapters for fixtures whose workers/planner are supplied by the test. */
export function fixtureProfileSource(
  workers: () => ReadonlyMap<string, ISubAgent>,
): IAgentProfileSource {
  return {
    list: async () => ({
      ok: true,
      value: [...workers()].map(([name, worker]) => ({
        name,
        description: worker.description ?? '',
        result: name === 'checker' ? 'verdict' : 'report',
      })),
    }),
    get: async (name) =>
      workers().has(name)
        ? {
            ok: true,
            value: {
              name,
              description: workers().get(name)?.description ?? '',
              systemPrompt: '',
              tools: name === 'checker' ? 'read-only' : 'all',
              result: name === 'checker' ? 'verdict' : 'report',
            },
          }
        : {
            ok: false,
            error: { code: 'missing', message: 'Missing fixture profile' },
          },
    getPrompts: async () => ({
      ok: true,
      value: { workerBase: '', planner: '' },
    }),
  };
}

export function fixtureProfileRunner(
  planner: () => ISmartAgent,
  workers: () => ReadonlyMap<string, ISubAgent>,
): IAgentProfileRunner {
  return {
    preparePlanner: async () => ({ ok: true, value: planner() }),
    createWorker: async ({ profile }) => {
      const worker = workers().get(profile.name);
      return worker
        ? { ok: true, value: worker }
        : {
            ok: false,
            error: { code: 'missing', message: 'Missing fixture worker' },
          };
    },
  };
}

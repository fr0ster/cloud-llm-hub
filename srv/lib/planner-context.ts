import type {
  IPlannerKnowledge,
  IRag,
  IRetrievalEmbedder,
} from '@mcp-abap-adt/llm-agent';
import {
  type PlannerRetrievalOptions,
  RagPlannerKnowledge,
} from '@mcp-abap-adt/llm-agent-libs';

export function plannerMemoryStore(options: {
  kind: string;
  create: (scope: 'session', name: string) => IRag;
  persistent: () => IRag;
}): IRag | undefined {
  if (options.kind === 'in-memory') return undefined;
  return options.kind === 'hana-vector' || options.kind === 'pg-vector'
    ? options.persistent()
    : options.create('session', 'planner-memory');
}

export async function plannerContext(options: {
  memory: () => IRag | undefined;
  embedding?: { retrieval: IRetrievalEmbedder; key: string };
  names: string[];
  collection: (name: string) => Promise<IRag | null>;
  warn: (message: string) => void;
  enabled?: (name: string) => Promise<boolean>;
}): Promise<PlannerRetrievalOptions> {
  const result: PlannerRetrievalOptions = {};
  const embedding = options.embedding;
  if (!embedding) return result;
  try {
    const rag = options.memory();
    if (rag)
      result.plannerMemory = {
        rag,
        queryEmbedder: embedding.retrieval,
        documentEmbedder: embedding.retrieval,
        embeddingKey: embedding.key,
      };
  } catch (err) {
    options.warn(
      `Planner memory unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const knowledge: IPlannerKnowledge[] = [];
  for (const name of options.names) {
    try {
      const rag = await options.collection(name);
      if (rag) {
        const source = new RagPlannerKnowledge(
          name,
          rag,
          embedding.retrieval,
          embedding.key,
        );
        knowledge.push({
          name,
          embeddingKey: source.embeddingKey,
          search: async (query, k, callOptions) => {
            if (options.enabled && !(await options.enabled(name))) return [];
            return source.search(query, k, callOptions);
          },
        });
      } else options.warn(`Planner knowledge collection missing: ${name}`);
    } catch (err) {
      options.warn(
        `Planner knowledge collection unavailable: ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  result.plannerKnowledge = knowledge;
  return result;
}

export interface QdrantVectorConfig {
  size: number;
  distance: 'Cosine' | 'Dot';
  multivector_config?: { comparator: 'max_sim' };
}

type QdrantVectors = QdrantVectorConfig | Record<string, QdrantVectorConfig>;

export function qdrantMultivectorConfig(size: number): QdrantVectorConfig {
  return {
    size,
    distance: 'Cosine',
    multivector_config: { comparator: 'max_sim' },
  };
}

export function qdrantCollectionInfo(vectors: QdrantVectors): Response {
  return Response.json({
    result: { status: 'green', config: { params: { vectors } } },
    status: 'ok',
    time: 0,
  });
}

export function qdrantQueryFetch(
  vectors: QdrantVectors,
  queryResponse = () => Response.json({ result: { points: [] } }),
): typeof fetch {
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'GET' && /^\/collections\/[^/]+$/.test(path))
      return qdrantCollectionInfo(vectors);
    if (
      init?.method === 'POST' &&
      /^\/collections\/[^/]+\/points\/query$/.test(path)
    )
      return queryResponse();
    throw new Error(`Unexpected Qdrant request: ${init?.method} ${path}`);
  };
}

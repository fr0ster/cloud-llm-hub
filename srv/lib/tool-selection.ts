import type { RagResult } from '@mcp-abap-adt/llm-agent';
import type { SharedCorpusDoc } from './tool-corpus';
import { collectionFor } from './tool-corpus';
import { toolObjects } from './tool-objects';

export type ToolSelection = 'per-collection' | 'step-kind';

/** Shared by production retrieval and the oracle evaluation harness. */
export function selectStepTools(
  rows: RagResult[],
  docs: SharedCorpusDoc[],
  writes: boolean | undefined,
  grantsWriteLevel: boolean,
  isAllowed: (row: RagResult) => boolean,
  kReader = 2,
  kWriter = 1,
  strategy: ToolSelection = 'per-collection',
): RagResult[] {
  if (strategy === 'per-collection') writes = undefined;
  const byName = new Map(docs.map((doc) => [doc.name, doc]));
  const nameOf = (row: RagResult) =>
    String(row.metadata.id).replace(/^tool:/, '');
  const hintOf = (row: RagResult) => {
    const hint = row.metadata.readOnlyHint;
    return typeof hint === 'boolean'
      ? hint
      : byName.get(nameOf(row))?.readOnlyHint;
  };
  const allowed = rows.filter(isAllowed);
  const readers = allowed
    .filter((row) => collectionFor(hintOf(row)) === 'reader')
    .sort((a, b) => b.score - a.score)
    .slice(0, kReader);
  const writers =
    grantsWriteLevel && writes !== false
      ? allowed
          .filter((row) => collectionFor(hintOf(row)) === 'writer')
          .sort((a, b) => b.score - a.score)
          .slice(0, kWriter)
      : [];
  const found = (!grantsWriteLevel || writes !== true ? readers : []).concat(
    writers,
  );
  const objects = new Set(
    writers.map((row) => toolObjects[nameOf(row)]).filter(Boolean),
  );
  const names = new Set(found.map(nameOf));
  for (const doc of docs) {
    if (
      !toolObjects[doc.name] ||
      !objects.has(toolObjects[doc.name]) ||
      names.has(doc.name)
    )
      continue;
    const row: RagResult = {
      text: doc.text,
      score: 0,
      metadata: {
        id: doc.id,
        name: doc.name,
        exposition: doc.exposition,
        readOnlyHint: doc.readOnlyHint,
      },
    };
    if (isAllowed(row)) {
      found.push(row);
      names.add(doc.name);
    }
  }
  return found.filter(
    (row, index) =>
      found.findIndex((other) => nameOf(other) === nameOf(row)) === index,
  );
}

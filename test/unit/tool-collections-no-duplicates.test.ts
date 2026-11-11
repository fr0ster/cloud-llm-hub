import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BackgroundRunHandlersGroup,
  HighLevelHandlersGroup,
  ReadOnlyHandlersGroup,
  RuntimeRunHandlersGroup,
  SearchHandlersGroup,
  SystemHandlersGroup,
} from '@mcp-abap-adt/lib/handlers';
import {
  getSharedCorpusDocs,
  type ToolEmbeddingBundle,
} from '../../srv/agent-manager';
import { CLOUD_LOCAL_TOOL_EXPOSITIONS } from '../../srv/lib/cloud-local-tools';
import { corpusByRole } from '../../srv/lib/tool-corpus';
import {
  buildToolExpositionMap,
  toolNamesOf,
} from '../../srv/lib/tool-exposition-map';

const docs = getSharedCorpusDocs();
const roles = corpusByRole(docs);
const live = buildToolExpositionMap(CLOUD_LOCAL_TOOL_EXPOSITIONS);

describe('tool collections have no duplicates', () => {
  it('keeps shared corpus ids and names unique', () => {
    expect(docs.length).toBeGreaterThan(0);
    expect(new Set(docs.map((doc) => doc.id)).size).toBe(docs.length);
    expect(new Set(docs.map((doc) => doc.name)).size).toBe(docs.length);
  });

  it('partitions the entire corpus into disjoint reader and writer collections', () => {
    expect(roles.reader.length).toBeGreaterThan(0);
    expect(roles.writer.length).toBeGreaterThan(0);
    const reader = new Set(roles.reader.map((doc) => doc.name));
    expect(roles.writer.filter((doc) => reader.has(doc.name))).toEqual([]);
    expect(
      [...roles.reader, ...roles.writer].map((doc) => doc.id).sort(),
    ).toEqual(docs.map((doc) => doc.id).sort());
  });

  it('tags every tool shared by upstream groups readonly and places it only in reader', () => {
    // Enumeration must never contact SAP.
    const context = {
      connection: {
        connect: async () => {},
        getBaseUrl: async () => '',
        getSessionId: () => null,
        setSessionType: () => {},
        makeAdtRequest: async (): Promise<never> => {
          throw new Error('Unexpected ADT request during enumeration');
        },
      },
    };
    const counts = new Map<string, number>();
    for (const group of [
      new ReadOnlyHandlersGroup(context),
      new HighLevelHandlersGroup(context),
      new SearchHandlersGroup(context),
      new SystemHandlersGroup(context),
      new RuntimeRunHandlersGroup(context),
      new BackgroundRunHandlersGroup(context),
    ]) {
      for (const name of new Set(toolNamesOf(group))) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const duplicates = [...counts].filter(([, count]) => count > 1);
    expect(duplicates.length).toBeGreaterThan(0);
    for (const [name] of duplicates) {
      expect({ name, exposition: live.get(name) }).toEqual({
        name,
        exposition: 'readonly',
      });
      expect(roles.reader.filter((doc) => doc.name === name)).toHaveLength(1);
      expect(roles.writer.filter((doc) => doc.name === name)).toEqual([]);
    }
  });

  it('keeps bundle names unique and every exposition equal to the live map', () => {
    const bundle: ToolEmbeddingBundle = JSON.parse(
      readFileSync(join(__dirname, '../../srv/tool-embeddings.json'), 'utf8'),
    );
    expect(bundle.entries.length).toBeGreaterThan(0);
    expect(new Set(bundle.entries.map((entry) => entry.name)).size).toBe(
      bundle.entries.length,
    );
    for (const entry of bundle.entries) {
      expect(live.has(entry.name)).toBe(true);
      expect({ name: entry.name, exposition: entry.exposition }).toEqual({
        name: entry.name,
        exposition: live.get(entry.name),
      });
    }
  });
});

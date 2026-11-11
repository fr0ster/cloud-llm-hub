import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLOUD_LOCAL_TOOL_EXPOSITIONS } from '../../srv/lib/cloud-local-tools';
import { buildToolExpositionMap } from '../../srv/lib/tool-exposition-map';
import { deriveToolObjects } from '../../tools/generate-tool-objects';

const snapshot: { tools: Record<string, string | null> } = JSON.parse(
  readFileSync(join(__dirname, '../../srv/tool-objects.json'), 'utf8'),
);

it('matches a fresh derivation and covers every served tool', () => {
  expect(deriveToolObjects()).toEqual(snapshot);
  expect(Object.keys(snapshot.tools)).toEqual(
    [...buildToolExpositionMap(CLOUD_LOCAL_TOOL_EXPOSITIONS).keys()].sort(),
  );
});

it.each([
  ['GetDomain', 'domain'],
  ['GetLocalTypes', 'class'],
  ['CreateCdsUnitTest', 'unitTest'],
  ['GetSqlQuery', null],
  ['ActivateProgram', 'program'],
])('%s belongs to %s', (name, object) => {
  expect(snapshot.tools[String(name)]).toBe(object);
});

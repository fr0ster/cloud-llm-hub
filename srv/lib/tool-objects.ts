import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const snapshot: { tools: Record<string, string | null> } = JSON.parse(
  readFileSync(join(__dirname, '..', 'tool-objects.json'), 'utf8'),
);
export const toolObjects = snapshot.tools;
let objectKeywords: Map<string, string[]> | undefined;

function keywordsByObject(): Map<string, string[]> {
  if (objectKeywords) return objectKeywords;
  const search: Record<string, { keywords: string[] }> = JSON.parse(
    readFileSync(
      join(
        dirname(require.resolve('@mcp-abap-adt/lib')),
        '..',
        'tools',
        'tool-search.json',
      ),
      'utf8',
    ),
  );
  objectKeywords = new Map();
  for (const [name, object] of Object.entries(toolObjects)) {
    if (!object || /Local/.test(name) || !search[name]) continue;
    const keywords = search[name].keywords;
    const previous = objectKeywords.get(object);
    objectKeywords.set(
      object,
      previous ? previous.filter((word) => keywords.includes(word)) : keywords,
    );
  }
  return objectKeywords;
}

/** Writer-only text; returning undefined preserves the existing reader/generic text. */
export function objectToolText(
  name: string,
  description: string,
): string | undefined {
  const object = toolObjects[name];
  if (!object) return undefined;
  const verbs: Record<string, string> = {
    Get: 'read',
    Read: 'read',
    List: 'list',
    Create: 'create',
    Update: 'update',
    Delete: 'delete',
    Check: 'syntax check',
    Activate: 'activate',
    Run: 'run',
    Validate: 'validate',
    Search: 'search',
  };
  const verb = name.match(
    /^(Get|Read|List|Create|Update|Delete|Check|Activate|Run|Validate|Search)/,
  )?.[0];
  const operation = verb ? verbs[verb] : name;
  const names =
    object === 'unitTest'
      ? 'ABAP Unit test, unit test, test method'
      : (keywordsByObject().get(object) ?? []).join(', ');
  // Test descriptions may name their subject; the test cluster must not index it.
  const detail =
    object === 'unitTest'
      ? `${operation} the unit test.`
      : description.replace(/\[read-only\]\s*/gi, '').trim();
  return `Tool: ${name}\nObjects: ${names}.\nOperation: ${operation}${object === 'unitTest' ? ' the unit test' : ''}.\nDescription: ${detail}`;
}

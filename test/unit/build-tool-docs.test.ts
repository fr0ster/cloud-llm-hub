import { buildToolDocs } from '../../srv/agent-manager';

// Tool names deliberately not present in tool-intents.json → exercise the
// deterministic uncached base-text + Workflow-hints path without depending on
// the real cache contents.
const CRUD = [
  {
    name: 'CreateZzThing',
    description: 'Create a ZZ thing',
    inputSchema: { type: 'object', properties: { a: {}, b: {} } },
  },
  {
    name: 'UpdateZzThing',
    description: 'Update a ZZ thing',
    inputSchema: { type: 'object', properties: { a: {} } },
  },
  {
    name: 'ReadZzThing',
    description: 'Read a ZZ thing',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ActivateZzThing',
    description: 'Activate a ZZ thing',
    inputSchema: { type: 'object', properties: {} },
  },
];

function byName<T extends { name: string }>(arr: T[], name: string): T {
  const found = arr.find((x) => x.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe('buildToolDocs', () => {
  it('builds base text (Tool/Description/Parameters) and marks unknown tools uncached', () => {
    const { entries, uncached } = buildToolDocs(CRUD);
    const read = byName(entries, 'ReadZzThing');
    // No params → no Parameters line.
    expect(
      read.text.startsWith('Tool: ReadZzThing\nDescription: Read a ZZ thing'),
    ).toBe(true);
    expect(read.text).not.toContain('Parameters:');
    expect(read.cached).toBe(false);
    // Uncached list carries the base entries.
    expect(uncached.map((u) => u.name).sort()).toEqual([
      'ActivateZzThing',
      'CreateZzThing',
      'ReadZzThing',
      'UpdateZzThing',
    ]);
  });

  it('extracts param names from inputSchema.properties', () => {
    const { entries } = buildToolDocs(CRUD);
    expect(byName(entries, 'CreateZzThing').text).toContain('Parameters: a, b');
  });

  it('appends Workflow hints for Create/Update/Read when siblings exist', () => {
    const { entries } = buildToolDocs(CRUD);
    const create = byName(entries, 'CreateZzThing');
    expect(create.text).toContain('\nWorkflow:');
    expect(create.text).toContain('UpdateZzThing (update zz thing)');
    expect(create.text).toContain('ActivateZzThing (activate zz thing)');
    const update = byName(entries, 'UpdateZzThing');
    expect(update.text).toContain('\nWorkflow:');
    expect(update.text).toContain('CreateZzThing');
  });

  it('uncached entries keep BASE text without Workflow hints (preserves the enrich-overwrite quirk)', () => {
    const { uncached } = buildToolDocs(CRUD);
    expect(byName(uncached, 'CreateZzThing').text).not.toContain('\nWorkflow:');
  });

  it('a tool present in tool-intents.json is marked cached with its enriched Intent text', () => {
    // GetTableContents ships enriched in tool-intents.json.
    const { entries } = buildToolDocs([
      {
        name: 'GetTableContents',
        description: 'x',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    const e = byName(entries, 'GetTableContents');
    expect(e.cached).toBe(true);
    expect(e.text).toContain('\nIntent:');
  });

  it('supplement subset keeps FULL-set Workflow hints (regression: sibling in bundle, only Create supplemented)', () => {
    // Mirrors the loader supplement path: docs built from the FULL corpus, then
    // only a subset is upserted. Even when only CreateZzThing is supplemented
    // (Update/Activate siblings live in the bundle, not in the subset), the
    // hints referencing those siblings must survive — because buildToolDocs ran
    // on the full set. Building from the subset alone would drop them.
    const { entries } = buildToolDocs(CRUD);
    const onlyNames = new Set(['CreateZzThing']);
    const toUpsert = entries.filter((e) => onlyNames.has(e.name));
    const create = byName(toUpsert, 'CreateZzThing');
    expect(create.text).toContain('UpdateZzThing (update zz thing)');
    expect(create.text).toContain('ActivateZzThing (activate zz thing)');
  });
});

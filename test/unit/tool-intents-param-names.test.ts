import * as fs from 'node:fs';
import * as path from 'node:path';
import { baseToolText } from '../../srv/agent-manager';

// The generator once read `Object.keys(inputSchema)` — the schema's own keys —
// so 227 of 234 cached intents said "Parameters: type, properties, required"
// instead of the tool's parameters, and retrieval embedded that noise.

describe('baseToolText', () => {
  it('lists the parameter names of a JSON Schema input', () => {
    const text = baseToolText({
      name: 'ReadClass',
      description: 'Read a class.',
      inputSchema: {
        type: 'object',
        properties: { class_name: {}, version: {} },
        required: ['class_name'],
      },
    });
    expect(text).toBe(
      'Tool: ReadClass\nDescription: Read a class.\nParameters: class_name, version',
    );
  });

  it('omits the Parameters line when there are none', () => {
    expect(
      baseToolText({ name: 'Ping', description: 'Ping.', inputSchema: {} }),
    ).toBe('Tool: Ping\nDescription: Ping.');
  });
});

describe('srv/tool-intents.json', () => {
  it('never lists JSON Schema keywords as parameters', () => {
    const intents = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../srv/tool-intents.json'),
        'utf8',
      ),
    ) as Record<string, { text: string; enriched: string }>;
    const bad = Object.entries(intents)
      .filter(([, v]) =>
        /^Parameters: type, properties(, required)?$/m.test(v.text),
      )
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });
});

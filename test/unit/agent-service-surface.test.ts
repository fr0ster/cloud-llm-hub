import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import cds from '@sap/cds';

const read = (f: string) =>
  readFileSync(join(__dirname, '../../srv', f), 'utf8');

describe('AgentService starts no pipeline', () => {
  it('declares no Chat function', () => {
    expect(read('agent-service.cds')).not.toMatch(/function\s+Chat\s*\(/);
  });

  it('registers no Chat handler', () => {
    expect(read('agent-service.ts')).not.toMatch(/on\(\s*'Chat'/);
    expect(read('agent-service.ts')).not.toMatch(/agent\.process\(/);
  });

  it('keeps Health, which probes and starts nothing', () => {
    expect(read('agent-service.cds')).toMatch(/function\s+Health\s*\(/);
    expect(read('agent-service.ts')).toMatch(/on\(\s*'Health'/);
  });

  it('AgentService has Health function and no Chat function in compiled model', async () => {
    const model = await cds.load(
      join(__dirname, '../../srv/agent-service.cds'),
    );

    expect(model.definitions).toBeDefined();
    if (!model.definitions) return;

    expect(model.definitions.AgentService).toBeDefined();
    expect(model.definitions['AgentService.Health']).toBeDefined();
    expect(model.definitions['AgentService.Chat']).toBeUndefined();
  });
});

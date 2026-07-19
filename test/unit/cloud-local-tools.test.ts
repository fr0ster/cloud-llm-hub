import { getSharedCorpusDocs } from '../../srv/agent-manager';
import {
  CLOUD_LOCAL_TOOL_EXPOSITIONS,
  CLOUD_LOCAL_TOOLS,
  mergeCloudLocalTools,
} from '../../srv/lib/cloud-local-tools';

describe('cloud-local-tools', () => {
  it('CLOUD_LOCAL_TOOLS has exactly one entry: GetDumpSection with a dump_id param', () => {
    expect(CLOUD_LOCAL_TOOLS).toHaveLength(1);
    const tool = CLOUD_LOCAL_TOOLS[0];
    expect(tool.name).toBe('GetDumpSection');
    const schema = tool.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.properties?.dump_id).toBeDefined();
    expect(schema.required).toContain('dump_id');
  });

  it('mergeCloudLocalTools appends GetDumpSection when absent', () => {
    const merged = mergeCloudLocalTools([]);
    const matches = merged.filter((t) => t.name === 'GetDumpSection');
    expect(matches).toHaveLength(1);
  });

  it('mergeCloudLocalTools dedupes by name — existing (core) tool wins', () => {
    const existing = [
      { name: 'GetDumpSection', description: 'x', inputSchema: {} },
    ];
    const merged = mergeCloudLocalTools(existing);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('x');
  });

  it('CLOUD_LOCAL_TOOL_EXPOSITIONS tags GetDumpSection as system', () => {
    expect(CLOUD_LOCAL_TOOL_EXPOSITIONS.GetDumpSection).toBe('system');
  });

  it('getSharedCorpusDocs() includes GetDumpSection tagged exposition=system', () => {
    const docs = getSharedCorpusDocs();
    const doc = docs.find((d) => d.name === 'GetDumpSection');
    expect(doc).toBeDefined();
    expect(doc?.exposition).toBe('system');
  });
});

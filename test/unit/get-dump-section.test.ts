import fs from 'node:fs';
import path from 'node:path';
import type {
  DumpBufferKey,
  DumpBufferStore,
  DumpBufferValue,
} from '../../srv/lib/dump-buffer';
import { getDumpSectionResult } from '../../srv/lib/get-dump-section';

const payload = fs.readFileSync(
  path.join(__dirname, 'fixtures/zdemo01-dump.formatted.txt'),
  'utf8',
);

function fakeBuffer(): DumpBufferStore {
  const map = new Map<string, DumpBufferValue>();
  return {
    get(key: DumpBufferKey) {
      return map.get(JSON.stringify(key));
    },
    set(key: DumpBufferKey, value: DumpBufferValue) {
      map.set(JSON.stringify(key), value);
    },
  };
}

const key: DumpBufferKey = {
  principalHash: 'hash1',
  resolvedDestination: 'S4HANA_DEV',
  effectiveClient: '100',
  dumpId: 'DUMP001',
};

describe('getDumpSectionResult (buffer-once)', () => {
  it('fetches once on miss, caches, and does not re-fetch on a second call', async () => {
    const buffer = fakeBuffer();
    const fetchFormatted = jest.fn().mockResolvedValue(payload);

    const first = await getDumpSectionResult(
      { dumpId: 'DUMP001' },
      { key, buffer, fetchFormatted },
    );
    expect(fetchFormatted).toHaveBeenCalledTimes(1);
    expect(first.index).toContain('Error analysis');

    const second = await getDumpSectionResult(
      { dumpId: 'DUMP001' },
      { key, buffer, fetchFormatted },
    );
    expect(fetchFormatted).toHaveBeenCalledTimes(1);
    expect(second.index).toContain('Error analysis');
  });

  it('returns the index when section is omitted', async () => {
    const buffer = fakeBuffer();
    const fetchFormatted = jest.fn().mockResolvedValue(payload);

    const result = await getDumpSectionResult(
      { dumpId: 'DUMP001' },
      { key, buffer, fetchFormatted },
    );

    expect(result.dumpId).toBe('DUMP001');
    expect(result.index).toContain('Error analysis');
    expect(result.section).toBeUndefined();
    expect(result.text).toBeUndefined();
  });

  it('returns the de-padded chapter text for a valid section', async () => {
    const buffer = fakeBuffer();
    const fetchFormatted = jest.fn().mockResolvedValue(payload);

    const result = await getDumpSectionResult(
      { dumpId: 'DUMP001', section: 'Error analysis' },
      { key, buffer, fetchFormatted },
    );

    expect(result.dumpId).toBe('DUMP001');
    expect(result.section).toBe('Error analysis');
    expect(result.text).toContain('CX_RAP_HANDLER_NOT_IMPLEMENTED');
    expect(result.index).toBeUndefined();
  });

  it('throws listing valid chapter titles for an invalid section', async () => {
    const buffer = fakeBuffer();
    const fetchFormatted = jest.fn().mockResolvedValue(payload);

    await expect(
      getDumpSectionResult(
        { dumpId: 'DUMP001', section: 'No Such Chapter' },
        { key, buffer, fetchFormatted },
      ),
    ).rejects.toThrow(/Error analysis/);
  });
});

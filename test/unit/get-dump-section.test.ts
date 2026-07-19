import fs from 'node:fs';
import path from 'node:path';
import type {
  DumpBufferKey,
  DumpBufferStore,
  DumpBufferValue,
} from '../../srv/lib/dump-buffer';
import {
  getDumpSectionResult,
  handleGetDumpSectionCall,
  parseFormattedDumpPayload,
} from '../../srv/lib/get-dump-section';

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

function formattedWrapper(payloadText: string): unknown {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          view: 'formatted',
          payload: payloadText,
        }),
      },
    ],
  };
}

describe('parseFormattedDumpPayload', () => {
  it('returns the payload string from a valid formatted wrapper', () => {
    expect(parseFormattedDumpPayload(formattedWrapper('<pipe text>'))).toBe(
      '<pipe text>',
    );
  });

  it('throws when success is false', () => {
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            view: 'formatted',
            payload: 'x',
          }),
        },
      ],
    };
    expect(() => parseFormattedDumpPayload(result)).toThrow(
      /Unexpected RuntimeGetDumpById result/,
    );
  });

  it('throws when view is not formatted', () => {
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            view: 'summary',
            payload: 'x',
          }),
        },
      ],
    };
    expect(() => parseFormattedDumpPayload(result)).toThrow(
      /Unexpected RuntimeGetDumpById result/,
    );
  });

  it('throws when payload is not a string', () => {
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            view: 'formatted',
            payload: { not: 'a string' },
          }),
        },
      ],
    };
    expect(() => parseFormattedDumpPayload(result)).toThrow(
      /Unexpected RuntimeGetDumpById result/,
    );
  });

  it('throws on malformed JSON', () => {
    const result = { content: [{ type: 'text', text: 'not json {{' }] };
    expect(() => parseFormattedDumpPayload(result)).toThrow();
  });
});

describe('handleGetDumpSectionCall (MCP-shaped, fail-closed)', () => {
  const dumpScope = {
    principalHash: 'hash1',
    resolvedDestination: 'S4HANA_DEV',
    effectiveClient: '100',
  };

  const fetchFormatted = () =>
    Promise.resolve(parseFormattedDumpPayload(formattedWrapper(payload)));

  it('returns the index (isError:false) when section is omitted', async () => {
    const buffer = fakeBuffer();
    const result = await handleGetDumpSectionCall(
      { dumpId: 'DUMP001' },
      { dumpScope, buffer, fetchFormatted },
    );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('Error analysis');
  });

  it('returns the de-padded chapter text for a valid section', async () => {
    const buffer = fakeBuffer();
    const result = await handleGetDumpSectionCall(
      { dumpId: 'DUMP001', section: 'Error analysis' },
      { dumpScope, buffer, fetchFormatted },
    );
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('CX_RAP_HANDLER_NOT_IMPLEMENTED');
  });

  it('fetches once across two calls (buffer hit)', async () => {
    const buffer = fakeBuffer();
    const spy = jest
      .fn()
      .mockResolvedValue(parseFormattedDumpPayload(formattedWrapper(payload)));
    await handleGetDumpSectionCall(
      { dumpId: 'DUMP001' },
      { dumpScope, buffer, fetchFormatted: spy },
    );
    await handleGetDumpSectionCall(
      { dumpId: 'DUMP001', section: 'Error analysis' },
      { dumpScope, buffer, fetchFormatted: spy },
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fails closed with a principal message when dumpScope is absent', async () => {
    const buffer = fakeBuffer();
    const result = await handleGetDumpSectionCall(
      { dumpId: 'DUMP001' },
      { buffer, fetchFormatted },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'SAP identity required to analyse a dump (no stable principal)',
    );
  });

  it('fails with a distinct message when dumpId is absent', async () => {
    const buffer = fakeBuffer();
    const result = await handleGetDumpSectionCall(
      {},
      { dumpScope, buffer, fetchFormatted },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('dump_id is required');
  });

  it('returns isError:true listing valid chapters for an invalid section', async () => {
    const buffer = fakeBuffer();
    const result = await handleGetDumpSectionCall(
      { dumpId: 'DUMP001', section: 'No Such Chapter' },
      { dumpScope, buffer, fetchFormatted },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Error analysis');
  });
});

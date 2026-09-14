import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';

function hangingClient(never: Promise<never>) {
  return {
    callTool: () => never,
    listTools: async () => ({ ok: true as const, value: [] }),
  };
}

describe('an unanswered write', () => {
  it('is visible while it is still in flight', async () => {
    const rec = new RecordingMcpClient(
      hangingClient(new Promise(() => {})) as never,
    );
    void rec.callTool('CreateClass', { name: 'ZCL_X' }, {
      trace: { traceId: 't1' },
    } as never);
    await Promise.resolve();
    // Recorded at dispatch. Written after the await, a throw would leave no
    // trace that the write was ever sent, which is the case we report.
    expect(rec.unanswered('t1').map((r) => r.call.name)).toEqual([
      'CreateClass',
    ]);
  });

  it('stops being unanswered once an answer arrives', async () => {
    const client = {
      callTool: async () => ({ ok: true as const, value: { content: 'done' } }),
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec.callTool('CreateClass', {}, {
      trace: { traceId: 't2' },
    } as never);
    expect(rec.unanswered('t2')).toHaveLength(0);
  });

  it('says nothing about an unanswered read', async () => {
    // A lost answer to a read is a lost answer. Calling it a possibly-applied
    // write would teach a planner to re-check objects nothing touched.
    const client = {
      callTool: async () => {
        throw new Error('socket hang up');
      },
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec
      .callTool('ReadClass', { name: 'ZCL_X' }, {
        trace: { traceId: 't4' },
      } as never)
      .catch(() => undefined);
    expect(rec.unanswered('t4')).toHaveLength(0);
  });

  it('is reported once, naming the write, and never called again', async () => {
    let calls = 0;
    const client = {
      callTool: async () => {
        calls++;
        throw new Error('socket hang up');
      },
      listTools: async () => ({ ok: true as const, value: [] }),
    };
    const rec = new RecordingMcpClient(client as never);
    await rec
      .callTool('CreateClass', { name: 'ZCL_X' }, {
        trace: { traceId: 't3' },
      } as never)
      .catch(() => undefined);
    expect(calls).toBe(1);
    expect(rec.unanswered('t3').map((r) => r.call.name)).toEqual([
      'CreateClass',
    ]);
  });
});

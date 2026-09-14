import { McpClientAdapter } from '@mcp-abap-adt/llm-agent-mcp';
import { RecordingMcpClient } from '../../srv/lib/recording-mcp-client';
import { evaluateDeterministic } from '../../srv/lib/reviewer-core';

function hangingClient(never: Promise<never>) {
  return {
    callTool: () => never,
    listTools: async () => ({ ok: true as const, value: [] }),
  };
}

/** The real adapter agent-manager.ts wraps every inner MCP client in
 *  (`new McpClientAdapter(mcpClient)`, srv/agent-manager.ts ~2258). Its
 *  `callTool` NEVER throws — it catches every exception and RETURNS
 *  `{ ok:false, error }` (node_modules/@mcp-abap-adt/llm-agent-mcp/dist/adapter.js).
 *  A fake inner client whose `callTool` throws is the shape a real transport
 *  failure actually takes once it reaches `RecordingMcpClient`. */
function realAdapterAround(callTool: () => Promise<unknown>): McpClientAdapter {
  return new McpClientAdapter({
    listTools: async () => [],
    ping: async () => {},
    callTool,
  } as never);
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

describe('unanswered() against the real McpClientAdapter', () => {
  // Ground truth (reviewer finding, controller Ruling 30): McpClientAdapter's
  // `callTool` catches the thrown transport error and RETURNS `{ok:false,
  // error}` with a mapped McpError code — it never rejects. A record must be
  // read as unanswered from THAT shape, or it is unanswered nowhere real.
  it('names a write whose transport call threw (socket hang up)', async () => {
    const adapter = realAdapterAround(async () => {
      throw new Error('socket hang up');
    });
    const rec = new RecordingMcpClient(adapter);
    await rec.callTool('CreateClass', { name: 'ZCL_X' }, {
      trace: { traceId: 'ta1' },
    } as never);
    expect(rec.unanswered('ta1').map((r) => r.call.name)).toEqual([
      'CreateClass',
    ]);
  });

  it('does not report a pre-send refusal (tool not found) as unanswered', async () => {
    const adapter = realAdapterAround(async () => {
      throw new Error('Tool not found: Bogus');
    });
    const rec = new RecordingMcpClient(adapter);
    await rec.callTool('CreateClass', {}, {
      trace: { traceId: 'ta2' },
    } as never);
    expect(rec.unanswered('ta2')).toHaveLength(0);
  });

  it('does not report an unanswered read', async () => {
    const adapter = realAdapterAround(async () => {
      throw new Error('socket hang up');
    });
    const rec = new RecordingMcpClient(adapter);
    await rec.callTool('ReadClass', {}, {
      trace: { traceId: 'ta3' },
    } as never);
    expect(rec.unanswered('ta3')).toHaveLength(0);
  });
});

describe('an unanswered write does not satisfy the reviewer', () => {
  // Controller finding: the placeholder opened at dispatch must not parse as
  // a successful write, or the reviewer could count a never-answered
  // CreateClass as created and suppress its own UNVERIFIED_WRITE notice.
  it('is not read as "created" from the placeholder alone', async () => {
    const rec = new RecordingMcpClient(
      hangingClient(new Promise(() => {})) as never,
    );
    void rec.callTool('CreateClass', { name: 'ZCL_X' }, {
      trace: { traceId: 't5' },
    } as never);
    await Promise.resolve();

    const verdict = evaluateDeterministic(
      'The class ZCL_X was created successfully.',
      rec.getToolRecords('t5'),
    );
    expect(verdict.ok).toBe(false);
  });
});

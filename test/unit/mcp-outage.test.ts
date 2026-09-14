import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import {
  asOutage,
  isOutageError,
  isUnavailable,
  McpUnavailableError,
  outageClassifier,
  outageFromToolResult,
} from '../../srv/lib/mcp-outage';

describe('telling an outage from a tool that ran and failed', () => {
  it('recognises our own unavailability marker', () => {
    expect(
      isUnavailable(
        new McpUnavailableError('S4HANA_DEV', 'tunnel down', 'tunnel_timeout'),
      ),
    ).toBe(true);
  });

  it('survives being rewrapped, because every layer rewraps', () => {
    const inner = new McpUnavailableError(
      'S4HANA_DEV',
      'tunnel down',
      'tunnel_timeout',
    );
    const outer = new Error('Tool execution failed');
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(isUnavailable(outer)).toBe(true);
  });

  it('leaves domain feedback alone', () => {
    // A tool's own "forbidden" or "currently editing" is feedback, not an
    // outage, and escalating it would close a destination that is fine.
    expect(
      isUnavailable(new Error('User DEVELOPER is currently editing ZCL_X')),
    ).toBe(false);
    expect(isUnavailable(new Error('403 Forbidden'))).toBe(false);
    expect(isUnavailable(new Error('The operation timed out'))).toBe(false);
  });
});

describe('asOutage — the connector decides, through the classifier we already have', () => {
  it('marks a failure the connector tagged as never having reached SAP', () => {
    // The tag is what the connector wrote; this reads it rather than guessing
    // again from the prose around it.
    const err = new Error(
      'connect ECONNREFUSED 10.0.0.1:44300 [dns_or_network]',
    );
    const outage = asOutage(err, 'S4HANA_DEV');
    expect(outage).toBeDefined();
    expect(outage?.destination).toBe('S4HANA_DEV');
    // The raw signature survives on `reason` and `cause` — NOT in `message`,
    // which must stay a fixed shape so it maps to MCP_NO_RESPONSE (and not an
    // earlier-checked pattern like "etimedout") once it crosses the embedded
    // wrapper's string-only boundary.
    expect(outage?.reason).toContain('ECONNREFUSED');
    expect((outage as McpUnavailableError).cause).toBe(err);
    expect(outage?.message).not.toContain('ECONNREFUSED');
  });

  it('scans past an earlier bracketed token to the real status tag', () => {
    // The connector (or something upstream) may have already put an
    // unrelated `[lowercase_word]`-shaped token into the message — the SAME
    // shape a status tag has, so only checking the FIRST bracket would pick
    // it up by accident. Only a real ProbeStatus name should count as the tag.
    const err = new Error(
      '[trace_abc] connect ECONNREFUSED 10.0.0.1:44300 [dns_or_network]',
    );
    const outage = asOutage(err, 'D');
    expect(outage?.status).toBe('dns_or_network');
  });

  it('leaves an authentication failure alone, because SAP answered', () => {
    // The system is up and said no. Closing it would take a working
    // destination out of service for everyone over one caller's credentials.
    expect(
      asOutage(new Error('401 Unauthorized [backend_auth_failed]'), 'D'),
    ).toBeUndefined();
  });

  it('leaves a backend error alone, because SAP ran something', () => {
    expect(asOutage(new Error('500 [backend_error]'), 'D')).toBeUndefined();
  });

  it('says nothing when the connector tagged nothing', () => {
    // No tag means the connector did not classify this as a connectivity
    // problem at all — a tool-level failure, most often.
    expect(asOutage(new Error('object ZCL_X not found'), 'D')).toBeUndefined();
  });

  it('is not double-wrapped — its own fixed message carries no tag to re-read', () => {
    const outage = new McpUnavailableError(
      'D',
      'connect ECONNREFUSED [dns_or_network]',
      'dns_or_network',
    );
    expect(asOutage(outage, 'D')).toBeUndefined();
  });

  it('closes on transport codes and not on ones the server answered', () => {
    const { McpError } =
      require('@mcp-abap-adt/llm-agent') as typeof import('@mcp-abap-adt/llm-agent');
    const closes = [
      'MCP_NOT_CONNECTED',
      'MCP_NO_RESPONSE',
      'MCP_TIMEOUT',
      'MCP_HTTP_503',
    ];
    for (const code of closes) {
      expect(isOutageError(new McpError('x', code))).toBe(true);
    }
    // In the library's unavailable set, deliberately not in ours: a 403 is an
    // authorisation verdict and a 404 is a path. The server answered.
    for (const code of ['MCP_HTTP_403', 'MCP_HTTP_404']) {
      expect(isOutageError(new McpError('x', code))).toBe(false);
    }
  });

  it('classifies for the library seam, which is async and takes an McpError', async () => {
    const { McpError } =
      require('@mcp-abap-adt/llm-agent') as typeof import('@mcp-abap-adt/llm-agent');
    const down = new McpError('no response from S4HANA_DEV', 'MCP_NO_RESPONSE');
    const feedback = new McpError('object ZCL_X not found', 'MCP_ERROR');
    await expect(outageClassifier.classify(down)).resolves.toBe('unavailable');
    await expect(outageClassifier.classify(feedback)).resolves.toBe(
      'tool-error',
    );
  });
});

describe("surviving the embedded wrapper's string-only crossing (real wrapper + adapter)", () => {
  // Built through the REAL `MCPClientWrapper` (transport: 'embedded') and the
  // REAL `McpClientAdapter`, not a stand-in — this is the exact boundary the
  // brief describes: the wrapper's embedded catch keeps only `error.message`
  // as a string, and the adapter escalates a RETURNED error only when
  // `toMcpError` maps it to MCP_NOT_CONNECTED or MCP_NO_RESPONSE.
  const samples = [
    'connect ETIMEDOUT 10.0.0.1:443 [dns_or_network]',
    'Timed out waiting for tunnel to open [tunnel_timeout]',
    'connect ECONNREFUSED 10.0.0.1:443 [dns_or_network]',
    'no SCC registration [no_scc_registration]',
  ];

  for (const sample of samples) {
    it(`escalates "${sample}" instead of staying tool feedback`, async () => {
      const wrapper = new MCPClientWrapper({
        transport: 'embedded',
        callToolHandler: async () => {
          const outage = asOutage(new Error(sample), 'S4HANA_DEV');
          if (!outage)
            throw new Error(`test setup: expected an outage for "${sample}"`);
          throw outage;
        },
      });
      const adapter = new McpClientAdapter(wrapper);
      const result = await adapter.callTool('AnyTool', {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(isOutageError(result.error)).toBe(true);
      }
    });
  }
});

describe('outageFromToolResult — most ABAP handlers return, they do not throw', () => {
  it('reads the tag out of a returned isError result', () => {
    const result = {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'connect ECONNREFUSED 10.0.0.1:443 [dns_or_network]',
        },
      ],
    };
    const outage = outageFromToolResult(result, 'S4HANA_DEV');
    expect(outage).toBeDefined();
    expect(outage?.destination).toBe('S4HANA_DEV');
    expect(outage?.status).toBe('dns_or_network');
  });

  it('reads a bare-string content the same way', () => {
    const outage = outageFromToolResult(
      { isError: true, content: 'no SCC registration [no_scc_registration]' },
      'D',
    );
    expect(outage?.status).toBe('no_scc_registration');
  });

  it('leaves an untagged isError result alone — a tool that ran and failed', () => {
    expect(
      outageFromToolResult(
        { isError: true, content: [{ type: 'text', text: '403 Forbidden' }] },
        'D',
      ),
    ).toBeUndefined();
    expect(
      outageFromToolResult(
        {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'User DEVELOPER is currently editing ZCL_X',
            },
          ],
        },
        'D',
      ),
    ).toBeUndefined();
  });

  it('leaves a successful result alone', () => {
    expect(
      outageFromToolResult(
        { isError: false, content: [{ type: 'text', text: 'ok' }] },
        'D',
      ),
    ).toBeUndefined();
    expect(outageFromToolResult({ content: 'fine' }, 'D')).toBeUndefined();
  });

  it('leaves a malformed result alone', () => {
    expect(outageFromToolResult(null, 'D')).toBeUndefined();
    expect(outageFromToolResult(undefined, 'D')).toBeUndefined();
    expect(outageFromToolResult('a string', 'D')).toBeUndefined();
    expect(outageFromToolResult(42, 'D')).toBeUndefined();
    expect(outageFromToolResult({ isError: true }, 'D')).toBeUndefined();
    expect(
      outageFromToolResult({ isError: true, content: [{}] }, 'D'),
    ).toBeUndefined();
  });
});

describe('the connector tags the failures it sees', () => {
  it('classifies the connect-phase shapes, not a mid-chain reset', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/connections/CloudSdkAbapConnection.ts'),
      'utf8',
    );
    // Scope to the outage-tagging gate itself (`looksTunnelRelated`), and to
    // its CODE lines only — not the whole file, and not this gate's own
    // explanatory comments, which legitimately name the excluded codes.
    // "socket hang up" also appears elsewhere in the file for an unrelated
    // reason (the ICF logoff / session-release code recognises it as an
    // EXPECTED disconnect), which a whole-file check would trip over.
    const start = source.indexOf('const looksTunnelRelated =');
    expect(start).toBeGreaterThan(-1);
    const lines = source.slice(start).split('\n');
    const end = lines.findIndex((line) => line.trim() === ');');
    expect(end).toBeGreaterThan(-1);
    const gateCode = lines
      .slice(0, end + 1)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // Without these the tag is never written for the commonest outages, and
    // everything downstream reads an absence as "not an outage".
    expect(gateCode).toMatch(/ECONNREFUSED/);
    expect(gateCode).toMatch(/EHOSTUNREACH/);
    // A reset on the one long-lived keep-alive socket (maxSockets:1) can mean
    // SAP ran the write and dropped the connection afterwards — not "nothing
    // reached SAP". The gate's actual pattern must not ask about it.
    expect(gateCode).not.toMatch(/socket hang up/);
  });
});

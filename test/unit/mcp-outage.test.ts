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

  it('decides ONLY from the tag surviving in the message, never from the mapped code alone', () => {
    // `toMcpError` maps a bare mid-exchange reset — "socket hang up",
    // "read ECONNRESET" — to MCP_NOT_CONNECTED, the SAME code a genuine
    // outage produces. Finding 4 deliberately never tags those at the
    // connector (a reset there can mean SAP ran the write), so trusting the
    // code alone here would silently re-introduce that exact false positive
    // through the library's own mapping instead of the connector's.
    const { McpError } =
      require('@mcp-abap-adt/llm-agent') as typeof import('@mcp-abap-adt/llm-agent');

    // Whatever the mapped code — even a wrong/arbitrary one — a message that
    // still carries the fixed `(outage: <status>)` marker decides true.
    const markerMessage = new McpUnavailableError('D', 'x', 'tunnel_timeout')
      .message;
    expect(isOutageError(new McpError(markerMessage, 'MCP_ERROR'))).toBe(true);

    // No marker: false, regardless of a code that LOOKS like an outage code.
    expect(
      isOutageError(new McpError('socket hang up', 'MCP_NOT_CONNECTED')),
    ).toBe(false);
    expect(
      isOutageError(new McpError('read ECONNRESET', 'MCP_NOT_CONNECTED')),
    ).toBe(false);
    expect(
      isOutageError(
        new McpError('Request failed with status code 503', 'MCP_HTTP_503'),
      ),
    ).toBe(false);
    expect(isOutageError(new McpError('x', 'MCP_HTTP_403'))).toBe(false);
  });

  it('classifies for the library seam, which is async and takes an McpError', async () => {
    const { McpError } =
      require('@mcp-abap-adt/llm-agent') as typeof import('@mcp-abap-adt/llm-agent');
    const down = new McpError(
      new McpUnavailableError('D', 'x', 'tunnel_timeout').message,
      'MCP_NO_RESPONSE',
    );
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

  it('does NOT escalate an untagged mid-exchange reset, even though it maps to the same code', async () => {
    // A handler that throws a BARE "socket hang up" — never having gone
    // through the connector's tagging at all — must stay tool feedback. This
    // is the exact library-mapping path Finding 4's follow-up review found
    // defeating the connector's own decision: `toMcpError` maps this to
    // MCP_NOT_CONNECTED, the same code a genuine outage produces, but there
    // is no `(outage: ...)` marker in the message, so it must not count.
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      callToolHandler: async () => {
        throw new Error('socket hang up');
      },
    });
    const adapter = new McpClientAdapter(wrapper);
    const result = await adapter.callTool('AnyTool', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isOutageError(result.error)).toBe(false);
      await expect(outageClassifier.classify(result.error)).resolves.toBe(
        'tool-error',
      );
    }
  });
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

/** Extract the alternation inside a `/A|B|C/i.test(...)` regex LITERAL from
 *  source text, as an order-independent set of signatures — so the "same
 *  set" comparison below does not care which file lists them in which
 *  order, only that neither one asks about (or fails to ask about) a
 *  signature the other does. */
function regexAlternationSignatures(code: string): string[] {
  const match = /\/([A-Za-z_|]+)\/i\.test\(/.exec(code);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[1].split('|').sort();
}

describe('the connector tags the failures it sees', () => {
  it('the connector gate and the classifier regex hold the SAME set of signatures', () => {
    const connectorSource = readFileSync(
      join(__dirname, '../../srv/connections/CloudSdkAbapConnection.ts'),
      'utf8',
    );
    // Scope to the outage-tagging gate itself (`looksTunnelRelated`), and to
    // its CODE lines only — not the whole file, and not this gate's own
    // explanatory comments, which legitimately name the excluded codes.
    // "socket hang up" also appears elsewhere in the file for an unrelated
    // reason (the ICF logoff / session-release code recognises it as an
    // EXPECTED disconnect), which a whole-file check would trip over.
    const start = connectorSource.indexOf('const looksTunnelRelated =');
    expect(start).toBeGreaterThan(-1);
    const lines = connectorSource.slice(start).split('\n');
    const end = lines.findIndex((line) => line.trim() === ');');
    expect(end).toBeGreaterThan(-1);
    const gateCode = lines
      .slice(0, end + 1)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const classifierSource = readFileSync(
      join(__dirname, '../../srv/lib/probe-classifier.ts'),
      'utf8',
    );
    const classifierStart = classifierSource.indexOf(
      "status: 'dns_or_network'",
    );
    expect(classifierStart).toBeGreaterThan(-1);
    // The regex literal is a few lines ABOVE its own status return, so scan
    // backwards from there instead of forwards from an anchor.
    const classifierCode = classifierSource.slice(
      Math.max(0, classifierStart - 400),
      classifierStart,
    );

    const gateSignatures = regexAlternationSignatures(gateCode);
    const classifierSignatures = regexAlternationSignatures(classifierCode);

    // Two lists, held in lockstep on purpose (Finding 4 / gap-A follow-up):
    // a signature the classifier recognises but the connector never asks
    // about closes nothing; one the connector asks about but the classifier
    // doesn't tag as `dns_or_network` writes a tag `asOutage` never reads
    // back as an outage either way.
    expect(gateSignatures).toEqual(classifierSignatures);

    // And the actual expected set — not just "the two files agree with each
    // other" (which they could do by both being wrong the same way).
    expect(gateSignatures).toEqual(
      [
        'ENOTFOUND',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'getaddrinfo',
      ].sort(),
    );
  });
});

describe('invokeEmbeddedTool reads a RETURNED outage, not only a thrown one', () => {
  it('throws outageFromToolResult(...) right after the tracked await', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/agent-manager.ts'),
      'utf8',
    );
    const start = source.indexOf('async function invokeEmbeddedTool');
    expect(start).toBeGreaterThan(-1);
    // Generous window: comfortably covers from the tracked await to well past
    // the outage check, without reaching into an unrelated function.
    const scope = source.slice(start, start + 6000);

    const awaitIdx = scope.indexOf('await trackCall(');
    expect(awaitIdx).toBeGreaterThan(-1);
    const outageIdx = scope.indexOf('outageFromToolResult(');
    expect(outageIdx).toBeGreaterThan(-1);
    // Order matters: the returned-result check only makes sense AFTER the
    // registered call has resolved, not before.
    expect(outageIdx).toBeGreaterThan(awaitIdx);

    expect(scope).toMatch(/if\s*\(outage\)\s*throw outage;/);
  });
});

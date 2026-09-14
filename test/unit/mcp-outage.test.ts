import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asOutage,
  isOutageError,
  isUnavailable,
  McpUnavailableError,
  outageClassifier,
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
    const err = new Error('connect ECONNRESET 10.0.0.1:44300 [tunnel_timeout]');
    const outage = asOutage(err, 'S4HANA_DEV');
    expect(outage).toBeDefined();
    expect(outage?.destination).toBe('S4HANA_DEV');
    // The original survives verbatim, which is what carries the signature
    // across the wrapper's string-only return.
    expect(outage?.message).toContain('ECONNRESET');
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

describe('the connector tags the failures it sees', () => {
  it('classifies a bare network error, not only a tunnel-shaped one', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/connections/CloudSdkAbapConnection.ts'),
      'utf8',
    );
    // Without this the tag is never written for the commonest outage of all,
    // and everything downstream reads an absence as "not an outage".
    expect(source).toMatch(/ECONNREFUSED/);
    expect(source).toMatch(/socket hang up/);
  });
});

describe('the classifier is installed, not merely written', () => {
  it('is handed to the builder', () => {
    const source = readFileSync(
      join(__dirname, '../../srv/agent-manager.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /withMcpFailureClassifier\(\s*outageClassifier\s*\)/,
    );
  });
});

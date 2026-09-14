import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural, deliberately. The unit tests for `closeDestination` call it
 * themselves, so they pass whether or not anything in production ever does —
 * which is the failure this file exists to catch.
 */
const read = (f: string) =>
  readFileSync(join(__dirname, '../../srv', f), 'utf8');

/** The destination variable each channel actually has in scope. */
const DEST_VAR: Record<string, string> = {
  'agent-mcp.ts': 'targetDestination',
  'openai-handler.ts': 'destAfter',
  'anthropic-handler.ts': 'destination',
};

describe("a closed destination is refused in each channel's own shape", () => {
  it('uses the Anthropic envelope in the Anthropic handler', () => {
    // `{ error }` is the OpenAI shape; this dialect wraps it in `type: 'error'`,
    // and a client reading the wrong one sees an unparsable body.
    const src = read('anthropic-handler.ts');
    expect(src).toMatch(/isDestinationClosed\(\s*destination\s*\)/);
    expect(src).toMatch(/type: 'error'[\s\S]{0,200}destinationClosedText/);
  });

  it('uses the OpenAI envelope in the OpenAI handler', () => {
    expect(read('openai-handler.ts')).toMatch(
      /isDestinationClosed\(\s*destAfter\s*\)/,
    );
  });

  it('returns an MCP result from execute_step, which has no response object', () => {
    const src = read('agent-mcp.ts');
    expect(src).toMatch(/isDestinationClosed\(\s*targetDestination\s*\)/);
    expect(src).toMatch(/textResult\([\s\S]{0,160}destinationClosedText/);
    // A writeHead here would not compile: there is no res in scope.
    expect(src).not.toMatch(/res\.writeHead\(503/);
  });
});

describe('every channel closes a destination it finds unreachable', () => {
  for (const [file, dest] of Object.entries(DEST_VAR)) {
    it(`${file} closes on a returned failure`, () => {
      // The common path: the pipeline returns a Result, and ok === false never
      // reaches a catch. Wiring only the catch leaves this open.
      expect(read(file)).toMatch(
        new RegExp(
          `isOutageError\\((?:r|result)\\.error\\)[\\s\\S]{0,160}closeDestination\\(\\s*${dest}`,
        ),
      );
    });

    it(`${file} closes on a thrown failure`, () => {
      expect(read(file)).toMatch(
        new RegExp(
          `isOutageError\\(err\\)[\\s\\S]{0,160}closeDestination\\(\\s*${dest}`,
        ),
      );
    });
  }

  // Only the OpenAI handler reads chunks. The Anthropic stream reaches its
  // handler as adapter events, so a failure there arrives as a throw.
  for (const file of ['openai-handler.ts']) {
    it(`${file} closes on an error chunk too`, () => {
      // Three shapes, three wirings. Covering two of them leaves a whole
      // transport silently open.
      expect(read(file)).toMatch(
        new RegExp(
          `isOutageError\\(chunk\\.error\\)[\\s\\S]{0,160}closeDestination\\(\\s*${DEST_VAR[file]}`,
        ),
      );
    });
  }
});

import {
  MCPClientWrapper,
  McpClientAdapter,
} from '@mcp-abap-adt/llm-agent-mcp';
import { isOutageError, McpUnavailableError } from '../../srv/lib/mcp-outage';

describe('an unreachable system survives the embedded transport', () => {
  it('reaches the adapter as a failure, not as tool feedback', async () => {
    // The whole path: our handler throws, the embedded wrapper catches it and
    // keeps only the message string, and the adapter decides from that string
    // alone whether this was an outage or a tool that ran and failed. A wording
    // the mapper does not recognise ends here as ok:true, and the classifier is
    // never consulted — which no unit test of closeDestination would show.
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      callToolHandler: async () => {
        throw new McpUnavailableError(
          'S4HANA_DEV',
          'connect ECONNRESET [tunnel_timeout]',
          'tunnel_timeout',
        );
      },
    });
    const adapter = new McpClientAdapter(wrapper);
    const result = await adapter.callTool('ReadClass', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The predicate a handler will actually use. `isUnavailable` would be
      // false here — the typed marker did not survive the crossing — which is
      // exactly how this path closed nothing while every other assertion
      // passed.
      expect(isOutageError(result.error)).toBe(true);
      const manager =
        require('../../srv/agent-manager') as typeof import('../../srv/agent-manager');
      manager.closeDestination('S4HANA_DEV', result.error.message);
      expect(manager.isDestinationClosed('S4HANA_DEV')).toBe(true);
      manager.clearDestinationStatesForTest();
    }
    if (!result.ok) {
      // MCP_NO_RESPONSE, not MCP_NOT_CONNECTED: `toMcpError` tests "no
      // response" before the ECONNRESET family, and our marker opens with it.
      // Both are in the library's unavailable set, which is why the classifier
      // asks that set rather than naming a code.
      expect(result.error.code).toBe('MCP_NO_RESPONSE');
    }
  });

  it('leaves a tool that ran and failed as feedback', async () => {
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      callToolHandler: async () => {
        throw new Error('User DEVELOPER is currently editing ZCL_X');
      },
    });
    const adapter = new McpClientAdapter(wrapper);
    const result = await adapter.callTool('CreateClass', {});
    // Escalating this would close a destination that is working perfectly.
    expect(result.ok).toBe(true);
  });
});

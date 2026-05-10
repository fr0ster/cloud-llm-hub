import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getDestination } from '@sap-cloud-sdk/connectivity';

export interface FrameLike {
  eventType?: string;
  program?: string;
  include?: string;
}

export interface ToolCall {
  tool: 'GetInclude' | 'GetProgFullCode' | 'GetClass';
  args: Record<string, unknown>;
}

// All ABAP class-pool include names take the form `<CLASS>=*<SUFFIX>` —
// the class name is padded with '=' to width 30 and ends with one of:
//   CP    — public class pool (the class itself)
//   CMxxx — single method body
//   CCIMP — local-class definitions
//   CCAU  — unit-test class
//   CCMAC — macros
//   CCDEF — local type/data definitions
//   CO/CI/CT — protected/interface/types sections
// '=' is not a valid char in regular ABAP object names, so its presence is
// itself the marker that the program field comes from a class. We strip
// everything from the first '=' to recover the canonical class name and
// always route METHOD frames to GetClass — ADT only serves class source
// through /oo/classes/<canonical>/source/main, which GetClass wraps.

// '=' padding is OPTIONAL — only present when the class name is shorter
// than 30 chars. For exactly-30-char class names (e.g. CL_GRAC_SOD_ACCESS_RULE_ASSIST)
// the suffix is appended directly: `CL_GRAC_SOD_ACCESS_RULE_ASSISTCP`.
// Match the well-known suffix set explicitly so we don't over-strip
// regular class names that happen to end in CP/CL/CT/etc.
const CLASS_INCLUDE_RE =
  /=*(?:CP|CCIMP|CCAU|CCMAC|CCDEF|CO|CI|CL|CT|CU|CV|CM\w{3,4})$/;

export function extractClassName(program: string): string {
  return program.replace(CLASS_INCLUDE_RE, '');
}

export function isClassInclude(program: string): boolean {
  return CLASS_INCLUDE_RE.test(program);
}

// Function-group main programs follow the pattern `SAPL<group>` or
// `/<ns>/SAPL<group>`. Strip the `SAPL` to recover the canonical function
// group name (`<group>` / `/<ns>/<group>`) which is what GetFunctionGroup
// expects. Returns undefined for non-SAPL programs.
const SAPL_RE = /^(\/[A-Z0-9_]+\/)?SAPL([A-Z0-9_/]+)$/;
export function extractFunctionGroup(program: string): string | undefined {
  const m = SAPL_RE.exec(program);
  if (!m) return undefined;
  return (m[1] ?? '') + m[2];
}

export function pickToolCall(frame: FrameLike): ToolCall {
  const program = frame.program ?? '';
  const include = frame.include ?? '';
  const eventType = (frame.eventType ?? '').trim();

  // METHOD frames live inside an ABAP class. ADT only serves class source
  // through the /oo/classes/<canonical>/source/main endpoint, which the MCP
  // GetClass tool wraps. Dumps record the *internal* program name (padded
  // class-pool include `CL_X==========CP` or direct-suffix `CL_FOOCP` when
  // the class name fills the 30-char width). extractClassName strips both.
  if (eventType === 'METHOD' && program) {
    return {
      tool: 'GetClass',
      args: { class_name: extractClassName(program) },
    };
  }

  // FORMs (subroutines) live in includes — the dump records the actual
  // F-include in `frame.include` (e.g. /IWBEP/LFGR_MGW_CLIENT_IFF01),
  // GetInclude on that returns the body containing the FORM. Same for any
  // other event type with an include populated.
  if (include) return { tool: 'GetInclude', args: { include_name: include } };

  // No include — fall back to whole-program reads. PBO/PAI MODULEs, EVENT
  // blocks, and FORMs in main-program scope live in the program itself; FG
  // main programs are SAPL-prefixed and need GetProgFullCode with type='FUGR'
  // and the canonical (un-SAPL) name.
  if (program) {
    const fg = extractFunctionGroup(program);
    if (fg)
      return { tool: 'GetProgFullCode', args: { name: fg, type: 'FUGR' } };
    return { tool: 'GetProgFullCode', args: { name: program, type: 'PROG/P' } };
  }
  throw new Error(
    `Cannot resolve source for frame: eventType=${eventType} program=${program} include=${include}`,
  );
}

// SDK transport types are imported lazily so the unit tests above (which inject
// a fake client factory) don't require the real SDK or a destination at all.
type ClientLike = {
  connect: (transport: unknown) => Promise<void>;
  callTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  close: () => Promise<void>;
};

export type ClientFactory = () => Promise<ClientLike> | ClientLike;

// GetProgFullCode / GetFunctionGroup return JSON-stringified
// `{ code_objects: [{ OBJECT_NAME, OBJECT_TYPE, code }, ...] }`. GetInclude /
// GetClass return raw ABAP source. Detect the JSON envelope and concatenate
// includes with a header line; otherwise pass through unchanged.
export function unwrapToolText(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return text;
  try {
    const obj = JSON.parse(trimmed);
    const arr = obj?.code_objects;
    if (Array.isArray(arr) && arr.length > 0) {
      return arr
        .map(
          (o: {
            OBJECT_NAME?: string;
            OBJECT_TYPE?: string;
            code?: string;
          }) => {
            const header = `* ===== ${o.OBJECT_TYPE ?? ''} ${o.OBJECT_NAME ?? ''} =====`;
            return `${header}\n${o.code ?? ''}`;
          },
        )
        .join('\n\n');
    }
    if (typeof obj?.code === 'string') return obj.code;
    if (typeof obj?.source_code === 'string') return obj.source_code;
    if (typeof obj?.source === 'string') return obj.source;
    return text;
  } catch {
    return text;
  }
}

export class McpSourceClient {
  constructor(
    // CLOUD_LLM_HUB destination — provides the JWT for the proxy
    private readonly destinationName: string,
    // SAP system destination, e.g. S4HANA_E19 — selects which ABAP system
    // the proxy reads from via the X-SAP-Destination header
    private readonly sapDestinationName: string,
    private readonly factory?: ClientFactory,
  ) {}

  async fetchFrameSource(frame: FrameLike): Promise<string> {
    const call = pickToolCall(frame);
    const client = await (this.factory
      ? this.factory()
      : this.defaultFactory());
    try {
      let resp = await client.callTool({
        name: call.tool,
        arguments: call.args,
      });
      // For REPORT-style executable programs the dump stores include===program;
      // GetInclude on that name returns 404 because ADT only serves it via
      // the /programs/programs path. Retry as GetProgFullCode on the same
      // name before giving up.
      if (resp.isError && call.tool === 'GetInclude') {
        const includeName = call.args.include_name as string | undefined;
        const text404 = (resp.content?.[0]?.text ?? '').includes('404');
        if (text404 && includeName) {
          resp = await client.callTool({
            name: 'GetProgFullCode',
            arguments: { name: includeName, type: 'PROG/P' },
          });
        }
      }
      if (resp.isError) {
        const msg = resp.content?.[0]?.text ?? 'unknown error';
        throw new Error(`MCP ${call.tool} failed: ${msg}`);
      }
      const text = resp.content?.[0]?.text;
      if (!text) throw new Error(`MCP ${call.tool} returned no content`);
      return unwrapToolText(text);
    } finally {
      await client.close().catch(() => {});
    }
  }

  // Default factory mirrors srv/dump-source.ts: SDK Client + StreamableHTTPClientTransport
  // pointed at the CAP destination's resolved URL with the destination's auth token
  // and the SAP system selector header that cloud-llm-hub uses to route ADT calls.
  // Static imports (the previous dynamic import + Promise.all variant broke under
  // ts-jest 29 + jest 30 + TS6 isolatedModules with "dynamic import callback was
  // invoked without --experimental-vm-modules"). The lazy-load benefit is
  // negligible — defaultFactory is invoked only when no test factory is injected.
  private async defaultFactory(): Promise<ClientLike> {
    const dest = await getDestination({
      destinationName: this.destinationName,
    });
    if (!dest) throw new Error(`Destination ${this.destinationName} not found`);
    if (!dest.url)
      throw new Error(`Destination ${this.destinationName} has no URL`);
    const token = dest.authTokens?.[0]?.value;
    if (!token)
      throw new Error(`Destination ${this.destinationName} has no auth token`);
    const tokenType = dest.authTokens?.[0]?.type ?? 'Bearer';
    const url = new URL('/mcp/stream/http', dest.url);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          Authorization: `${tokenType} ${token}`,
          // cloud-llm-hub picks the SAP system from this header — see how
          // srv/dump-source.ts sends it. Without it the MCP server can't
          // know which on-prem system to route ADT reads to and falls back
          // to the server's default destination, which is not what we want.
          'X-SAP-Destination': this.sapDestinationName,
        },
      },
    });
    const client = new Client(
      { name: 'abap-dump-monitor-source', version: '1.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client as unknown as ClientLike;
  }
}

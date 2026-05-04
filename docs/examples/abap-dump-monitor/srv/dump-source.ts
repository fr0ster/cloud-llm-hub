import { getDestination } from '@sap-cloud-sdk/connectivity';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IDumpSource, DumpListItem } from './interfaces';

const ADT_TS = (iso: string): string =>
  iso.replace(/[-:T]/g, '').replace(/\..*$/, '').replace('Z', '').slice(0, 14);

export class DumpSource implements IDumpSource {
  private client?: Client;

  constructor(private destinationName: string, private sapDestination: string) {}

  async listSince(system: string, fromIso: string): Promise<DumpListItem[]> {
    const result = await this.callTool('RuntimeListFeeds', {
      feed_type: 'dumps',
      from: ADT_TS(fromIso),
      to: ADT_TS(new Date().toISOString())
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      ?.find(c => c.type === 'text')?.text ?? '[]';
    const entries = normalizeDumpList(JSON.parse(text));
    return entries.map(d => {
      // RuntimeListFeeds returns d.id as ADT URL (e.g. /sap/bc/adt/vit/runtime/dumps/<runtime_error_id>).
      // RuntimeGetDumpById expects the bare runtime_error_id, so strip the URL prefix.
      const rawId = String(d.runtime_error_id ?? d.dumpId ?? d.id ?? '');
      const dumpId = rawId.includes('/') ? rawId.split('/').pop() ?? rawId : rawId;
      return {
        system,
        dumpId: decodeURIComponent(dumpId).trim(),
        occurredAt: String(d.timestamp ?? d.occurredAt ?? d.time),
        abapUser: d.user,
        runtimeError: d.runtime_error,
        category: d.category,
        program: d.program
      };
    }).filter(d => d.dumpId && d.dumpId !== 'undefined');
  }

  async fetch(_system: string, dumpId: string): Promise<string> {
    // view=formatted returns the long-form ST22 dump text (pipe-delimited),
    // which contains call stack, variables and source extract — required to
    // populate compositions on MonitoredDump. Default view returns metadata only.
    const result = await this.callTool('RuntimeGetDumpById', {
      dump_id: dumpId,
      view: 'formatted',
      response_mode: 'payload'
    });
    const text = (result.content as Array<{ type: string; text?: string }>)
      ?.find(c => c.type === 'text')?.text ?? '';
    // Envelope: { success, dump_id, view, status, payload: '<raw text>' }
    try {
      const env = JSON.parse(text);
      return typeof env?.payload === 'string' ? env.payload : text;
    } catch {
      return text;
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const client = await this.ensureClient();
    const result = await client.callTool({ name, arguments: args });
    if ((result as any).isError) throw new Error(`MCP ${name} returned error: ${JSON.stringify((result as any).content)}`);
    return result;
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;

    const destination = await getDestination({ destinationName: this.destinationName });
    if (!destination) throw new Error(`Destination ${this.destinationName} not found`);

    const baseUrl = destination.url;
    if (!baseUrl) throw new Error(`Destination ${this.destinationName} has no URL`);

    const authToken = destination.authTokens?.[0]?.value;
    if (!authToken) throw new Error(`Destination ${this.destinationName} has no auth token`);

    const tokenType = destination.authTokens?.[0]?.type ?? 'Bearer';
    const transport = new StreamableHTTPClientTransport(
      new URL('/mcp/stream/http', baseUrl),
      {
        requestInit: {
          headers: {
            Authorization: `${tokenType} ${authToken}`,
            'X-SAP-Destination': this.sapDestination
          }
        }
      }
    );

    const client = new Client(
      { name: 'abap-dump-monitor', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    this.client = client;
    return client;
  }
}

function normalizeDumpList(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['dumps', 'entries', 'items', 'value']) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
    }
  }
  throw new Error(`Unexpected RuntimeListFeeds response shape: ${JSON.stringify(payload).slice(0, 500)}`);
}

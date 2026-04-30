import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { randomUUID } from 'node:crypto';
import type { IDumpSource, DumpListItem } from './interfaces';

interface McpResult { content?: Array<{ type: string; text?: string }>; isError?: boolean; }
interface McpPayload { result?: McpResult; error?: unknown; }

const ADT_TS = (iso: string): string =>
  iso.replace(/[-:T]/g, '').replace(/\..*$/, '').replace('Z', '').slice(0, 14);

export class DumpSource implements IDumpSource {
  private initialized = false;

  constructor(
    private destinationName: string,
    private sapDestination: string,
    private sessionIdRef: { id?: string } = {}
  ) {}

  async listSince(system: string, fromIso: string): Promise<DumpListItem[]> {
    const result = await this.callTool('RuntimeListFeeds', {
      feed_type: 'dumps',
      from: ADT_TS(fromIso),
      to: ADT_TS(new Date().toISOString())
    });
    const text = result.content?.find(c => c.type === 'text')?.text ?? '[]';
    const entries = normalizeDumpList(JSON.parse(text));
    return entries.map(d => ({
      system,
      dumpId: String(d.id ?? d.dumpId ?? d.runtime_error_id),
      occurredAt: String(d.timestamp ?? d.occurredAt ?? d.time),
      abapUser: d.user,
      runtimeError: d.runtime_error,
      category: d.category,
      program: d.program
    })).filter(d => d.dumpId && d.dumpId !== 'undefined');
  }

  async fetch(_system: string, dumpId: string): Promise<string> {
    const result = await this.callTool('RuntimeGetDumpById', {
      dump_id: dumpId,
      response_mode: 'both'
    });
    return result.content?.find(c => c.type === 'text')?.text ?? '';
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
    await this.ensureInitialized();
    const payload = await this.postJsonRpc('tools/call', { name, arguments: args });
    if (payload.error) throw new Error(`MCP ${name} failed: ${JSON.stringify(payload.error)}`);
    return payload.result as McpResult;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const init = await this.postJsonRpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'abap-dump-monitor', version: '1.0.0' }
    });
    if (init.error) throw new Error(`MCP initialize failed: ${JSON.stringify(init.error)}`);
    await this.postJsonRpc('notifications/initialized', undefined, false);
    this.initialized = true;
  }

  private async postJsonRpc(method: string, params?: unknown, withId = true): Promise<McpPayload> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'X-SAP-Destination': this.sapDestination
    };
    if (this.sessionIdRef.id) headers['Mcp-Session-Id'] = this.sessionIdRef.id;

    const body = {
      jsonrpc: '2.0',
      ...(withId ? { id: randomUUID() } : {}),
      method,
      ...(params === undefined ? {} : { params })
    };

    const resp = await executeHttpRequest(
      { destinationName: this.destinationName },
      { method: 'POST', url: '/mcp/stream/http', headers, data: body, responseType: 'text' }
    );

    if (!this.sessionIdRef.id) {
      const sid = resp.headers?.['mcp-session-id'] ?? resp.headers?.['Mcp-Session-Id'];
      if (sid) this.sessionIdRef.id = String(sid);
    }

    const payload = typeof resp.data === 'string' ? this.parseSseOrJson(resp.data) : resp.data;
    return payload ?? {};
  }

  private parseSseOrJson(text: string): any {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const dataLines = trimmed.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
    const last = dataLines[dataLines.length - 1] ?? '{}';
    return JSON.parse(last);
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

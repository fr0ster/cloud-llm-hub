import { getDestination } from '@sap-cloud-sdk/connectivity';
import type { IJiraClient, JiraCreateInput, JiraIssueRef } from './interfaces';

export type JiraHttpFn = (
  destination: { destinationName: string },
  request: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    data?: unknown;
    responseType?: 'json';
  },
) => Promise<{ status: number; data: any }>;

export class JiraClient implements IJiraClient {
  constructor(
    private destinationName: string,
    private http: JiraHttpFn,
  ) {}

  async searchByLabel(label: string): Promise<JiraIssueRef | undefined> {
    // Two Atlassian endpoints in the wild:
    //   • /rest/api/2/search       — legacy; on-prem Jira always has it,
    //                                but a corporate Squid proxy in front
    //                                of EPAM's Jira intermittently returns
    //                                '500 HTTP 406 Not Acceptable' as text/html.
    //   • /rest/api/2/search/jql   — newer Atlassian path; some on-prem
    //                                instances 404 because they predate it.
    // Try both in order and return the first success — any HTTP error from
    // the first endpoint is a reason to fall back, no error-pattern matching.
    const ENDPOINTS = ['/rest/api/2/search', '/rest/api/2/search/jql'];
    let lastErr: Error | undefined;
    for (const endpoint of ENDPOINTS) {
      try {
        const resp = await this.http(
          { destinationName: this.destinationName },
          {
            method: 'POST',
            url: endpoint,
            headers: { 'Content-Type': 'application/json' },
            data: {
              jql: `labels = "${label}"`,
              fields: ['status'],
              maxResults: 1,
            },
            responseType: 'json',
          },
        );
        this.assertOk(resp, `search (${endpoint})`);
        const issue = resp.data?.issues?.[0];
        if (!issue) return undefined;
        return {
          key: issue.key,
          statusCategoryKey:
            issue.fields?.status?.statusCategory?.key ?? 'undefined',
        };
      } catch (e: any) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('Jira search failed: no endpoint reachable');
  }

  async getIssue(key: string): Promise<JiraIssueRef> {
    const resp = await this.http(
      { destinationName: this.destinationName },
      {
        method: 'GET',
        url: `/rest/api/2/issue/${encodeURIComponent(key)}`,
        params: { fields: 'status' },
        responseType: 'json',
      },
    );
    this.assertOk(resp, `get ${key}`);
    return {
      key: resp.data.key,
      statusCategoryKey:
        resp.data.fields?.status?.statusCategory?.key ?? 'undefined',
    };
  }

  async create(input: JiraCreateInput): Promise<string> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      summary: input.summary,
      description: input.description,
      issuetype: { name: input.issueType },
      duedate: input.duedate,
      labels: input.labels,
    };
    if (input.assignee) fields.assignee = { name: input.assignee };
    const resp = await this.http(
      { destinationName: this.destinationName },
      {
        method: 'POST',
        url: '/rest/api/2/issue',
        headers: { 'Content-Type': 'application/json' },
        data: { fields },
        responseType: 'json',
      },
    );
    this.assertOk(resp, 'create');
    return resp.data.key;
  }

  async comment(key: string, body: string): Promise<void> {
    const resp = await this.http(
      { destinationName: this.destinationName },
      {
        method: 'POST',
        url: `/rest/api/2/issue/${encodeURIComponent(key)}/comment`,
        headers: { 'Content-Type': 'application/json' },
        data: { body },
        responseType: 'json',
      },
    );
    this.assertOk(resp, `comment ${key}`);
  }

  private assertOk(resp: { status: number; data: any }, op: string): void {
    if (resp.status >= 200 && resp.status < 300) return;
    const detail =
      resp.data?.errorMessages?.join('; ') ?? JSON.stringify(resp.data);
    throw new Error(`Jira ${op} failed: ${resp.status} ${detail}`);
  }
}

// Native fetch via destination URL/auth — avoids @sap-cloud-sdk/http-client v4
// "Request path contains unescaped characters" errors that surface when JQL
// params with spaces aren't auto-encoded.
export const defaultJiraHttpFn: JiraHttpFn = async (dest, req) => {
  const d = await getDestination({ destinationName: dest.destinationName });
  if (!d?.url) throw new Error(`Destination ${dest.destinationName} not found`);
  const baseUrl = d.url.replace(/\/+$/, '');
  // Use percent-encoding (%20 for space) instead of URLSearchParams' '+'
  // form: some on-prem Jira deployments behind Apache reverse proxies
  // refuse '+' in JQL with HTTP 406 / wrapped 500. encodeURIComponent
  // emits '%20', which both Jira and Apache always accept.
  const search = req.params
    ? '?' +
      Object.entries(req.params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  const url = baseUrl + req.url + search;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Some Jira on-prem deployments reject requests without a Content-Type
    // even on GET (returning 406 / 500). Send it unconditionally.
    'Content-Type': 'application/json',
    // Disable Atlassian XSRF check for REST calls.
    'X-Atlassian-Token': 'no-check',
    ...(req.headers ?? {}),
  };
  // Authentication: prefer destination authTokens, fall back to BasicAuthentication
  // user/password (most likely for Jira destinations created with type Basic).
  const tok = (d as any).authTokens?.[0];
  if (tok?.value)
    headers.Authorization = `${tok.type ?? 'Bearer'} ${tok.value}`;
  else if ((d as any).username && (d as any).password) {
    const cred = Buffer.from(
      `${(d as any).username}:${(d as any).password}`,
    ).toString('base64');
    headers.Authorization = `Basic ${cred}`;
  }
  const resp = await fetch(url, {
    method: req.method,
    headers,
    body: req.data === undefined ? undefined : JSON.stringify(req.data),
  });
  const text = await resp.text();
  let data: any;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (resp.status >= 400) {
    // Diagnose Jira-side rejections: dump the request shape (URL +
    // header keys, NEVER values) and the response body so an operator
    // can tell apart auth failure (401/403), wrong endpoint (404 / 406
    // with HTML body), and content-negotiation issues. Body capped to
    // 500 chars to keep the log readable.
    const safeHeaders = Object.fromEntries(
      Object.entries(headers).map(([k]) => [
        k,
        k.toLowerCase() === 'authorization' ? '<redacted>' : 'set',
      ]),
    );
    const bodyPreview = String(text ?? '').slice(0, 500);
    console.error(
      `[jira-http] ${req.method} ${url} → ${resp.status} ` +
        `content-type=${resp.headers.get('content-type')} ` +
        `headers=${JSON.stringify(safeHeaders)} body=${JSON.stringify(bodyPreview)}`,
    );
  }
  return { status: resp.status, data };
};

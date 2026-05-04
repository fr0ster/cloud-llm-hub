import type { IJiraClient, JiraIssueRef, JiraCreateInput } from './interfaces';

export type JiraHttpFn = (
  destination: { destinationName: string },
  request: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    data?: unknown;
    responseType?: 'json';
  }
) => Promise<{ status: number; data: any }>;

export class JiraClient implements IJiraClient {
  constructor(private destinationName: string, private http: JiraHttpFn) {}

  async searchByLabel(label: string): Promise<JiraIssueRef | undefined> {
    const resp = await this.http(
      { destinationName: this.destinationName },
      {
        method: 'GET',
        url: '/rest/api/2/search',
        params: { jql: `labels = "${label}"`, fields: 'status', maxResults: '1' },
        responseType: 'json'
      }
    );
    this.assertOk(resp, 'search');
    const issue = resp.data?.issues?.[0];
    if (!issue) return undefined;
    return { key: issue.key, statusCategoryKey: issue.fields?.status?.statusCategory?.key ?? 'undefined' };
  }

  async getIssue(key: string): Promise<JiraIssueRef> {
    const resp = await this.http(
      { destinationName: this.destinationName },
      { method: 'GET', url: `/rest/api/2/issue/${encodeURIComponent(key)}`, params: { fields: 'status' }, responseType: 'json' }
    );
    this.assertOk(resp, `get ${key}`);
    return { key: resp.data.key, statusCategoryKey: resp.data.fields?.status?.statusCategory?.key ?? 'undefined' };
  }

  async create(input: JiraCreateInput): Promise<string> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      summary: input.summary,
      description: input.description,
      issuetype: { name: input.issueType },
      duedate: input.duedate,
      labels: input.labels
    };
    if (input.assignee) fields.assignee = { name: input.assignee };
    const resp = await this.http(
      { destinationName: this.destinationName },
      {
        method: 'POST',
        url: '/rest/api/2/issue',
        headers: { 'Content-Type': 'application/json' },
        data: { fields },
        responseType: 'json'
      }
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
        responseType: 'json'
      }
    );
    this.assertOk(resp, `comment ${key}`);
  }

  private assertOk(resp: { status: number; data: any }, op: string): void {
    if (resp.status >= 200 && resp.status < 300) return;
    const detail = resp.data?.errorMessages?.join('; ') ?? JSON.stringify(resp.data);
    throw new Error(`Jira ${op} failed: ${resp.status} ${detail}`);
  }
}

// Native fetch via destination URL/auth — avoids @sap-cloud-sdk/http-client v4
// "Request path contains unescaped characters" errors that surface when JQL
// params with spaces aren't auto-encoded.
export const defaultJiraHttpFn: JiraHttpFn = async (dest, req) => {
  const { getDestination } = await import('@sap-cloud-sdk/connectivity');
  const d = await getDestination({ destinationName: dest.destinationName });
  if (!d?.url) throw new Error(`Destination ${dest.destinationName} not found`);
  const baseUrl = d.url.replace(/\/+$/, '');
  const search = req.params
    ? '?' + new URLSearchParams(req.params).toString()
    : '';
  const url = baseUrl + req.url + search;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Some Jira on-prem deployments reject requests without a Content-Type
    // even on GET (returning 406 / 500). Send it unconditionally.
    'Content-Type': 'application/json',
    // Disable Atlassian XSRF check for REST calls.
    'X-Atlassian-Token': 'no-check',
    ...(req.headers ?? {})
  };
  // Authentication: prefer destination authTokens, fall back to BasicAuthentication
  // user/password (most likely for Jira destinations created with type Basic).
  const tok = (d as any).authTokens?.[0];
  if (tok?.value) headers.Authorization = `${tok.type ?? 'Bearer'} ${tok.value}`;
  else if ((d as any).username && (d as any).password) {
    const cred = Buffer.from(`${(d as any).username}:${(d as any).password}`).toString('base64');
    headers.Authorization = `Basic ${cred}`;
  }
  const resp = await fetch(url, {
    method: req.method,
    headers,
    body: req.data === undefined ? undefined : JSON.stringify(req.data)
  });
  const text = await resp.text();
  let data: any = undefined;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: resp.status, data };
};

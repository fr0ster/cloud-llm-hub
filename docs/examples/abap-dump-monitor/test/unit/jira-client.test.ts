import { JiraClient, type JiraHttpFn } from '../../srv/jira-client';

describe('JiraClient', () => {
  test('searchByLabel returns first issue when found', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({
      status: 200,
      data: { issues: [{ key: 'X-1', fields: { status: { statusCategory: { key: 'indeterminate' } } } }] }
    });
    const c = new JiraClient('JIRA_EPAM', http);
    const r = await c.searchByLabel('E19.100:D-001');
    expect(r?.key).toBe('X-1');
    expect(r?.statusCategoryKey).toBe('indeterminate');
  });

  test('searchByLabel returns undefined when empty', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 200, data: { issues: [] } });
    const c = new JiraClient('JIRA_EPAM', http);
    expect(await c.searchByLabel('NONE')).toBeUndefined();
  });

  test('create posts and returns key', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 201, data: { key: 'X-9' } });
    const c = new JiraClient('JIRA_EPAM', http);
    const key = await c.create({
      projectKey: 'X', summary: 's', description: 'd', issueType: 'Story',
      duedate: '2026-05-10', labels: ['a', 'b']
    });
    expect(key).toBe('X-9');
    const call = (http as jest.Mock).mock.calls[0][1];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/rest/api/2/issue');
    expect(call.data.fields.assignee).toBeUndefined();
  });

  test('create includes assignee when given', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 201, data: { key: 'X-10' } });
    const c = new JiraClient('JIRA_EPAM', http);
    await c.create({
      projectKey: 'X', summary: 's', description: 'd', issueType: 'Story',
      duedate: '2026-05-10', labels: [], assignee: 'someone@x'
    });
    const call = (http as jest.Mock).mock.calls[0][1];
    expect(call.data.fields.assignee).toEqual({ name: 'someone@x' });
  });

  test('comment posts to /comment endpoint', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 201, data: {} });
    const c = new JiraClient('JIRA_EPAM', http);
    await c.comment('X-1', 'hello');
    const call = (http as jest.Mock).mock.calls[0][1];
    expect(call.url).toBe('/rest/api/2/issue/X-1/comment');
    expect(call.data).toEqual({ body: 'hello' });
  });

  test('throws on non-2xx', async () => {
    const http: JiraHttpFn = jest.fn().mockResolvedValue({ status: 400, data: { errorMessages: ['bad'] } });
    const c = new JiraClient('JIRA_EPAM', http);
    await expect(c.create({ projectKey: 'X', summary: 's', description: 'd', issueType: 'Story', duedate: '2026-05-10', labels: [] })).rejects.toThrow(/Jira create failed/);
  });
});

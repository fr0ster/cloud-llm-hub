import { readRoleModelHeaders } from '../../srv/lib/role-model-headers';

test('readRoleModelHeaders returns undefined without role headers', () => {
  expect(readRoleModelHeaders({})).toEqual({ ok: true, value: undefined });
});
test('auto and empty role headers clear a role', () => {
  expect(readRoleModelHeaders({ 'x-clh-model-executor': '' })).toEqual({
    ok: true,
    value: { executor: { model: '' } },
  });
});
test('malformed params name the refused header', () => {
  expect(readRoleModelHeaders({ 'x-clh-params-executor': '{' })).toMatchObject({
    ok: false,
    error: { field: 'x-clh-params-executor' },
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  clearExecutionLimits,
  getExecutionLimits,
} from '../../srv/lib/execution-limits';
import { applyRoleModelHeaders } from '../../srv/lib/role-model-headers';
import {
  clearRoleModels,
  getRoleModels,
  setRoleModels,
} from '../../srv/lib/role-model-settings';

let server: Server;
let base: string;
let admin = true;
beforeAll(async () => {
  process.env.LLM_AGENT_MODELS = 'first,second';
  const app = express();
  app.use(express.json());
  app.post('/', (req, res) => {
    if (req.headers['x-clh-session'])
      Object.assign(req, {
        longSession: {
          userId: 'headers-user',
          key: req.headers['x-clh-session'],
        },
      });
    if (applyRoleModelHeaders(req, res, 'headers-user', admin))
      res.json({ ok: true });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.LLM_AGENT_MODELS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  admin = true;
  clearRoleModels('headers-user', 'one');
  clearExecutionLimits('headers-user', 'one');
});
function request(headers: Record<string, string> = {}, body: object = {}) {
  return fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-clh-session': 'one',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
test('role headers update the session settings and persist across a later request without headers', async () => {
  expect((await request({ 'x-clh-model-executor': 'first' })).status).toBe(200);
  const later = await request();
  expect(
    JSON.parse(later.headers.get('x-clh-models-effective') ?? '{}').executor,
  ).toBe('first');
});
test('x-clh-model-coordinator wins over body model', async () => {
  const res = await request(
    { 'x-clh-model-coordinator': 'first' },
    { model: 'second' },
  );
  expect(
    JSON.parse(res.headers.get('x-clh-models-effective') ?? '{}').coordinator,
  ).toBe('first');
});
test('body model still selects the coordinator when no header is sent, and x-clh-model-ignored stays for a non-allowlisted body model', async () => {
  expect(
    JSON.parse(
      (await request({}, { model: 'second' })).headers.get(
        'x-clh-models-effective',
      ) ?? '{}',
    ).coordinator,
  ).toBe('second');
  expect(
    (await request({}, { model: 'other' })).headers.get('x-clh-model-ignored'),
  ).toBe('other');
});
test('an invalid role header fails the request with 400 naming the header and leaves settings unchanged', async () => {
  setRoleModels('headers-user', 'one', { executor: { model: 'first' } });
  const res = await request({
    'x-clh-model-executor': 'other',
    'x-clh-limits': '{"historyTokenBudget":12}',
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('x-clh-model-executor');
  expect(getRoleModels('headers-user', 'one')).toEqual({
    executor: { model: 'first' },
  });
  expect(getExecutionLimits('headers-user', 'one')).toEqual({});
});
test('role headers without x-clh-session fail with 400 naming x-clh-session', async () => {
  const res = await request({
    'x-clh-session': '',
    'x-clh-model-executor': 'first',
  });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('x-clh-session');
});
test('x-clh-params-executor is refused with the stage 2 reason', async () => {
  const res = await request({ 'x-clh-params-executor': '{"temperature":0.5}' });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('stage 2');
});
test('role or limit headers from a non-admin fail with 403 naming the header and store nothing', async () => {
  admin = false;
  for (const name of [
    'x-clh-model-executor',
    'x-clh-params-executor',
    'x-clh-limits',
  ]) {
    const res = await request({ [name]: 'invalid' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(name);
  }
  expect(getRoleModels('headers-user', 'one')).toEqual({});
  expect(getExecutionLimits('headers-user', 'one')).toEqual({});
});
test('limits merge field by field and invalid limits leave model settings unchanged', async () => {
  await request({
    'x-clh-limits': '{"executor":{"maxIterations":3,"maxToolCalls":5}}',
  });
  await request({ 'x-clh-limits': '{"executor":{"maxIterations":"off"}}' });
  expect(getExecutionLimits('headers-user', 'one')).toEqual({
    executor: { maxIterations: 'off', maxToolCalls: 5 },
  });
  expect(
    (
      await request({
        'x-clh-model-executor': 'first',
        'x-clh-limits': '{"planStepBudget":2}',
      })
    ).status,
  ).toBe(400);
  expect(getRoleModels('headers-user', 'one')).toEqual({});
});

test('body model from an admin still selects the coordinator', async () => {
  const res = await request({}, { model: 'second' });
  expect(res.status).toBe(200);
  expect(
    JSON.parse(res.headers.get('x-clh-models-effective') ?? '{}').coordinator,
  ).toBe('second');
});
test('auto clears only its role and empty headers clear previously unset roles', async () => {
  await request({
    'x-clh-model-executor': 'first',
    'x-clh-model-checker': 'second',
  });
  expect(
    (
      await request({
        'x-clh-model-executor': 'auto',
        'x-clh-model-planner': '',
      })
    ).status,
  ).toBe(200);
  expect(getRoleModels('headers-user', 'one')).toEqual({
    checker: { model: 'second' },
  });
});
test('effective models remain complete JSON beyond 128 characters', async () => {
  await request({
    'x-clh-model-coordinator': 'first',
    'x-clh-model-planner': 'first',
    'x-clh-model-executor': 'first',
    'x-clh-model-checker': 'second',
  });
  const res = await request();
  expect(JSON.parse(res.headers.get('x-clh-models-effective') ?? '{}')).toEqual(
    {
      coordinator: 'first',
      planner: 'first',
      executor: 'first',
      checker: 'second',
    },
  );
});

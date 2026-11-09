import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const mockUser = { id: 'alice', admin: true };
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    get context() {
      return {
        user: {
          id: mockUser.id,
          is: (role: string) => role === 'MCP_Admin' && mockUser.admin,
        },
      };
    },
  },
}));

import {
  clearExecutionLimits,
  getExecutionLimits,
} from '../../srv/lib/execution-limits';
import { requireAdminRole } from '../../srv/lib/require-admin-role';
import {
  clearRoleModels,
  getRoleModels,
  setRoleModels,
} from '../../srv/lib/role-model-settings';
import {
  handleGetSessionModels,
  handlePutSessionModels,
} from '../../srv/session-models-handler';

let server: Server;
let base: string;
beforeAll(async () => {
  process.env.LLM_AGENT_MODELS = 'gpt-4.1,gpt-5';
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-clh-session'])
      Object.assign(req, {
        longSession: { userId: 'alice', key: req.headers['x-clh-session'] },
      });
    next();
  });
  app.get('/', handleGetSessionModels);
  app.put('/', requireAdminRole, handlePutSessionModels);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.LLM_AGENT_MODELS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
afterEach(() => {
  mockUser.id = 'alice';
  mockUser.admin = true;
  for (const key of ['one', 'two', '']) {
    clearRoleModels('alice', key);
    clearExecutionLimits('alice', key);
  }
});
function call(method = 'GET', body?: object, key = 'one') {
  return fetch(base, {
    method,
    headers: { 'content-type': 'application/json', 'x-clh-session': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
it('GET without x-clh-session is 400 naming x-clh-session', async () => {
  const res = await call('GET', undefined, '');
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { field: 'x-clh-session', reason: expect.any(String) },
  });
});
it('PUT stores and GET returns settings and effective models', async () => {
  const res = await call('PUT', {
    executor: { model: 'gpt-5' },
    limits: { historyTokenBudget: 'off' },
  });
  expect(res.status).toBe(200);
  expect(await (await call()).json()).toMatchObject({
    settings: { executor: { model: 'gpt-5' } },
    effective: { executor: { model: 'gpt-5', source: 'user' } },
    limits: { historyTokenBudget: 'off' },
    effectiveLimits: { historyTokenBudget: { value: 'off', source: 'user' } },
    canEdit: true,
    capabilities: { 'gpt-5': expect.any(Object) },
  });
  expect(await (await call('GET', undefined, 'two')).json()).toMatchObject({
    settings: {},
    limits: {},
  });
});
it('PUT with params is 400 with the stage 2 reason and leaves settings unchanged', async () => {
  setRoleModels('alice', 'one', { checker: { model: 'gpt-4.1' } });
  const res = await call('PUT', {
    executor: { model: 'gpt-5', params: { temperature: 1 } },
    limits: { historyTokenBudget: 'off' },
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    error: {
      field: 'executor.params',
      reason: expect.stringContaining('stage 2'),
    },
  });
  expect(getRoleModels('alice', 'one')).toEqual({
    checker: { model: 'gpt-4.1' },
  });
  expect(getExecutionLimits('alice', 'one')).toEqual({});
});
it('invalid limits leave models unchanged', async () => {
  const res = await call('PUT', {
    executor: { model: 'gpt-5' },
    limits: { planStepBudget: 3 },
  });
  expect(res.status).toBe(400);
  expect(getRoleModels('alice', 'one')).toEqual({});
});
it('PUT by a non-admin is 403 and leaves settings unchanged', async () => {
  mockUser.admin = false;
  expect((await call('PUT', { executor: { model: 'gpt-5' } })).status).toBe(
    403,
  );
  expect(getRoleModels('alice', 'one')).toEqual({});
});
it('GET by a non-admin returns settings with canEdit false', async () => {
  mockUser.admin = false;
  expect(await (await call()).json()).toMatchObject({
    settings: {},
    canEdit: false,
  });
});
it('refuses reading and writing another user session', async () => {
  mockUser.id = 'bob';
  expect((await call()).status).toBe(404);
  expect((await call('PUT', {})).status).toBe(404);
});
it('PUT without a session never stores under an empty key', async () => {
  expect((await call('PUT', { executor: { model: 'gpt-5' } }, '')).status).toBe(
    400,
  );
  expect(getRoleModels('alice', '')).toEqual({});
});

it('GET exposes the parameters actually sent for every role with their sources', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.LLM_AGENT_TEMPERATURE;
    delete process.env.SAP_CORE_AI_TEMPERATURE;
    delete process.env.LLM_AGENT_MAX_TOKENS;
    delete process.env.SAP_CORE_AI_MAX_TOKENS;
    const params = {
      temperature: { value: 0.7, source: 'default' },
      maxOutputTokens: { value: 2000, source: 'default' },
    };
    expect(await (await call()).json()).toMatchObject({
      effective: Object.fromEntries(
        ['coordinator', 'planner', 'executor', 'checker'].map((role) => [
          role,
          { params },
        ]),
      ),
    });
    process.env.LLM_AGENT_TEMPERATURE = '0.2';
    process.env.LLM_AGENT_MAX_TOKENS = '4096';
    expect(await (await call()).json()).toMatchObject({
      effective: Object.fromEntries(
        ['coordinator', 'planner', 'executor', 'checker'].map((role) => [
          role,
          {
            params: {
              temperature: { value: 0.2, source: 'config' },
              maxOutputTokens: { value: 4096, source: 'config' },
            },
          },
        ]),
      ),
    });
  } finally {
    process.env = saved;
  }
});

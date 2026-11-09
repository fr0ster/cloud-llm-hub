import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IModelInfo } from '@mcp-abap-adt/llm-agent';
import express from 'express';

const mockCatalog = jest.fn<Promise<IModelInfo[]>, []>();
const mockError = jest.fn();
jest.mock('../../srv/lib/llm-factory', () => ({
  makeHubCatalogProvider: () => ({ getModelCatalog: mockCatalog }),
}));
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: {
    log: () => ({ error: mockError }),
    context: { user: { id: 'alice', is: () => true } },
  },
}));

import { BuildValidationError } from '../../srv/lib/build-validation-error';
import { configuredRoleModel } from '../../srv/lib/deploy-role-config';
import {
  ensureModelCatalog,
  resetModelCatalog,
  validateModelCatalogProvider,
} from '../../srv/lib/model-catalog';
import {
  parseModelAllowlist,
  usesModelCatalog,
} from '../../srv/lib/model-policy';
import {
  currentRoleModel,
  RoleModelNotAllowedError,
} from '../../srv/lib/role-models-scope';
import { handleGetSessionModels } from '../../srv/session-models-handler';

const originalEnv = { ...process.env };
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { longSession: { userId: 'alice', key: 'one' } });
    next();
  });
  app.get('/v1/session/models', handleGetSessionModels);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  process.env = {
    ...originalEnv,
    LLM_AGENT_MODELS: 'catalog,extra',
    LLM_AGENT_MODEL: 'main',
    LLM_AGENT_PLANNER_MODEL: 'planner',
    LLM_AGENT_PROVIDER: 'sap-ai-sdk',
  };
  resetModelCatalog();
  mockCatalog.mockReset();
  mockError.mockClear();
});
afterEach(() => {
  process.env = originalEnv;
  resetModelCatalog();
});

it('parses catalog as a token and preserves explicit behavior', () => {
  expect(usesModelCatalog({ LLM_AGENT_MODELS: ' catalog ,extra' })).toBe(true);
  expect(usesModelCatalog({ LLM_AGENT_MODELS: 'catalog-other' })).toBe(false);
  expect([...parseModelAllowlist()]).toEqual(['extra', 'main', 'planner']);
  expect([...parseModelAllowlist({ LLM_AGENT_MODELS: 'a,a,b' })]).toEqual([
    'a',
    'b',
  ]);
});
it('publishes only eligible chat catalog entries and leaves non-catalog policies alone', async () => {
  const chat = {
    capabilities: ['text-generation'],
    scenarios: ['orchestration'],
  };
  mockCatalog.mockResolvedValue([
    { id: 'gpt-6-luna', ...chat },
    { id: 'old', ...chat, deprecated: true },
    {
      id: 'embedding',
      capabilities: ['embedding'],
      scenarios: ['orchestration'],
    },
    {
      id: 'image',
      capabilities: ['image-generation'],
      scenarios: ['orchestration'],
    },
    {
      id: 'other-scenario',
      capabilities: ['text-generation'],
      scenarios: ['other'],
    },
    { id: 'missing-fields' },
  ]);
  expect(parseModelAllowlist().has('gpt-6-luna')).toBe(false);
  await ensureModelCatalog();
  expect([...parseModelAllowlist()]).toEqual([
    'extra',
    'main',
    'planner',
    'gpt-6-luna',
  ]);
  expect([...parseModelAllowlist({ LLM_AGENT_MODELS: 'explicit' })]).toEqual([
    'explicit',
  ]);
  await ensureModelCatalog();
  expect(mockCatalog).toHaveBeenCalledTimes(1);
});
it('keeps explicit models on failure, logs the cause once, and retries on session GET', async () => {
  const cause = new Error('catalog unavailable');
  mockCatalog
    .mockRejectedValueOnce(cause)
    .mockRejectedValueOnce(cause)
    .mockResolvedValue([
      {
        id: 'new',
        capabilities: ['text-generation'],
        scenarios: ['orchestration'],
      },
    ]);
  await ensureModelCatalog();
  expect([...parseModelAllowlist()]).toEqual(['extra', 'main', 'planner']);
  const get = () =>
    fetch(`${base}/v1/session/models`, { headers: { 'x-clh-session': 'one' } });
  expect((await get()).status).toBe(200);
  const res = await get();
  expect(res.status).toBe(200);
  expect(parseModelAllowlist().has('new')).toBe(true);
  expect(mockError).toHaveBeenCalledTimes(1);
  expect(mockError).toHaveBeenCalledWith(
    expect.stringContaining('LLM_AGENT_MODELS'),
    cause,
  );
});
it('shares concurrent loads', async () => {
  let finish: (models: IModelInfo[]) => void = () => {};
  mockCatalog.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = ensureModelCatalog();
  const second = ensureModelCatalog();
  expect(first).toBe(second);
  await Promise.resolve();
  await Promise.resolve();
  finish([]);
  await first;
  expect(mockCatalog).toHaveBeenCalledTimes(1);
});
it('rejects catalog with other providers during startup validation', () => {
  for (const provider of ['openai', 'anthropic', 'deepseek']) {
    expect(() =>
      validateModelCatalogProvider({
        LLM_AGENT_MODELS: 'catalog',
        LLM_AGENT_PROVIDER: provider,
      }),
    ).toThrow(BuildValidationError);
    expect(() =>
      validateModelCatalogProvider({
        LLM_AGENT_MODELS: 'catalog',
        LLM_AGENT_PROVIDER: provider,
      }),
    ).toThrow('LLM_AGENT_MODELS');
  }
  expect(() =>
    validateModelCatalogProvider({ LLM_AGENT_MODELS: 'catalog' }),
  ).not.toThrow();
});
it('defers configured role checks, logs missing models after loading, and rejects at runtime', async () => {
  process.env.LLM_AGENT_EXECUTOR_MODEL = 'missing-executor';
  process.env.LLM_AGENT_CHECKER_MODEL = 'missing-checker';
  expect(configuredRoleModel('executor')).toBe('missing-executor');
  mockCatalog.mockResolvedValue([]);
  await ensureModelCatalog();
  expect(mockError).toHaveBeenCalledTimes(2);
  expect(mockError).toHaveBeenCalledWith(
    expect.stringContaining('LLM_AGENT_EXECUTOR_MODEL'),
  );
  expect(mockError).toHaveBeenCalledWith(
    expect.stringContaining('LLM_AGENT_CHECKER_MODEL'),
  );
  expect(() => currentRoleModel('executor')).toThrow(RoleModelNotAllowedError);
});

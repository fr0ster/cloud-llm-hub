jest.mock('../../srv/agent-manager', () => ({ getProviders: jest.fn() }));

import { getProviders } from '../../srv/agent-manager';
import {
  forgetPlannerMemory,
  getSharedPlannerMemoryRag,
  plannerSessionOptions,
} from '../../srv/lib/planner-memory';

const providers = jest.mocked(getProviders);

afterEach(() => providers.mockReset());

it('opens without planner retrieval and skips cleanup when providers are missing', async () => {
  expect(await plannerSessionOptions('alice', 'key')).toEqual({});
  expect(getSharedPlannerMemoryRag()).toBeUndefined();
  expect(await forgetPlannerMemory('owner')).toBe(true);
});

it('contains provider initialization failures during session opening and cleanup', async () => {
  providers.mockImplementation(() => {
    throw new Error('provider unavailable');
  });
  expect(await plannerSessionOptions('alice', 'key')).toEqual({});
  expect(getSharedPlannerMemoryRag()).toBeUndefined();
  expect(await forgetPlannerMemory('owner')).toBe(true);
});

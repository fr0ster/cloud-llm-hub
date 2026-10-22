import cds from '@sap/cds';
import { setGlobalLogLevel } from '@sap-cloud-sdk/util';
import {
  applyLoggingConfig,
  parseLoggingConfig,
} from '../../srv/lib/logging-config';

jest.mock('@sap-cloud-sdk/util', () => ({ setGlobalLogLevel: jest.fn() }));

test('defaults and named levels parse strictly', () => {
  expect(parseLoggingConfig({})).toEqual({
    defaultLevel: 'info',
    overrides: {},
  });
  expect(
    parseLoggingConfig({
      LLM_AGENT_LOG_LEVEL: 'debug',
      LLM_AGENT_LOG_LEVELS: 'smart-pipeline=warn, tool-rag=info',
    }).overrides,
  ).toEqual({ 'smart-pipeline': 'warn', 'tool-rag': 'info' });
});
test.each([
  { LLM_AGENT_LOG_LEVEL: 'trace' },
  { LLM_AGENT_LOG_LEVELS: 'x=bad' },
  { LLM_AGENT_LOG_LEVELS: 'broken' },
  { LLM_AGENT_LOG_LEVELS: 'x=info,' },
  { LLM_AGENT_LOG_LEVEL: '' },
])('rejects invalid input %p', (env) => {
  expect(() => parseLoggingConfig(env)).toThrow(/LLM_AGENT_LOG_LEVEL/);
});
test('updates existing and future CAP loggers and the SDK global level', () => {
  void cds.env;
  const existing = cds.log('logging-existing');
  applyLoggingConfig({
    LLM_AGENT_LOG_LEVEL: 'error',
    LLM_AGENT_LOG_LEVELS: 'logging-existing=debug,sap-cloud-sdk=error',
  });
  expect(existing._debug).toBe(true);
  expect(cds.log('logging-future')._info).toBe(false);
  expect(setGlobalLogLevel).toHaveBeenCalledWith('error');
  applyLoggingConfig({});
});

test('invalid overrides throw before any configuration is applied', () => {
  const levels = cds.env.log.levels;
  jest.mocked(setGlobalLogLevel).mockClear();
  expect(() =>
    applyLoggingConfig({ LLM_AGENT_LOG_LEVELS: 'sap-cloud-sdk=error,bad' }),
  ).toThrow('malformed entry');
  expect(cds.env.log.levels).toBe(levels);
  expect(setGlobalLogLevel).not.toHaveBeenCalled();
});

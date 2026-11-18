const mockInfo = jest.fn();
const mockWarn = jest.fn();
jest.mock('@sap/cds', () => ({
  __esModule: true,
  default: { log: () => ({ info: mockInfo, warn: mockWarn }) },
}));

import {
  logToolCallDiagnostics,
  toolCallDiagnosticsLogger,
} from '../../srv/lib/tool-call-diagnostics';

const response = {
  content: 'secret model text',
  receivedToolCalls: [
    { id: 'c1', name: 'ReadClass', argumentLength: 18 },
    { id: 'c2', name: 'GetTable', argumentLength: 40000 },
  ],
  rejectedToolCalls: [
    {
      id: 'c2',
      name: 'GetTable',
      argumentLength: 40000,
      reason: 'Tool arguments must be a complete JSON object.',
    },
  ],
  executableToolCalls: [{ id: 'c1', name: 'ReadClass' }],
  finishReason: 'tool_calls',
};

beforeEach(() => {
  mockInfo.mockClear();
  mockWarn.mockClear();
});

it('warns with received, rejected and executable counts and no content', () => {
  logToolCallDiagnostics('llm_response_iter_2', response, {
    channel: 'execute_step',
  });
  expect(mockWarn).toHaveBeenCalledWith('tool calls rejected', {
    channel: 'execute_step',
    step: 'llm_response_iter_2',
    finishReason: 'tool_calls',
    received: 2,
    rejected: 1,
    executable: 1,
    rejectedCalls: [
      {
        name: 'GetTable',
        reason: 'Tool arguments must be a complete JSON object.',
        argumentLength: 40000,
      },
    ],
  });
  expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('secret');
  expect(mockInfo).not.toHaveBeenCalled();
});

it('logs accepted tool calls at info through the dialogue logger', () => {
  toolCallDiagnosticsLogger({ channel: 'dialogue' }).logStep(
    'llm_response_pass',
    { ...response, rejectedToolCalls: [] },
  );
  expect(mockInfo).toHaveBeenCalledWith(
    'tool calls',
    expect.objectContaining({ channel: 'dialogue', received: 2, rejected: 0 }),
  );
  expect(mockWarn).not.toHaveBeenCalled();
});

it('ignores other steps and responses without tool calls', () => {
  const logger = toolCallDiagnosticsLogger({ channel: 'dialogue' });
  logger.logStep('tools_selected', response);
  logger.logStep('llm_response_iter_1', {
    content: 'answer',
    receivedToolCalls: [],
    rejectedToolCalls: [],
    executableToolCalls: [],
  });
  expect(mockInfo).not.toHaveBeenCalled();
  expect(mockWarn).not.toHaveBeenCalled();
});

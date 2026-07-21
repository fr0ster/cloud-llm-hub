import { RecordingRequestLogger } from '../../srv/lib/recording-request-logger';

function llmEntry(
  requestId: string | undefined,
  model: string,
  totalTokens: number,
) {
  return {
    component: 'tool-loop' as const,
    model,
    promptTokens: totalTokens,
    completionTokens: 0,
    totalTokens,
    durationMs: 1,
    requestId,
  };
}

function toolEntry(requestId: string | undefined, toolName: string) {
  return {
    toolName,
    success: true,
    durationMs: 1,
    cached: false,
    requestId,
  };
}

describe('RecordingRequestLogger', () => {
  test('(a) nested startRequest(t1) does NOT wipe the first batch', () => {
    const logger = new RecordingRequestLogger();

    logger.startRequest('t1');
    logger.logToolCall(toolEntry('t1', 'ReadTable'));
    logger.logLlmCall(llmEntry('t1', 'gpt-4', 100));

    // Nested worker call under the SAME traceId.
    logger.startRequest('t1');
    logger.logToolCall(toolEntry('t1', 'GetObject'));
    logger.logLlmCall(llmEntry('t1', 'gpt-4', 50));
    logger.endRequest('t1');

    // First batch's data must still be present after the nested end.
    expect(logger.executedToolNames('t1')).toEqual(['ReadTable', 'GetObject']);
    expect(logger.getSummary('t1').byModel['gpt-4'].totalTokens).toBe(150);

    logger.endRequest('t1');
  });

  test('(b) two requestIds stay isolated in executedToolNames + getSummary', () => {
    const logger = new RecordingRequestLogger();

    logger.startRequest('t1');
    logger.startRequest('t2');

    logger.logToolCall(toolEntry('t1', 'ReadTable'));
    logger.logLlmCall(llmEntry('t1', 'gpt-4', 10));

    logger.logToolCall(toolEntry('t2', 'GetObject'));
    logger.logToolCall(toolEntry('t2', 'DeleteObject'));
    logger.logLlmCall(llmEntry('t2', 'gpt-4', 20));

    expect(logger.executedToolNames('t1')).toEqual(['ReadTable']);
    expect(logger.executedToolNames('t2')).toEqual([
      'GetObject',
      'DeleteObject',
    ]);
    expect(logger.getSummary('t1').byModel['gpt-4'].totalTokens).toBe(10);
    expect(logger.getSummary('t2').byModel['gpt-4'].totalTokens).toBe(20);
    expect(logger.getSummary('t1').toolCalls).toBe(1);
    expect(logger.getSummary('t2').toolCalls).toBe(2);
  });

  test('(c) dropRequest(t1) frees it', () => {
    const logger = new RecordingRequestLogger();

    logger.startRequest('t1');
    logger.logToolCall(toolEntry('t1', 'ReadTable'));
    logger.logLlmCall(llmEntry('t1', 'gpt-4', 10));

    logger.dropRequest('t1');

    expect(logger.executedToolNames('t1')).toEqual([]);
    const summary = logger.getSummary('t1');
    expect(summary.toolCalls).toBe(0);
    expect(summary.byModel).toEqual({});
  });

  test('(d) getSummary(t1) reflects only t1 tokens + toolCalls count', () => {
    const logger = new RecordingRequestLogger();

    logger.startRequest('t1');
    logger.logLlmCall(llmEntry('t1', 'gpt-4', 30));
    logger.logLlmCall(llmEntry('t1', 'gpt-4', 20));
    logger.logToolCall(toolEntry('t1', 'ReadTable'));
    logger.logToolCall(toolEntry('t1', 'GetObject'));
    logger.logToolCall(toolEntry('t1', 'DeleteObject'));

    // Unrelated request must not leak in.
    logger.startRequest('t2');
    logger.logLlmCall(llmEntry('t2', 'gpt-4', 999));
    logger.logToolCall(toolEntry('t2', 'Noise'));

    const summary = logger.getSummary('t1');
    expect(summary.byModel['gpt-4'].totalTokens).toBe(50);
    expect(summary.toolCalls).toBe(3);
  });

  test('(e) cumulative vs delta: getSummary() includes t1, survives dropRequest(t1)', () => {
    const logger = new RecordingRequestLogger();

    logger.startRequest('t1');
    logger.logLlmCall(llmEntry('t1', 'gpt-4', 40));
    logger.logToolCall(toolEntry('t1', 'ReadTable'));

    const cumulativeBefore = logger.getSummary();
    expect(
      cumulativeBefore.byModel['gpt-4'].totalTokens,
    ).toBeGreaterThanOrEqual(40);
    expect(cumulativeBefore.toolCalls).toBeGreaterThanOrEqual(1);

    logger.dropRequest('t1');

    const cumulativeAfter = logger.getSummary();
    expect(cumulativeAfter.byModel['gpt-4'].totalTokens).toBe(
      cumulativeBefore.byModel['gpt-4'].totalTokens,
    );
    expect(cumulativeAfter.toolCalls).toBe(cumulativeBefore.toolCalls);

    expect(logger.getSummary('t1').byModel).toEqual({});
    expect(logger.getSummary('t1').toolCalls).toBe(0);
  });

  test('(f) a call with undefined requestId accrues to cumulative only', () => {
    const logger = new RecordingRequestLogger();

    logger.logLlmCall(llmEntry(undefined, 'gpt-4', 15));
    logger.logToolCall(toolEntry(undefined, 'ReadTable'));

    expect(logger.getSummary().byModel['gpt-4'].totalTokens).toBe(15);
    expect(logger.getSummary().toolCalls).toBe(1);
    expect(logger.executedToolNames()).toEqual(['ReadTable']);

    // No requestId means no delta bucket was ever created.
    expect(logger.executedToolNames('anything')).toEqual([]);
  });
});

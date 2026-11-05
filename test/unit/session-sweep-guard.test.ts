jest.mock('../../srv/lib/session-config', () => ({
  sessionConfig: () => {
    throw new Error('config unavailable');
  },
}));

test('a failing session history sweep is logged, never thrown from the timer', async () => {
  jest.useFakeTimers();
  try {
    await jest.isolateModulesAsync(async () => {
      await import('../../srv/session-store');
    });
    expect(() => jest.advanceTimersByTime(5 * 60 * 1000)).not.toThrow();
  } finally {
    jest.useRealTimers();
  }
});

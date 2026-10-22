import { watchDestinations } from '../../srv/lib/destination-watch';

afterEach(() => jest.useRealTimers());
test('discovers at 0, 5, 10, 20 seconds then the normal interval', async () => {
  jest.useFakeTimers();
  const check = jest.fn(async () => false);
  const settled = jest.fn();
  const stop = watchDestinations(check, settled, 60000);
  for (const [delay, calls] of [
    [0, 1],
    [5000, 2],
    [5000, 3],
    [10000, 4],
    [59999, 4],
    [1, 5],
  ]) {
    await jest.advanceTimersByTimeAsync(delay);
    expect(check).toHaveBeenCalledTimes(calls);
  }
  expect(settled).toHaveBeenCalledTimes(1);
  stop();
});
test('a discovered destination stops retries', async () => {
  jest.useFakeTimers();
  const check = jest.fn(async () => true);
  const settled = jest.fn();
  watchDestinations(check, settled, 60000);
  await jest.advanceTimersByTimeAsync(100000);
  expect(check).toHaveBeenCalledTimes(1);
  expect(settled).toHaveBeenCalledTimes(1);
});
test('fast retries use startup deadlines rather than adding fetch duration', async () => {
  jest.useFakeTimers();
  const check = jest.fn(
    () =>
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  );
  const stop = watchDestinations(check, jest.fn(), 60000);
  await jest.advanceTimersByTimeAsync(20000);
  expect(check).toHaveBeenCalledTimes(4);
  stop();
  await jest.advanceTimersByTimeAsync(2000);
});

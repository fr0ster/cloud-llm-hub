/**
 * Regression test for the fix to "SAP credentials are required" on tool calls.
 *
 * The bug: setRequestConnection used AsyncLocalStorage.enterWith(), whose store
 * is lost across the SmartAgent pipeline's await/promise hops, so callToolHandler
 * saw an empty store and threw even though a valid per-request connection had
 * just been established. The fix binds the connection for the WHOLE async subtree
 * via connectionALS.run() (runWithRequestConnection).
 *
 * This test exercises the AsyncLocalStorage semantics directly: a store bound via
 * run() must remain visible after multiple awaits / nested async calls, whereas
 * enterWith() does not guarantee that across independent async scopes.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, debug() {}, error() {} }) },
  }),
  { virtual: true },
);

describe('per-request connection ALS semantics (runWithRequestConnection)', () => {
  test('store bound via run() survives awaits and nested async calls', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();

    const deepRead = async (): Promise<string | undefined> => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      await Promise.resolve();
      return als.getStore()?.id;
    };

    const result = await als.run({ id: 'conn-123' }, async () => {
      await Promise.resolve();
      // Simulate the agent pipeline calling a tool several awaits deep.
      return deepRead();
    });

    expect(result).toBe('conn-123');
  });

  test('concurrent run() scopes stay isolated (no cross-request leakage)', async () => {
    const als = new AsyncLocalStorage<{ id: string }>();

    const task = (id: string) =>
      als.run({ id }, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return als.getStore()?.id;
      });

    const [a, b, c] = await Promise.all([
      task('user-a'),
      task('user-b'),
      task('user-c'),
    ]);

    expect(a).toBe('user-a');
    expect(b).toBe('user-b');
    expect(c).toBe('user-c');
  });

  test('outside any run() scope the store is undefined (fail-closed)', () => {
    const als = new AsyncLocalStorage<{ id: string }>();
    expect(als.getStore()).toBeUndefined();
  });
});

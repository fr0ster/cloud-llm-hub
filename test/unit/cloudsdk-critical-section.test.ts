import { CloudSdkAbapConnection } from '../../srv/connections/CloudSdkAbapConnection';

// The BTP-destination connection `implements AbapConnection` (does NOT extend the
// base), so core's `conn?.beginCriticalSection?.()` wrapping was a silent no-op and
// a slow write on a BTP destination got cut mid-flight, orphaning the lock. These
// tests cover the ref-counted critical-section primitives we added.
function makeConn() {
  return new CloudSdkAbapConnection(
    { url: 'https://example', authType: 'basic' } as any,
    'S4HANA_TEST',
  );
}

describe('CloudSdkAbapConnection critical section', () => {
  it('starts outside a critical section', () => {
    expect(makeConn().isInCriticalSection()).toBe(false);
  });

  it('begin enters, end leaves', () => {
    const c = makeConn();
    c.beginCriticalSection();
    expect(c.isInCriticalSection()).toBe(true);
    c.endCriticalSection();
    expect(c.isInCriticalSection()).toBe(false);
  });

  it('is reference-counted — a nested pair does not leave early', () => {
    const c = makeConn();
    c.beginCriticalSection();
    c.beginCriticalSection();
    c.endCriticalSection();
    expect(c.isInCriticalSection()).toBe(true); // still inside (depth 1)
    c.endCriticalSection();
    expect(c.isInCriticalSection()).toBe(false); // outermost ended
  });

  it('over-ending is clamped and never throws', () => {
    const c = makeConn();
    c.endCriticalSection();
    c.endCriticalSection();
    expect(c.isInCriticalSection()).toBe(false);
  });
});

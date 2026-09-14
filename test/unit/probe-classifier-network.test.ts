import { classifyProbe } from '../../srv/lib/probe-classifier';

describe('classifyProbe — the plain shapes of a host that is gone', () => {
  for (const signature of [
    'ENOTFOUND',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'socket hang up',
  ]) {
    it(`reads ${signature} as a network failure`, () => {
      expect(
        classifyProbe(0, `connect ${signature} 10.0.0.1:44300`, 'OnPremise')
          .status,
      ).toBe('dns_or_network');
    });
  }

  it('still leaves a backend answer alone', () => {
    // The host answered; it simply said no. Reading this as a network failure
    // would close a destination that is working.
    expect(classifyProbe(401, 'Unauthorized', 'OnPremise').status).not.toBe(
      'dns_or_network',
    );
  });
});

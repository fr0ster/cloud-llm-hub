import { classifyProbe } from '../../srv/lib/probe-classifier';

describe('classifyProbe — the plain shapes of a host that is gone', () => {
  for (const signature of [
    'ENOTFOUND',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
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

  describe('a reset that might mean the write already ran', () => {
    for (const signature of ['ECONNRESET', 'EPIPE', 'socket hang up']) {
      it(`does not read "${signature}" as a network failure`, () => {
        // These fire on a connection that opened, possibly after the request
        // body was sent — on the connector's one long-lived keep-alive socket
        // (maxSockets:1), that can mean SAP ran the write and dropped the
        // connection afterwards, not that nothing reached it. Closing a
        // destination on it would be wrong far more often than right.
        expect(
          classifyProbe(0, `connect ${signature} 10.0.0.1:44300`, 'OnPremise')
            .status,
        ).not.toBe('dns_or_network');
      });
    }
  });
});

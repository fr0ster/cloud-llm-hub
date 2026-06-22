import { classifyProbe } from '../../srv/lib/probe-classifier';

describe('classifyProbe', () => {
  it('returns ok for 2xx', () => {
    const r = classifyProbe(200, '', 'OnPremise');
    expect(r.status).toBe('ok');
  });

  it('classifies 401 / logon failure as backend_auth_failed', () => {
    expect(classifyProbe(401, '', 'OnPremise').status).toBe(
      'backend_auth_failed',
    );
    expect(
      classifyProbe(500, 'Anmeldung fehlgeschlagen', 'OnPremise').status,
    ).toBe('backend_auth_failed');
  });

  it('classifies a TLS certificate_expired 5xx as a TLS problem, not a generic 5xx', () => {
    const raw =
      'javax.net.ssl.SSLHandshakeException: (certificate_expired) ' +
      'Received fatal alert: certificate_expired';
    const r = classifyProbe(500, raw, 'OnPremise');
    expect(r.status).toBe('backend_error');
    // The hint must name the certificate cause and point at the right side,
    // not the generic "backend returned 5xx — inspect ABAP system" message.
    expect(r.hint).toMatch(/certificate|TLS/i);
    expect(r.hint).toMatch(/Cloud Connector|STRUST|server cert/i);
  });

  it('classifies other SSL handshake failures as TLS problems', () => {
    for (const raw of [
      'SSLHandshakeException: unable to find valid certification path',
      'PKIX path validation failed',
      'Received fatal alert: bad_certificate',
    ]) {
      const r = classifyProbe(500, raw, 'OnPremise');
      expect(r.hint).toMatch(/certificate|TLS/i);
    }
  });

  it('still classifies a plain 5xx (no TLS markers) as generic backend_error', () => {
    const r = classifyProbe(500, 'ABAP runtime error DUMP', 'OnPremise');
    expect(r.status).toBe('backend_error');
    expect(r.hint).not.toMatch(/certificate/i);
  });

  it('classifies DNS / network errors', () => {
    expect(classifyProbe(0, 'getaddrinfo ENOTFOUND host', 'OnPremise').status).toBe(
      'dns_or_network',
    );
  });
});

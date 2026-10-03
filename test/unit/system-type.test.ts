/**
 * The system kind is DECLARED, never inferred: header > destination property >
 * `onprem`. An unknown value is refused, never defaulted.
 */

import {
  InvalidSystemTypeError,
  parseSystemType,
  resolveSystemType,
} from '../../srv/lib/system-type';

describe('resolveSystemType — the one precedence rule', () => {
  it('the x-sap-system-type header wins over the destination property', () => {
    expect(resolveSystemType({ 'x-sap-system-type': 'cloud' }, 'onprem')).toBe(
      'cloud',
    );
    expect(resolveSystemType({ 'x-sap-system-type': 'onprem' }, 'cloud')).toBe(
      'onprem',
    );
  });

  it('the destination property applies when no header is sent', () => {
    expect(resolveSystemType({}, 'cloud')).toBe('cloud');
    expect(resolveSystemType({}, 'legacy')).toBe('legacy');
  });

  it('defaults to onprem when nothing declares a kind', () => {
    expect(resolveSystemType({})).toBe('onprem');
    expect(resolveSystemType({ 'x-sap-system-type': '   ' })).toBe('onprem');
  });

  it('accepts every lib kind, case-insensitive and trimmed', () => {
    expect(resolveSystemType({ 'x-sap-system-type': ' Cloud ' })).toBe('cloud');
    expect(resolveSystemType({ 'x-sap-system-type': 'LEGACY' })).toBe('legacy');
    expect(resolveSystemType({ 'x-sap-system-type': ['cloud', 'x'] })).toBe(
      'cloud',
    );
  });

  it('refuses an unknown header value with a 400, even when the destination declares one', () => {
    let caught: unknown;
    try {
      resolveSystemType({ 'x-sap-system-type': 'bogus' }, 'onprem');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidSystemTypeError);
    expect((caught as InvalidSystemTypeError).statusCode).toBe(400);
    expect((caught as InvalidSystemTypeError).code).toBe('INVALID_SYSTEM_TYPE');
    expect((caught as Error).message).toMatch(
      /x-sap-system-type must be one of onprem, cloud, legacy; got "bogus"/,
    );
  });

  it('infers nothing from the URL, the proxy type or the authentication', () => {
    // Every header that used to suggest "cloud" — none of them is read.
    expect(
      resolveSystemType({
        'x-sap-url': 'https://my.abap.example.hana.ondemand.com',
        'x-sap-jwt-token': 'eyJ...',
        'x-sap-auth-type': 'jwt',
        'x-sap-proxy-type': 'Internet',
      }),
    ).toBe('onprem');
  });
});

describe('parseSystemType — one declared value', () => {
  it('is undefined when nothing is declared', () => {
    expect(parseSystemType(undefined, 'x')).toBeUndefined();
    expect(parseSystemType('', 'x')).toBeUndefined();
  });

  it('names the source in the refusal', () => {
    expect(() =>
      parseSystemType('Internet', 'Destination "D" property SAP_SYSTEM_TYPE'),
    ).toThrow(
      'Destination "D" property SAP_SYSTEM_TYPE must be one of onprem, cloud, legacy; got "Internet"',
    );
  });
});

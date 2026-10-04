/**
 * The raw route's error body names the status it is sent with: a refused
 * request never reads "Internal Server Error".
 */

import { httpErrorText } from '../../srv/lib/errorUtils';

describe('httpErrorText', () => {
  it('uses the reason phrase of the status', () => {
    expect(
      httpErrorText(
        400,
        'Header x-sap-system-type must be one of onprem, cloud, legacy; got "bogus"',
      ),
    ).toBe(
      'Bad Request: Header x-sap-system-type must be one of onprem, cloud, legacy; got "bogus"',
    );
    expect(
      httpErrorText(401, 'SAP connection failed for destination "D"'),
    ).toBe('Unauthorized: SAP connection failed for destination "D"');
    expect(httpErrorText(502, 'x')).toBe('Bad Gateway: x');
    expect(httpErrorText(500, 'x')).toBe('Internal Server Error: x');
  });

  it('no 4xx body says Internal Server Error', () => {
    for (let s = 400; s < 500; s++) {
      expect(httpErrorText(s, 'm')).not.toMatch(/Internal Server Error/);
    }
  });

  it('an unknown status still gets a body', () => {
    expect(httpErrorText(599, 'm')).toBe('Error: m');
  });
});

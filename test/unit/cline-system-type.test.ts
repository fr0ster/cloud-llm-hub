/**
 * tools/update-cline-connection.js declares the system type, never infers it:
 * the templates that dial ABAP Cloud (direct-jwt, cloud-internet) state
 * `systemType: cloud`, direct-basic states `onprem`, and the header follows
 * the declaration — a JWT alone does not make a connection cloud.
 */

import yaml from 'js-yaml';

// The tool is a CommonJS script.
const tool = require('../../tools/update-cline-connection.js') as {
  applySapConfigToHeaders: (
    headers: Record<string, string>,
    sapConfig: Record<string, string | undefined>,
    overrides: Record<string, string | undefined>,
  ) => { updated: string[] };
  buildConnectionConfigFromNewSchema: (
    raw: unknown,
    name: string,
  ) => { sap?: { systemType?: string } };
  TEMPLATE_RENDERERS: Record<string, (o?: object) => string>;
};

const jwt = { SAP_URL: 'https://abap.example.invalid', SAP_JWT_TOKEN: 't' };

describe('applySapConfigToHeaders — x-sap-system-type', () => {
  it('emits the declared type (flag or SAP_SYSTEM_TYPE)', () => {
    const h: Record<string, string> = {};
    tool.applySapConfigToHeaders(h, { ...jwt, SAP_SYSTEM_TYPE: 'Cloud' }, {});
    expect(h['x-sap-system-type']).toBe('cloud');
    const f: Record<string, string> = {};
    tool.applySapConfigToHeaders(f, jwt, { systemType: 'legacy' });
    expect(f['x-sap-system-type']).toBe('legacy');
  });

  it('infers nothing from a JWT: no declaration, no header', () => {
    const h: Record<string, string> = {};
    tool.applySapConfigToHeaders(h, jwt, {});
    expect(h['x-sap-system-type']).toBeUndefined();
  });

  it('refuses an unknown type', () => {
    expect(() =>
      tool.applySapConfigToHeaders(
        {},
        { ...jwt, SAP_SYSTEM_TYPE: 'bogus' },
        {},
      ),
    ).toThrow(/Unsupported SAP system type "bogus"/);
  });
});

describe('templates declare the system type', () => {
  const systemTypeOf = (template: string) => {
    const raw = yaml.load(tool.TEMPLATE_RENDERERS[template]()) as object;
    return tool.buildConnectionConfigFromNewSchema(raw, template).sap
      ?.systemType;
  };

  it('direct-jwt and cloud-internet dial ABAP Cloud', () => {
    expect(systemTypeOf('direct-jwt')).toBe('cloud');
    expect(systemTypeOf('cloud-internet')).toBe('cloud');
  });

  it('direct-basic states onprem; cloud-destination leaves it to the destination', () => {
    expect(systemTypeOf('direct-basic')).toBe('onprem');
    expect(systemTypeOf('cloud-destination')).toBeUndefined();
  });
});

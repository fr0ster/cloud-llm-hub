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

describe('applySapConfigToHeaders — header names the hub reads', () => {
  const basic = {
    SAP_URL: 'https://abap.example.invalid',
    SAP_CLIENT: '100',
    SAP_AUTH_TYPE: 'basic',
    SAP_USERNAME: 'developer',
    SAP_PASSWORD: 'secret',
  };

  it('basic auth writes x-sap-login (not x-sap-username) and passes header-validator', () => {
    const { validateAuthHeaders } = jest.requireActual(
      '@mcp-abap-adt/header-validator',
    ) as typeof import('@mcp-abap-adt/header-validator');
    const h: Record<string, string> = { 'x-sap-username': 'stale' };
    tool.applySapConfigToHeaders(h, basic, {});
    expect(h).toEqual({
      'x-sap-url': 'https://abap.example.invalid',
      'x-sap-client': '100',
      'x-sap-auth-type': 'basic',
      'x-sap-login': 'developer',
      'x-sap-password': 'secret',
    });
    const v = validateAuthHeaders(h);
    expect(v.errors).toEqual([]);
    expect(v.config).toMatchObject({
      authType: 'basic',
      username: 'developer',
    });
  });

  it('jwt clears the basic credentials, the legacy name included', () => {
    const h: Record<string, string> = {
      'x-sap-login': 'developer',
      'x-sap-username': 'stale',
      'x-sap-password': 'secret',
    };
    tool.applySapConfigToHeaders(h, jwt, {});
    expect(h['x-sap-login']).toBeUndefined();
    expect(h['x-sap-username']).toBeUndefined();
    expect(h['x-sap-password']).toBeUndefined();
    expect(h['x-sap-jwt-token']).toBe('t');
  });
});

describe('templates point at an endpoint the hub serves', () => {
  // srv/server.ts registers Stream-HTTP only; /mcp/stream/sse is disabled.
  const SERVED = ['/mcp/stream/http', '/mcp/agent/stream/http'];
  const tools = tool as unknown as {
    TEMPLATE_ENDPOINT_SUFFIX: Record<string, string>;
    convertDefinitionToClineConnection: (definition: object) => {
      url?: string;
      type?: string;
    };
  };

  it.each(Object.keys(tool.TEMPLATE_RENDERERS))('%s', (template) => {
    expect(SERVED).toContain(tools.TEMPLATE_ENDPOINT_SUFFIX[template]);
    const raw = yaml.load(tool.TEMPLATE_RENDERERS[template]()) as {
      mcpConnection: { endpoint: string; definition: object };
    };
    expect(SERVED).toContain(
      new URL(raw.mcpConnection.endpoint.replace(/<[^>]+>/, 'host')).pathname,
    );
    const cline = tools.convertDefinitionToClineConnection({
      ...raw.mcpConnection.definition,
      endpoint: raw.mcpConnection.endpoint,
    });
    expect(cline.type).toBe('streamableHttp');
  });
});

describe('switching to a destination drops the direct system type', () => {
  it('removeSapDirectHeaders removes x-sap-system-type with the direct headers', () => {
    const t = tool as unknown as {
      removeSapDirectHeaders: (h: Record<string, string>, u: string[]) => void;
    };
    const h: Record<string, string> = {
      'x-sap-url': 'https://abap.example.invalid',
      'x-sap-system-type': 'cloud',
      'x-sap-login': 'developer',
      Authorization: 'Bearer x',
    };
    const updated: string[] = [];
    t.removeSapDirectHeaders(h, updated);
    expect(h).toEqual({ Authorization: 'Bearer x' });
    expect(updated).toContain('x-sap-system-type');
  });
});

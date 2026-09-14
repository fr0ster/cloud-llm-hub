// `@mcp-abap-adt/lib`'s ONLY exports subpath for this function — see its
// package.json `exports` map (`"./utils"`).
import { return_error } from '@mcp-abap-adt/lib/utils';
import { AxiosError } from 'axios';
import { withOutageTagInResponseData } from '../../srv/connections/CloudSdkAbapConnection';
import { outageFromToolResult } from '../../srv/lib/mcp-outage';
import { classifyProbe } from '../../srv/lib/probe-classifier';

/**
 * Reproduces the ONE line of the connector's tag-writing this file cannot
 * call directly (it lives inline in a private catch block, not exported):
 * `error.message = \`${error.message} ${tag}${hint ? \` ${hint}\` : ''}\`;`.
 * The interesting, previously-broken part — mirroring the tag onto
 * `response.data`, which is what `return_error` actually renders for this
 * shape — uses the REAL exported `withOutageTagInResponseData`, not a
 * reproduction.
 */
function tagAxiosErrorLikeTheConnectorDoes(
  error: AxiosError,
  tag: string,
  hint: string,
): void {
  if (!error.message.includes(tag)) {
    error.message = `${error.message} ${tag}${hint ? ` ${hint}` : ''}`;
  }
  if (error.response && 'data' in error.response) {
    (error.response as { data: unknown }).data = withOutageTagInResponseData(
      error.response.data,
      tag,
    );
  }
}

describe('the connector tag survives return_error — string response body', () => {
  it('outageFromToolResult reads tunnel_timeout back out of the REAL return_error rendering', () => {
    const err = new AxiosError(
      'Request failed with status code 503',
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      {
        status: 503,
        statusText: 'Service Unavailable',
        data: 'Timed out waiting for tunnel to open',
        headers: {},
        config: {} as never,
      },
    );
    const { status, hint } = classifyProbe(
      503,
      String(err.response?.data),
      'OnPremise',
    );
    expect(status).toBe('tunnel_timeout'); // sanity: this IS the tunnel-timeout shape
    tagAxiosErrorLikeTheConnectorDoes(err, `[${status}]`, hint);

    // The REAL `return_error` from `@mcp-abap-adt/lib` — not a stand-in. For
    // this shape (no ENOTFOUND/ECONNREFUSED/ETIMEDOUT in the message, and
    // `response.data` set) it renders `response.data`, NOT `error.message`,
    // which is exactly the path Finding 3's follow-up review found losing
    // the tag.
    const result = return_error(err);

    const outage = outageFromToolResult(result, 'S4HANA_DEV');
    expect(outage).toBeDefined();
    expect(outage?.status).toBe('tunnel_timeout');
    expect(outage?.destination).toBe('S4HANA_DEV');
  });

  it('same for no_scc_registration', () => {
    const err = new AxiosError(
      'Request failed with status code 502',
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      {
        status: 502,
        statusText: 'Bad Gateway',
        data: 'no SAP Cloud Connector (SCC) connected',
        headers: {},
        config: {} as never,
      },
    );
    const { status, hint } = classifyProbe(
      502,
      String(err.response?.data),
      'OnPremise',
    );
    expect(status).toBe('no_scc_registration');
    tagAxiosErrorLikeTheConnectorDoes(err, `[${status}]`, hint);

    const result = return_error(err);
    const outage = outageFromToolResult(result, 'D');
    expect(outage?.status).toBe('no_scc_registration');
  });
});

describe('the connector tag survives return_error — object response body', () => {
  it('outageFromToolResult reads the tag back out of a JSON.stringify-rendered object body', () => {
    // `return_error`'s object branch has no field it reads by name — it
    // `JSON.stringify`s the whole `response.data` object — so there is
    // nothing to append the tag TO. `withOutageTagInResponseData` adds a
    // dedicated top-level key instead, placed first (see its doc comment).
    const err = new AxiosError(
      'Request failed with status code 500',
      'ERR_BAD_RESPONSE',
      undefined,
      undefined,
      {
        status: 500,
        statusText: 'Internal Server Error',
        data: { error: { message: 'Timed out waiting for tunnel to open' } },
        headers: {},
        config: {} as never,
      },
    );
    const rawMessage = JSON.stringify(err.response?.data);
    const { status, hint } = classifyProbe(500, rawMessage, 'OnPremise');
    // httpCode >= 500 alone is enough for `looksTunnelRelated`, and 500 with
    // this body text lands on tunnel_timeout via classifyProbe's own rules —
    // sanity-checked here so the fixture is not accidentally testing nothing.
    expect(status).toBe('tunnel_timeout');
    tagAxiosErrorLikeTheConnectorDoes(err, `[${status}]`, hint);

    const result = return_error(err);
    const outage = outageFromToolResult(result, 'S4HANA_DEV');
    expect(outage).toBeDefined();
    expect(outage?.status).toBe('tunnel_timeout');
  });
});

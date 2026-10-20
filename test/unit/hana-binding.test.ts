import { readHanaBinding } from '../../srv/lib/hana-binding';

const bind = (name: string, host: string) => ({
  name,
  credentials: {
    host,
    port: '30015',
    schema: `S_${name}`,
    user: `U_${name}`,
    password: `P_${name}`,
    hdi_user: 'x',
  },
});
const env = (...b: ReturnType<typeof bind>[]) => ({
  VCAP_SERVICES: JSON.stringify({ hana: b }),
});

describe('readHanaBinding', () => {
  it('picks the binding by name', () => {
    expect(readHanaBinding(env(bind('a', 'h1'), bind('b', 'h2')), 'b')).toEqual(
      {
        host: 'h2',
        port: 30015,
        schema: 'S_b',
        user: 'U_b',
        password: 'P_b',
      },
    );
  });

  it('takes the first binding without a name', () => {
    expect(readHanaBinding(env(bind('a', 'h1'), bind('b', 'h2'))).host).toBe(
      'h1',
    );
  });

  it('names VCAP_SERVICES when it is missing', () => {
    expect(() => readHanaBinding({})).toThrow(/VCAP_SERVICES is not set/);
  });

  it('names the service when it is not bound, without secrets', () => {
    let msg = '';
    try {
      readHanaBinding(env(bind('a', 'h1')), 'zzz');
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain('"zzz"');
    expect(msg).not.toContain('P_a');
  });

  it('errors when there is no hana binding', () => {
    expect(() =>
      readHanaBinding({ VCAP_SERVICES: JSON.stringify({ other: [] }) }),
    ).toThrow(/no "hana" binding/);
  });

  it('names the missing credential field, not its value', () => {
    const b = bind('a', 'h1');
    const { password: _omit, ...rest } = b.credentials;
    expect(() =>
      readHanaBinding(env({ name: 'a', credentials: rest } as typeof b)),
    ).toThrow(/credentials\.password/);
  });
});

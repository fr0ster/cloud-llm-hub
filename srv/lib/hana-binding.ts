/**
 * The runtime credentials of the bound HDI container, read from VCAP_SERVICES.
 * Errors name the variable or the service, never a secret.
 */
export interface HanaBinding {
  host: string;
  port: number;
  schema: string;
  user: string;
  password: string;
}

interface VcapHana {
  name?: string;
  credentials?: Record<string, unknown>;
}

export function readHanaBinding(
  env: Record<string, string | undefined>,
  serviceName?: string,
): HanaBinding {
  const raw = env.VCAP_SERVICES;
  if (!raw)
    throw new Error(
      'VCAP_SERVICES is not set: the hana-vector backend needs a bound HDI container (service label "hana")',
    );
  let list: VcapHana[] | undefined;
  try {
    list = (JSON.parse(raw) as { hana?: VcapHana[] }).hana;
  } catch {
    throw new Error('VCAP_SERVICES is not valid JSON');
  }
  if (!Array.isArray(list) || list.length === 0)
    throw new Error('VCAP_SERVICES has no "hana" binding');
  const binding = serviceName
    ? list.find((b) => b.name === serviceName)
    : list[0];
  if (!binding)
    throw new Error(
      `VCAP_SERVICES has no "hana" binding named "${serviceName}"`,
    );
  const c = binding.credentials ?? {};
  const label = binding.name ?? 'hana';
  const str = (k: string): string => {
    const v = c[k];
    if (typeof v !== 'string' || v === '')
      throw new Error(`The "${label}" binding has no credentials.${k}`);
    return v;
  };
  const port = Number(c.port);
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`The "${label}" binding has no valid credentials.port`);
  return {
    host: str('host'),
    port,
    schema: str('schema'),
    user: str('user'),
    password: str('password'),
  };
}

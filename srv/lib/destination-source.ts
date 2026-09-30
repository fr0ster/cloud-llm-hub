import type { DestinationConfig, EnvDestination } from '../agent-config';
import { btpDestinationSource, type SapDestination } from './btp-destinations';

export interface DestinationSource {
  list(): Promise<SapDestination[]>;
  clearCache(): void;
  /**
   * Why this source cannot serve `name`, or null when it can — or cannot tell
   * without asking the service (BTP). Checked before the Cloud SDK resolves a
   * destination, so a name the source does not hold is refused in the
   * source's own terms instead of the SDK's fallback error.
   */
  refuse(name: string): string | null;
}

/**
 * Destinations from the Cloud SDK's own `destinations` variable. The SDK's
 * getDestination / executeHttpRequest read the same variable, so connections
 * need no change; SAP credentials still come per request from headers.
 */
export class EnvDestinationSource implements DestinationSource {
  constructor(private readonly destinations: EnvDestination[]) {}
  async list(): Promise<SapDestination[]> {
    return this.destinations.map(
      ({ name, url, proxyType, authentication }) => ({
        name,
        url,
        proxyType,
        authentication,
      }),
    );
  }
  clearCache(): void {}
  /**
   * The Cloud SDK looks a name up in `destinations` and, when it is not there,
   * falls back to the BTP Destination service — which a local run does not
   * have, so the caller read "Could not find service binding of type
   * 'destination'" for what was a typo in a name.
   */
  refuse(name: string): string | null {
    if (this.destinations.some((d) => d.name === name)) return null;
    const known = this.destinations.map((d) => d.name).join(', ') || 'none';
    return `destination ${name} is not in the \`destinations\` variable (known: ${known})`;
  }
}

export function createDestinationSource(
  cfg: DestinationConfig,
): DestinationSource {
  return cfg.source === 'env'
    ? new EnvDestinationSource(cfg.destinations)
    : btpDestinationSource();
}

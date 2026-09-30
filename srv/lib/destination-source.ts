import type { DestinationConfig, EnvDestination } from '../agent-config';
import { btpDestinationSource, type SapDestination } from './btp-destinations';

export interface DestinationSource {
  list(): Promise<SapDestination[]>;
  clearCache(): void;
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
}

export function createDestinationSource(
  cfg: DestinationConfig,
): DestinationSource {
  return cfg.source === 'env'
    ? new EnvDestinationSource(cfg.destinations)
    : btpDestinationSource();
}

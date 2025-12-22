export type {
  BtpOnPremConnectionOptions,
  ConnectivityProxyConfig,
} from './BtpOnPremDestinationConnection';
export { BtpOnPremDestinationConnection } from './BtpOnPremDestinationConnection';
export { CloudSdkAbapConnection } from './CloudSdkAbapConnection';
export type { ConnectionOptions } from './connectionFactory';
export {
  createConnection,
  getConnectionTypeName,
  isCloudSdkConnection,
} from './connectionFactory';
export {
  clearConnectivityCaches,
  createBtpOnPremConnection,
  extractConnectivityContext,
  refreshBtpOnPremConnection,
  shouldUseConnectivity,
} from './connectivityProxy';

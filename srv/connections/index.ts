export { CloudSdkAbapConnection } from './CloudSdkAbapConnection';
export type { ConnectionOptions } from './connectionFactory';
export {
  createConnection,
  getConnectionTypeName,
  isCloudSdkConnection,
} from './connectionFactory';
export {
  extractConnectivityContext,
  shouldUseConnectivity,
} from './connectivityProxy';

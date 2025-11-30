export { BtpOnPremDestinationConnection } from './BtpOnPremDestinationConnection';
export type { ConnectivityProxyConfig, BtpOnPremConnectionOptions } from './BtpOnPremDestinationConnection';
export {
	shouldUseConnectivity,
	extractConnectivityContext,
	createBtpOnPremConnection,
	refreshBtpOnPremConnection,
	clearConnectivityCaches
} from './connectivityProxy';
export { CloudSdkAbapConnection } from './CloudSdkAbapConnection';
export {
	createConnection,
	isCloudSdkConnection,
	getConnectionTypeName
} from './connectionFactory';
export type { ConnectionOptions } from './connectionFactory';

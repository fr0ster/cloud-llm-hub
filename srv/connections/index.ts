export { BtpOnPremDestinationConnection } from './BtpOnPremDestinationConnection';
export type { ConnectivityProxyConfig, BtpOnPremConnectionOptions } from './BtpOnPremDestinationConnection';
export {
	shouldUseConnectivity,
	extractConnectivityContext,
	createBtpOnPremConnection,
	refreshBtpOnPremConnection,
	clearConnectivityCaches
} from './connectivityProxy';

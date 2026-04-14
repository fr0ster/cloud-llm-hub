import type {
  AbapRequestOptions,
  OnPremAbapConnection as OnPremAbapConnectionType,
  SapConfig,
} from '@mcp-abap-adt/connection';
import { OnPremAbapConnection as OnPremAbapConnectionImpl } from '@mcp-abap-adt/connection';
import type { IAdtResponse } from '@mcp-abap-adt/interfaces';
import axios, { type AxiosInstance } from 'axios';
// biome-ignore lint/suspicious/noTsIgnore: https-proxy-agent v7 exports not resolved under moduleResolution: node on Node 22
// @ts-ignore
import { HttpsProxyAgent } from 'https-proxy-agent';

// Logger adapter for OnPremAbapConnection
// ILogger doesn't include csrfToken and tlsConfig, so we use loggerAdapter from lib/logger
import { loggerAdapter } from '../lib/logger';

export interface ConnectivityProxyConfig {
  host: string;
  port: number;
  authorizationHeader: string;
  protocol?: 'http' | 'https';
  locationId?: string;
  principalPropagationToken?: string;
}

export interface BtpOnPremConnectionOptions {
  sapConfig: SapConfig;
  proxy: ConnectivityProxyConfig;
  additionalRequestHeaders?: Record<string, string>;
}

export class BtpOnPremDestinationConnection
  extends OnPremAbapConnectionImpl
  implements OnPremAbapConnectionType
{
  private proxySettings: ConnectivityProxyConfig;
  private readonly additionalRequestHeaders: Record<string, string>;

  constructor(options: BtpOnPremConnectionOptions) {
    // BaseAbapConnection constructor: config, logger?, sessionId?
    // For BTP on-premise, we use logger adapter
    super(options.sapConfig, loggerAdapter, 'btp-onprem-session');

    if (options.sapConfig.authType !== 'basic') {
      throw new Error(
        'BTP on-premise destinations require basic authentication credentials.',
      );
    }

    const { protocol = 'http', ...restProxy } = options.proxy;

    this.proxySettings = {
      ...restProxy,
      protocol,
    };

    this.additionalRequestHeaders = { ...options.additionalRequestHeaders };
  }

  updateProxyAuthorization(headerValue: string): void {
    this.proxySettings = {
      ...this.proxySettings,
      authorizationHeader: headerValue,
    };
    this.resetProxyClient();
  }

  updatePrincipalPropagation(token: string | undefined): void {
    this.proxySettings = {
      ...this.proxySettings,
      principalPropagationToken: token,
    };
    this.resetProxyClient();
  }

  getConfig(): SapConfig {
    return super.getConfig();
  }

  reset(): void {
    super.reset();
  }

  async getBaseUrl(): Promise<string> {
    return super.getBaseUrl();
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    const headers = await super.getAuthHeaders();

    headers['Proxy-Authorization'] = this.proxySettings.authorizationHeader;

    if (this.proxySettings.locationId) {
      headers['SAP-Connectivity-SCC-Location_ID'] =
        this.proxySettings.locationId;
    }

    if (this.proxySettings.principalPropagationToken) {
      headers['SAP-Connectivity-Authentication'] =
        this.proxySettings.principalPropagationToken;
    }

    for (const [key, value] of Object.entries(this.additionalRequestHeaders)) {
      headers[key] = value;
    }

    return headers;
  }

  async makeAdtRequest<T = unknown, D = unknown>(
    options: AbapRequestOptions,
  ): Promise<IAdtResponse<T, D>> {
    this.ensureAxiosInstance();
    return super.makeAdtRequest<T, D>(options);
  }

  private ensureAxiosInstance(): void {
    const internalState = this.getMutableState();
    if (!internalState.axiosInstance) {
      const agent = this.buildProxyAgent();

      internalState.axiosInstance = axios.create({
        httpsAgent: agent,
        proxy: false,
      });
    }
  }

  private resetProxyClient(): void {
    const internalState = this.getMutableState();
    internalState.axiosInstance = null;
  }

  private buildProxyAgent(): HttpsProxyAgent<string> {
    const rejectUnauthorized =
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '1' ||
      (process.env.TLS_REJECT_UNAUTHORIZED === '1' &&
        process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0');

    const headers: Record<string, string> = {
      'Proxy-Authorization': this.proxySettings.authorizationHeader,
    };

    if (this.proxySettings.locationId) {
      headers['SAP-Connectivity-SCC-Location_ID'] =
        this.proxySettings.locationId;
    }

    const proxyProtocol = this.proxySettings.protocol ?? 'http';
    const proxyUrl = `${proxyProtocol}://${this.proxySettings.host}:${this.proxySettings.port}`;

    return new HttpsProxyAgent(proxyUrl, {
      headers,
      rejectUnauthorized,
    });
  }

  private getMutableState(): { axiosInstance: AxiosInstance | null } {
    return this as unknown as { axiosInstance: AxiosInstance | null };
  }
}

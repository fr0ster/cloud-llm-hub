declare module 'https-proxy-agent' {
  import type { Agent } from 'http';
  export class HttpsProxyAgent<T = string> extends Agent {
    constructor(proxy: T | URL, opts?: Record<string, unknown>);
  }
}

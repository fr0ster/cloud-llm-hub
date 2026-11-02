import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolTrust } from '@mcp-abap-adt/llm-agent';
import type { TrustResolver } from './trust-resolver';

const clientTools = new AsyncLocalStorage<Set<string>>();

/** Isolate validated client tool ownership across concurrent HTTP requests. */
export function runWithClientTools<T>(run: () => T): T {
  return clientTools.run(new Set(), run);
}

export function registerClientTools(tools: readonly { name: string }[]): void {
  const names = clientTools.getStore();
  names?.clear();
  for (const tool of tools) names?.add(tool.name);
}

export function clientToolTrust(resolver: TrustResolver): ToolTrust {
  return (name) =>
    clientTools.getStore()?.has(name)
      ? { source: `client:${name}`, trust: resolver.classDefault('client') }
      : undefined;
}

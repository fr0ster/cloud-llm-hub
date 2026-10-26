import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import { longSessionsIfReady } from '../long-session';
import type { UsageRuntime } from './runtime';
import { usageRuntime } from './runtime-state';

type ConnectionSource = () => Iterable<IAbapConnection>;
interface Registry {
  identities: Set<object>;
  sources: Set<ConnectionSource>;
}
const registries = new WeakMap<UsageRuntime, Registry>();
function registry(): Registry | undefined {
  const runtime = usageRuntime();
  if (!runtime?.enabled('process')) return undefined;
  let value = registries.get(runtime);
  if (!value) {
    value = {
      identities: new Set<object>(),
      sources: new Set<ConnectionSource>(),
    };
    registries.set(runtime, value);
    const owned = value;
    runtime.onClose((): void => {
      owned.identities.clear();
      owned.sources.clear();
    });
  }
  return value;
}
/** Temporary owners without an existing connection registry. */
export function processConnectionOpened(connection: object): void {
  registry()?.identities.add(connection);
}
export function processConnectionClosed(connection: object): void {
  const runtime = usageRuntime();
  if (!runtime?.enabled('process')) return;
  registries.get(runtime)?.identities.delete(connection);
}
/** Read pool/session identities directly rather than maintaining a second count. */
export function processConnectionSource(source: ConnectionSource): () => void {
  const owned = registry();
  owned?.sources.add(source);
  return (): void => {
    owned?.sources.delete(source);
  };
}
export function processConnectionCount(): number {
  const runtime = usageRuntime();
  if (!runtime?.enabled('process')) return 0;
  const owned = registries.get(runtime);
  if (!owned) return 0;
  const identities = new Set<object>(owned.identities);
  for (const source of owned.sources)
    for (const connection of source()) identities.add(connection);
  for (const connection of longSessionsIfReady()?.connections() ?? [])
    identities.add(connection);
  return identities.size;
}

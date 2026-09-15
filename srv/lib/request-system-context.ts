/**
 * The SAP responsible person and master system, per request.
 *
 * WORKAROUND for fr0ster/mcp-abap-adt#202. `@mcp-abap-adt/lib` 10.0.1 reads
 * `responsible` and `masterSystem` from the process-wide `getSystemContext()`
 * singleton — in `createAdtClient` (dist/lib/clients.js), in `ListTransports`'
 * default user, and in `utils.getSystemInformation()` — so two admitted runs
 * raced on it while the door's capacity was above one. #202 (lib 10.1.0) adds
 * both to `RequestContext` and reads them through `getEffectiveSystemContext()`.
 *
 * Why an export overlay works on 10.0.1: every one of those readers calls
 * `(0, systemContext_1.getSystemContext)()` through the module's exports object
 * at call time (utils imports the module dynamically, then does the same), and
 * that export is a plain writable property. Replacing it with a function that
 * overlays the values of an AsyncLocalStorage scope therefore reaches all of
 * them, and each admitted run sees only its own values. The module is not in
 * lib's `exports` map, so it is required by absolute path next to the public
 * `utils` entry — the same instance lib's own modules hold.
 *
 * Why it would be bypassed on 10.1.0: `getEffectiveSystemContext` calls
 * `getSystemContext` inside its own module, never through the exports object,
 * so an overlay there would be silently ignored. On a lib that exports
 * `getEffectiveSystemContext` this module therefore does not overlay; it
 * delivers through lib's own public `runWithRequestContext`.
 *
 * When cloud-llm-hub depends on lib >= 10.1.0: delete the overlay branch and
 * the absolute-path require, keeping only the `runWithRequestContext` delivery.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, join } from 'node:path';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces';
import { runWithRequestContext } from '@mcp-abap-adt/lib/request-context';
import cds from '@sap/cds';

/** What lib uses for ADT creates and for the default transport user. */
export interface RequestSystem {
  responsible?: string;
  masterSystem?: string;
}

/** What a channel knows about its request once the connection is built. */
export interface RequestSystemInput {
  headers: Record<string, unknown>;
  /** The destination's ProxyType; `OnPremise` (any case) means Cloud Connector. */
  proxyType: string | null | undefined;
  /** The per-request connection a cloud lookup is made over. */
  connection: IAbapConnection;
  destinationName: string;
  /**
   * The identity the connection authenticates as: `DumpScope.principalHash`
   * (CDS user, auth mode, and the SAP identity that actually authenticated —
   * the basic-auth login when that override applied, else the destination's
   * resolved user). `undefined` when the caller has no stable principal.
   */
  callerIdentity: string | undefined;
}

/** The part of adt-clients' `getSystemInformation(connection)` result used here. */
export type SystemInfoLookup = (
  connection: IAbapConnection,
) => Promise<{ systemID?: string; userName?: string } | null>;

/**
 * The production cloud lookup: adt-clients' connection-taking
 * `getSystemInformation`, reached through `@mcp-abap-adt/lib`. OPEN ITEM — the
 * public path to it is being confirmed; point this single place at it. Until
 * then it is `null`: cloud requests take their values from the headers alone,
 * as they did before this module, and the startup log says the fill is off.
 */
export const defaultSystemInfoLookup: SystemInfoLookup | null = null;

export interface LibSystemContextModule {
  getSystemContext?: unknown;
  getEffectiveSystemContext?: unknown;
}

export type RequestSystemDelivery = 'overlay' | 'request-context';

type SystemContext = Record<string, unknown> & { masterLanguage?: string };
type Getter = (() => SystemContext) & { [ORIGINAL]?: () => SystemContext };

const ORIGINAL = Symbol.for('cloud-llm-hub.request-system-context.original');

const scope = new AsyncLocalStorage<RequestSystem>();
let delivery: RequestSystemDelivery | undefined;
let installedModule: LibSystemContextModule | undefined;
let processContext: (() => SystemContext) | undefined;

let systemInfoLookup: SystemInfoLookup | null = defaultSystemInfoLookup;
type SystemInformation = { systemID?: string; userName?: string };
const lookups = new Map<string, SystemInformation>();
const inFlight = new Map<string, Promise<SystemInformation | null>>();
/** Bumped on every reset, so a lookup started before it cannot fill the cache. */
let generation = 0;

const log = () => cds.log('request-system-context');

function installError(reason: string): Error {
  return new Error(
    `Cannot deliver the per-request responsible person and master system into ` +
      `@mcp-abap-adt/lib: ${reason}. This is the workaround for ` +
      'fr0ster/mcp-abap-adt#202 in srv/lib/request-system-context.ts; ' +
      'without it concurrent runs would race on the process singleton.',
  );
}

function libSystemContextPath(): string {
  return join(
    dirname(require.resolve('@mcp-abap-adt/lib/utils')),
    'systemContext.js',
  );
}

/**
 * Choose and install the delivery into lib. Call once at startup; it throws
 * rather than skip, and a second call changes nothing.
 */
export function installRequestSystemContext(
  libModule?: LibSystemContextModule,
): RequestSystemDelivery {
  let mod = libModule;
  if (!mod) {
    try {
      mod = require(libSystemContextPath()) as LibSystemContextModule;
    } catch (err) {
      throw installError(
        `its systemContext module could not be loaded (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  if (delivery && installedModule === mod) return delivery;
  if (installedModule) resetRequestSystemContextForTest();

  if (typeof mod.getSystemContext !== 'function') {
    throw installError('it exports no getSystemContext function');
  }
  const current = mod.getSystemContext as Getter;

  if (typeof mod.getEffectiveSystemContext === 'function') {
    processContext = current;
    installedModule = mod;
    delivery = 'request-context';
  } else {
    const original = current[ORIGINAL];
    if (original) {
      // Already overlaid by an earlier install whose state was reset.
      processContext = original;
    } else {
      const descriptor = Object.getOwnPropertyDescriptor(
        mod,
        'getSystemContext',
      );
      if (!descriptor || !('value' in descriptor) || !descriptor.writable) {
        throw installError('its getSystemContext export is not writable');
      }
      const overlay: Getter = () => {
        const base = current();
        const values = scope.getStore();
        if (!values) return base;
        // Both keys always apply inside a scope: a value this request does not
        // have is `undefined`, never the process value of some other request.
        return {
          ...base,
          responsible: values.responsible,
          masterSystem: values.masterSystem,
        };
      };
      overlay[ORIGINAL] = current;
      mod.getSystemContext = overlay;
      processContext = current;
    }
    installedModule = mod;
    delivery = 'overlay';
  }

  log().info('Per-request responsible person and master system installed', {
    delivery,
    cloudSystemInformationFill: systemInfoLookup ? 'on' : 'not wired',
  });
  return delivery;
}

/**
 * Run `fn` — and everything it awaits — with this request's values visible to
 * lib. Enter it inside the admitted section, right before the run.
 */
export function runWithRequestSystem<T>(
  values: RequestSystem,
  fn: () => Promise<T>,
): Promise<T> {
  const own: RequestSystem = {
    responsible: values.responsible,
    masterSystem: values.masterSystem,
  };
  if (delivery === 'overlay') return scope.run(own, fn);
  if (delivery === 'request-context') {
    // A lib request scope replaces the context lib reads per request, so a
    // scope without `masterLanguage` would drop the process language (lib reads
    // it from the request context whenever one is active). Nothing sets the
    // language per request today, so carry the process value into the scope.
    const ctx = {
      ...own,
      masterLanguage: processContext?.().masterLanguage,
    };
    return runWithRequestContext(ctx, fn);
  }
  return Promise.reject(
    installError('installRequestSystemContext() was not called at startup'),
  );
}

function pick(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const raw = headers[name];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === undefined || first === null) return undefined;
  return String(first).trim() || undefined;
}

/**
 * This request's values. On-premise they are the caller's headers only; on
 * cloud the headers win and a missing value is filled from the system's own
 * information, looked up over the request's connection.
 */
export async function resolveRequestSystem(
  input: RequestSystemInput,
): Promise<RequestSystem> {
  const { headers } = input;
  // SAP user IDs are stored UPPERCASE in the user master; login is
  // case-insensitive but the responsible-person lookup is NOT, so a lowercase
  // proxy login (e.g. "developer") is rejected as an invalid person. Uppercase
  // the derived value — safe for both x-sap-responsible and x-sap-login since
  // both map to an SAP user-ID.
  const fromHeaders: RequestSystem = {
    responsible: (
      pick(headers, 'x-sap-responsible') ?? pick(headers, 'x-sap-login')
    )?.toUpperCase(),
    masterSystem: pick(headers, 'x-sap-master-system')?.toUpperCase(),
  };

  const onPremise = (input.proxyType ?? '').toLowerCase() === 'onpremise';
  if (onPremise) return fromHeaders;
  if (fromHeaders.responsible && fromHeaders.masterSystem) return fromHeaders;

  const info = await systemInformationFor(input);
  return {
    responsible:
      fromHeaders.responsible ??
      (info?.userName?.trim().toUpperCase() || undefined),
    masterSystem:
      fromHeaders.masterSystem ?? (info?.systemID?.trim() || undefined),
  };
}

/**
 * Cached per `[destination, caller identity]` for the life of the process: the
 * system id never changes under a destination, and the user it reports is the
 * one the connection authenticates as, which the principal hash already names.
 * Keying by the principal (not the destination alone) keeps one caller's SAP
 * user from being reported as another's under principal propagation; a caller
 * with no principal is never cached. Concurrent first lookups share one flight.
 * No timeout of its own: the connection's applies.
 */
function systemInformationFor(
  input: RequestSystemInput,
): Promise<SystemInformation | null> {
  const lookup = systemInfoLookup;
  if (!lookup) return Promise.resolve(null);
  if (input.callerIdentity === undefined) return attempt(lookup, input);

  const key = JSON.stringify([input.destinationName, input.callerIdentity]);
  const cached = lookups.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const startedIn = generation;
  const flight = attempt(lookup, input).then((info) => {
    if (inFlight.get(key) === flight) inFlight.delete(key);
    if (info && startedIn === generation) lookups.set(key, info);
    return info;
  });
  inFlight.set(key, flight);
  return flight;
}

/** Never throws; a failed or empty answer is logged and not cached. */
async function attempt(
  lookup: SystemInfoLookup,
  input: RequestSystemInput,
): Promise<SystemInformation | null> {
  try {
    const info = await lookup(input.connection);
    if (info?.userName || info?.systemID) {
      return { userName: info.userName, systemID: info.systemID };
    }
    log().warn('SAP system information returned nothing', {
      destination: input.destinationName,
    });
  } catch (err) {
    log().warn('SAP system information lookup failed', {
      destination: input.destinationName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

/** Inject the cloud lookup (tests, and the production wiring). Clears the cache. */
export function setSystemInfoLookup(lookup: SystemInfoLookup | null): void {
  systemInfoLookup = lookup;
  lookups.clear();
  inFlight.clear();
  generation++;
}

/** Restore lib's original export and forget every install and lookup. */
export function resetRequestSystemContextForTest(): void {
  const current = installedModule?.getSystemContext as Getter | undefined;
  const original = current?.[ORIGINAL];
  if (installedModule && original) installedModule.getSystemContext = original;
  delivery = undefined;
  installedModule = undefined;
  processContext = undefined;
  setSystemInfoLookup(defaultSystemInfoLookup);
}

/**
 * Strict positive-integer reading of an environment variable, shared by the
 * loaders that refuse to start on a malformed value.
 *
 * Unset or blank returns undefined; anything else must be digits and nothing
 * else, at least 1. `Number()` alone reads "0x10" as sixteen, "1e3" as a
 * thousand and " 5" as five: a limit configured by accident is the failure
 * refusing to start exists to prevent.
 */
export function readPositiveIntFrom(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(
      `Invalid ${name}: expected a positive whole number, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

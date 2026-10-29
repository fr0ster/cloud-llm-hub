/** Arrival time owned by the hub, never by client input. */
const arrivals = new WeakMap<object, number>();

export function requestStart(request: object): number {
  let startedAt = arrivals.get(request);
  if (startedAt === undefined) {
    startedAt = Date.now();
    arrivals.set(request, startedAt);
  }
  return startedAt;
}

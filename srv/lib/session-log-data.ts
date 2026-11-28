import type { InterpretContext } from '@mcp-abap-adt/llm-agent';

type LogStep = NonNullable<InterpretContext['sessionLogger']>['logStep'];
type LogStepData = Parameters<LogStep>[1];

/** Remove opaque provider reasoning from log data without editing live messages. */
export function redactProviderOutput(data: LogStepData): LogStepData {
  const visited = new WeakMap<object, object>();

  function redact(value: LogStepData): LogStepData {
    if (typeof value !== 'object' || value === null) return value;
    const previous = visited.get(value);
    if (previous) return previous;

    const copy: object = Array.isArray(value)
      ? []
      : Object.create(Object.getPrototypeOf(value));
    visited.set(value, copy);
    let changed = false;

    for (const key of Reflect.ownKeys(value)) {
      if (key === 'providerOutput') {
        changed = true;
        continue;
      }
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property) continue;
      if ('value' in property) {
        const redacted = redact(property.value);
        changed ||= !Object.is(redacted, property.value);
        property.value = redacted;
      }
      Object.defineProperty(copy, key, property);
    }

    if (changed) return copy;
    visited.set(value, value);
    return value;
  }

  return redact(data);
}

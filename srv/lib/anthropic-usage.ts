import type { ApiSseEvent, TokenUsage } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { responseUsageToWire } from './usage-wire';

export function anthropicUsageToWire(usage: TokenUsage, model: string) {
  const wire = responseUsageToWire(usage, model);
  const cached = wire?.prompt_tokens_details?.cached_tokens;
  const created = wire?.cache_creation_input_tokens;
  const prompt = wire?.prompt_tokens ?? 0;
  const cache = (cached ?? 0) + (created ?? 0);
  return {
    // Anthropic's normalized prompt includes both cache counters. A split
    // count that is smaller than its cache counters is already uncached.
    input_tokens: prompt < cache ? prompt : prompt - cache,
    output_tokens: wire?.completion_tokens ?? 0,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    ...(created !== undefined ? { cache_creation_input_tokens: created } : {}),
    ...(wire?.models ? { models: wire.models } : {}),
    ...(wire?.x_hub ? { x_hub: wire.x_hub } : {}),
  };
}

const jsonObject = z.record(z.string(), z.json());

/** Keep the adapter's stream framing and replace usage with the hub counters. */
export function anthropicEventWithUsage(
  event: ApiSseEvent,
  usage: TokenUsage | undefined,
  model: string,
): ApiSseEvent {
  if (
    !usage ||
    (event.event !== 'message_start' && event.event !== 'message_delta')
  )
    return event;
  const data = jsonObject.parse(JSON.parse(event.data));
  const wire = anthropicUsageToWire(usage, model);
  if (event.event === 'message_delta')
    return { ...event, data: JSON.stringify({ ...data, usage: wire }) };
  const message = jsonObject.parse(data.message);
  return {
    ...event,
    data: JSON.stringify({
      ...data,
      message: { ...message, usage: wire },
    }),
  };
}

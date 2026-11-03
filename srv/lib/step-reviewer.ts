import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { evaluateDeterministic, type ReviewVerdict } from './reviewer-core';
import { stepReviewEnabled } from './step-gate';

/** Deterministic claim notices only; no LLM critic or suspicion gate. */
export async function evaluateGated(input: {
  content: string;
  records: ToolCallRecord[];
  writeToolOffered?: boolean;
}): Promise<ReviewVerdict> {
  if (!stepReviewEnabled(process.env)) return { ok: true };
  return evaluateDeterministic(
    input.content,
    input.records,
    input.writeToolOffered,
  );
}

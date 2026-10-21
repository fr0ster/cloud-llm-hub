import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { parseSapRelevanceScore } from '../agent-config';

export class TokenStats {
  private readonly samples: number[] = [];

  isAnomalous(tokens: number): boolean {
    if (this.samples.length < 20) return false;
    const mean =
      this.samples.reduce((sum, n) => sum + n, 0) / this.samples.length;
    const variance =
      this.samples.reduce((sum, n) => sum + (n - mean) ** 2, 0) /
      this.samples.length;
    return Math.abs(tokens - mean) > 2 * Math.sqrt(variance);
  }

  record(tokens: number): void {
    this.samples.push(tokens);
    if (this.samples.length > 50) this.samples.shift();
  }
}

const models = new Map<string, TokenStats>();
export function tokenStats(model: string): TokenStats {
  let stats = models.get(model);
  if (!stats) {
    stats = new TokenStats();
    models.set(model, stats);
  }
  return stats;
}

export function concernsSap(request: string, topToolScore?: number): boolean {
  return (
    (topToolScore !== undefined &&
      topToolScore >= parseSapRelevanceScore(process.env)) ||
    /\b[ZY][A-Z0-9_/]{2,}\b|\$TMP|\b[A-Z0-9]{3}K9\d{5}\b/.test(request)
  );
}

export function suspicion(input: {
  records: ToolCallRecord[];
  request?: string;
  topToolScore?: number;
  completionTokens?: number;
  model?: string;
}): { suspicious: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (
    input.model &&
    input.completionTokens !== undefined &&
    tokenStats(input.model).isAnomalous(input.completionTokens)
  ) {
    reasons.push('token anomaly');
  }
  if (
    input.records.length === 0 &&
    concernsSap(input.request ?? '', input.topToolScore)
  ) {
    reasons.push('SAP request answered without tools');
  }
  return { suspicious: reasons.length > 0, reasons };
}

import { CLAUDE_RUN_CONFIG as R } from './config.js';

/** What the loop keeps from one headless Claude run: the text it always used, and the cost if reported. */
export interface ClaudeResult {
  text: string;
  costUsd: number | null;
}

/** Reports one finished Claude run: its role, the punch it served, and its cost (null when not reported). */
export type CostSink = (role: string, punchId: string, costUsd: number | null) => void;

function resultObject(parsed: unknown): Record<string, unknown> | null {
  if (Array.isArray(parsed)) {
    const hit = parsed.find((e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === R.resultType);
    return hit ? (hit as Record<string, unknown>) : null;
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

/**
 * Reads `claude --output-format json` stdout. Anything that is not a JSON result (an older claude, a wrapper
 * printing text) is returned unchanged as the text, with no cost.
 */
export function parseClaudeResult(stdout: string): ClaudeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { text: stdout, costUsd: null };
  }
  const obj = resultObject(parsed);
  if (!obj || typeof obj[R.resultKey] !== 'string') return { text: stdout, costUsd: null };
  const cost = obj[R.costKey];
  return { text: obj[R.resultKey] as string, costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null };
}

export const formatCost = (usd: number): string => `$${usd.toFixed(R.costDecimals)}`;

/** The one log line per run. */
export function costLine(role: string, punchId: string, costUsd: number | null): string {
  return `${R.logPrefix} role=${role} punch=${punchId} cost=${costUsd === null ? R.unknownCost : formatCost(costUsd)}`;
}

/** Sums the runs of one tick. */
export class CostTally {
  runs = 0;
  totalUsd = 0;
  add(costUsd: number | null): void {
    this.runs += 1;
    if (costUsd !== null) this.totalUsd += costUsd;
  }
}

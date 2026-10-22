/**
 * GATEWAY LAZY `tools/list` TOKEN METER — MCP-2026 rebuild PHASE 2 (plan §1.2).
 *
 * THE LAUNCH METRIC as an enforceable gate. The whole point of the gateway surface is the
 * context cut: 54 flat tools (~11.6k tokens without outputSchemas, ~21k with) → the 10-tool lazy
 * gateway surface at a configured budget. This test meters the REAL wire payload the ListTools
 * handler serves at surface=gateway + lazy (via the SAME buildAdvertisedTools code path — no
 * reimplementation to drift) with o200k_base (gpt-tokenizer, the launch-baseline tokenizer) and
 * asserts it is ≤ MANDREL_TOOLLIST_TOKEN_BUDGET (default 1100). The actual number is PRINTED —
 * measured proof, not a claim.
 */

import { describe, test, expect } from 'vitest';
import { encode } from 'gpt-tokenizer'; // default encoding = o200k_base (gpt-4o family)

import { buildAdvertisedTools } from '../server/registerMcpHandlers.js';
import { getToolListTokenBudget } from '../config/toolSurfaceConfig.js';

/** Meter a ListTools wire payload with o200k_base. */
function meter(tools: unknown): { tokens: number; bytes: number; count: number } {
  const json = JSON.stringify({ tools });
  return {
    tokens: encode(json).length,
    bytes: Buffer.byteLength(json, 'utf8'),
    count: Array.isArray(tools) ? tools.length : 0,
  };
}

describe('gateway lazy tools/list token meter (o200k_base)', () => {
  test(`lazy gateway surface is ≤ the configured token budget, and PRINTS the number`, () => {
    const budget = getToolListTokenBudget();
    const lazy = buildAdvertisedTools(true, 'gateway', 'lazy');
    const legacy = buildAdvertisedTools(true, 'legacy'); // for the headline reduction number

    const g = meter(lazy);
    const l = meter(legacy);
    const reductionPct = ((l.tokens - g.tokens) / l.tokens) * 100;

    // Emitted via process.stdout.write because vitest.setup.ts mocks console.log to a no-op.
    process.stdout.write(
      `\n[Phase2 token-meter | o200k_base] budget=${budget} | ` +
        `GATEWAY-lazy tools=${g.count} tokens=${g.tokens} bytes=${g.bytes} | ` +
        `LEGACY tools=${l.count} tokens=${l.tokens} bytes=${l.bytes} | ` +
        `reduction-vs-legacy=${reductionPct.toFixed(2)}%\n`,
    );

    expect(g.count).toBe(10);
    expect(g.tokens).toBeLessThanOrEqual(budget);
    // Sanity: it must be a genuine cut, not an empty/broken list.
    expect(g.tokens).toBeGreaterThan(200);
    expect(g.tokens).toBeLessThan(l.tokens);
  });

  test('the token budget is a named config (default 1550), not a scattered literal', () => {
    // Default RAISED 1100→1400 (Phase 3): the lazy+core required-param lifting is a
    // measured, intentional trade (see toolSurfaceConfig getToolListTokenBudget doc) — not creep.
    // Then 1400→1450 (P3): `graph` gained branch_assign / branch_unassign, whose
    // names ride the lazy envelope's action enum for a MEASURED +7 tokens (1400 → 1407). The old
    // ceiling sat exactly ON the measured surface, so it had no headroom left to distinguish
    // creep from change; the new one has ~43 tokens of it. The full measurement, on both refs
    // and with the instrument named, is in getToolListTokenBudget's docblock.
    // Then 1450→1550 (reproject): `project` gained the `move` action
    // and lazy+core lifted its three un-guessable required params, MEASURED 1425→1494 across
    // four progressively-removed steps (+7 description, +2 action name, +60 the lift). The
    // breakdown, and why the +60 has nothing in it to trim, is in that same docblock.
    delete process.env.MANDREL_TOOLLIST_TOKEN_BUDGET;
    expect(getToolListTokenBudget()).toBe(1550);
    process.env.MANDREL_TOOLLIST_TOKEN_BUDGET = '900';
    expect(getToolListTokenBudget()).toBe(900);
    process.env.MANDREL_TOOLLIST_TOKEN_BUDGET = 'garbage';
    expect(getToolListTokenBudget()).toBe(1550); // bad value → default (fail-safe)
    delete process.env.MANDREL_TOOLLIST_TOKEN_BUDGET;
  });
});

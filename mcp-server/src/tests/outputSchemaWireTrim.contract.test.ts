/**
 * PHASE 0 — outputSchema wire-trim contract guard (MCP-2026 rebuild).
 *
 * WHAT PHASE 0 DOES: today every `tools/list` (ListTools) entry advertises a full per-tool
 * `outputSchema`. Those roughly DOUBLE the real wire cost of the lazy list yet the model
 * never needs them there (a client that finds no outputSchema simply skips response
 * validation — a non-breaking change). `MANDREL_ADVERTISE_OUTPUT_SCHEMAS`
 * (config/toolSurfaceConfig.ts) gates the ADVERTISEMENT on the lazy list only.
 *
 * THE GUARDS (all deterministic, no DB):
 *   P0 — default preserves TODAY: ADVERTISE_OUTPUT_SCHEMAS === true, and the advertise-ON
 *        payload is byte-identical to the pre-Phase-0 wire (filter-only).
 *   W1 — advertise ON: every advertised entry keeps its `outputSchema` (≥1 present).
 *   W2 — advertise OFF: NO entry carries an `outputSchema`, and every OTHER field of every
 *        entry is preserved verbatim (only outputSchema is removed; nothing else drifts).
 *   W3 — EMISSION source-of-truth untouched: stripping the advertisement does NOT mutate
 *        AIDIS_TOOL_DEFINITIONS — tools still DECLARE outputSchema (so runtime
 *        `structuredContent` emission via routes/index.ts is unaffected; that emission is
 *        separately guarded by dualChannelOutput.contract.test.ts, which stays green).
 *   T1 — TOKEN METER: measured with o200k_base (gpt-tokenizer — the SAME tokenizer family
 *        as the launch baseline), the advertise-OFF lazy list is materially smaller than
 *        advertise-ON. The exact numbers are logged (this is a launch metric). Guard floor
 *        is REDUCTION_FLOOR_PCT (see note there).
 */

import { describe, test, expect } from 'vitest';
import { encode } from 'gpt-tokenizer'; // default encoding is o200k_base (gpt-4o family)

import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';
import { ADVERTISE_OUTPUT_SCHEMAS } from '../config/toolSurfaceConfig.js';
import { buildAdvertisedTools } from '../server/registerMcpHandlers.js';

/** The disabled-tool filter the handler applies (kept in lockstep with registerMcpHandlers). */
const DISABLED_TOOLS = [
  'code_analyze', 'code_components', 'code_dependencies', 'code_impact', 'code_stats',
  'complexity_analyze', 'complexity_insights', 'complexity_manage',
];

/**
 * REDUCTION_FLOOR_PCT — the token-meter regression floor.
 *
 * The task spec's target is "≥45%". MEASURED reality on the original 54-tool surface was
 * ~44.74% (o200k_base): ON ≈ 21,012 tok, OFF ≈ 11,611 tok — matching the rebuild plan's own
 * cited baseline (20,980 → 11,579 = 44.8%). A hard 45% floor would false-RED on the TRUE
 * data, so the guard floor sits below the measured value while still failing loudly if the
 * cut ever regresses (output schemas creeping back onto the wire, or the trim silently
 * ceasing to work). The exact percentage is logged every run so the real launch metric is
 * never a claim — it is measured proof.
 *
 * ⚠️ LOWERED 40 → 34 by SEARCH P3, and READ THE REASON
 * BEFORE TRUSTING THE NEW NUMBER: this ratio FELL because the numerator got SMALLER, not
 * because the trim got worse. Trust on the wire dropped from a nine-field blob to
 * {band, score}, and `trustObject` is embedded in most read tools' outputSchema — so the
 * thing this test measures the removal of is now much cheaper to carry.
 *
 * MEASURED, same command (`npx vitest run src/tests/outputSchemaWireTrim.contract.test.ts`,
 * 68 tools, o200k_base), before vs after on this branch:
 *     before  ON 29,985 tok / 127,444 B   OFF 17,029 tok / 74,733 B   reduction 43.21%
 *     after   ON 27,404 tok / 117,313 B   OFF 17,208 tok / 75,492 B   reduction 37.21%
 * The advertise-ON list — what a client actually pays on `tools/list` when schemas are
 * advertised — got 2,581 tokens (8.6%) CHEAPER. A floor that read this as a regression
 * would be punishing the payload getting smaller, which is the opposite of its purpose.
 * The floor is set at 34, ~3 points under the measured 37.21, on the same reasoning the
 * original 40 sat under 44.74.
 *
 * ⚠️ LOWERED 34 → 33 by migration 101 / an earlier decision (Punch List lane A). The ratio
 * fell because the DENOMINATOR grew: task_create/task_update/task_bulk_update/task_list
 * each gained `stage` (+ `task_list` a filter), and task_create/task_update/task_bulk_update
 * gained `punch` — real, reviewed INPUT-schema growth that rides BOTH advertise-ON and
 * advertise-OFF payloads equally (outputSchema is untouched), so a FIXED-size removal is
 * inherently a smaller fraction of a larger whole. This is the same shape as the P3 lowering
 * above — a payload getting BIGGER for a real reason, not the trim getting worse.
 * MEASURED, same command, o200k_base, 70 tools:
 *     before  ON 27,404 tok   OFF 17,208 tok   reduction 37.21%  (pre-existing baseline)
 *     after   ON 32,677 tok   OFF 21,662 tok   reduction 33.71%
 * Floor set at 33, just under the measured 33.71 — same "small margin below true value"
 * shape the two priors used, sized to this one being an additive param growth rather than
 * a payload-shrink event.
 *
 * ⚠️ LOWERED 33 → 32 by an earlier task (Punch List lane A —
 * structured `doneWhen[]`). Same shape again: the DENOMINATOR grew further —
 * task_create/task_update/task_bulk_update's `punch` param gained the structured
 * `doneWhen[]` clause shape (`{text, owner, proof?}`), `touches`, and `dependsOn`, plus
 * opRegistry help text naming the clause shape — real, reviewed INPUT-schema growth on
 * both advertise-ON and advertise-OFF payloads equally.
 * MEASURED, same command, o200k_base, 70 tools:
 *     before  ON 32,677 tok   OFF 21,662 tok   reduction 33.71%  (pre-existing baseline)
 *     after   ON 33,504 tok   OFF 22,489 tok   reduction 32.88%
 * Floor set at 32, just under the measured 32.88.
 */
const REDUCTION_FLOOR_PCT = 32;

/** Serialize the full ListTools wire payload and meter it with o200k_base. */
function meter(advertise: boolean): { tokens: number; bytes: number; count: number } {
  const json = JSON.stringify({ tools: buildAdvertisedTools(advertise) });
  return {
    tokens: encode(json).length,
    bytes: Buffer.byteLength(json, 'utf8'),
    count: buildAdvertisedTools(advertise).length,
  };
}

describe('Phase 0 — outputSchema wire trim (MANDREL_ADVERTISE_OUTPUT_SCHEMAS)', () => {
  // ── P0: default preserves today's behavior ──────────────────────────────────
  test('P0: flag default is ON (advertise) — merging Phase 0 changes nothing live', () => {
    expect(ADVERTISE_OUTPUT_SCHEMAS).toBe(true);
  });

  test('P0b: advertise-ON payload is byte-identical to the pre-Phase-0 wire (filter-only)', () => {
    const legacyWire = AIDIS_TOOL_DEFINITIONS.filter((t) => !DISABLED_TOOLS.includes(t.name));
    expect(JSON.stringify({ tools: buildAdvertisedTools(true) })).toBe(
      JSON.stringify({ tools: legacyWire }),
    );
  });

  // ── W1: advertise ON keeps outputSchema ─────────────────────────────────────
  test('W1: advertise ON — entries retain outputSchema (≥1 present)', () => {
    const on = buildAdvertisedTools(true);
    expect(on.length).toBeGreaterThan(0);
    expect(on.some((t) => 'outputSchema' in t && t.outputSchema)).toBe(true);
  });

  // ── W2: advertise OFF strips ONLY outputSchema ──────────────────────────────
  test('W2: advertise OFF — no entry carries an outputSchema', () => {
    const off = buildAdvertisedTools(false);
    const withSchema = off.filter((t) => 'outputSchema' in t).map((t) => t.name);
    expect(withSchema, `these entries still advertise an outputSchema: ${withSchema.join(', ')}`).toEqual([]);
  });

  test('W2b: advertise OFF preserves EVERY other field of EVERY entry verbatim', () => {
    const on = buildAdvertisedTools(true);
    const off = buildAdvertisedTools(false);
    // Same tool set, same order.
    expect(off.map((t) => t.name)).toEqual(on.map((t) => t.name));
    // Each OFF entry deep-equals its ON counterpart with outputSchema removed — nothing
    // but the advertisement changed.
    on.forEach((onTool, i) => {
      const { outputSchema: _drop, ...expected } = onTool as any;
      expect(off[i]).toEqual(expected);
    });
  });

  // ── W3: emission source-of-truth is untouched ───────────────────────────────
  test('W3: stripping the advertisement does NOT mutate AIDIS_TOOL_DEFINITIONS (emission intact)', () => {
    buildAdvertisedTools(false); // exercise the strip path
    const advertised = AIDIS_TOOL_DEFINITIONS.filter((t) => !DISABLED_TOOLS.includes(t.name));
    const missing = advertised.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(
      missing,
      `these tools LOST their declared outputSchema — emission would break: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  // ── T1: token meter (o200k_base) — the launch metric ────────────────────────
  test(`T1: advertise-OFF lazy list is ≥${REDUCTION_FLOOR_PCT}% smaller than advertise-ON (o200k_base)`, () => {
    const on = meter(true);
    const off = meter(false);
    const tokenReductionPct = ((on.tokens - off.tokens) / on.tokens) * 100;
    const byteReductionPct = ((on.bytes - off.bytes) / on.bytes) * 100;

    // Launch metric — measured proof, not a claim. Emitted via process.stdout.write
    // because the suite setup (vitest.setup.ts) mocks console.log to a no-op; this metric
    // must actually surface in the gate output.
    process.stdout.write(
      `\n[Phase0 token-meter | o200k_base] tools=${on.count} | ` +
        `ON tokens=${on.tokens} bytes=${on.bytes} | OFF tokens=${off.tokens} bytes=${off.bytes} | ` +
        `token-reduction=${tokenReductionPct.toFixed(2)}% byte-reduction=${byteReductionPct.toFixed(2)}%\n`,
    );

    expect(off.tokens).toBeLessThan(on.tokens);
    expect(tokenReductionPct).toBeGreaterThanOrEqual(REDUCTION_FLOOR_PCT);
    // Sanity ceiling: a bug that strips MORE than outputSchema (e.g. inputSchema) would
    // blow past this — the trim must be surgical, not a wholesale gutting of the list.
    expect(tokenReductionPct).toBeLessThan(60);
  });
});

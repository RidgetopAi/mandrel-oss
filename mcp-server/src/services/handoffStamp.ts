/**
 * THE HANDOFF STALENESS STAMP (finding bf1980d5).
 *
 * ═══ THE DEFECT, MEASURED ═══════════════════════════════════════════════════════════════
 * The boot package prints two things about the same work: (1) the latest handoff as FULL
 * frozen prose, and (2) a live recall walk of the database. NOTHING marks which one is
 * current. Two independent blind readers — no transcript, no Mandrel access, no contact with
 * each other — both hit this unprompted on the 2026-08-21 P6 package: the handoff said
 * "Three remain: P3b, P4, P6" and routed the reader to BUILD `1e474867` and `2dbf3073`,
 * while the walk on the same page carried a builder run report AND a reviewer verdict for
 * both. Reader B, verbatim: "Acting on the handoff's list could mean rebuilding finished
 * work."
 *
 * It is STRUCTURAL, not a bad handoff. Every handoff goes stale the moment the next task
 * closes, so the more work a session completes the more wrong its own handoff becomes — and
 * the handoff is the part written in the imperative, so it is the part that gets obeyed.
 *
 * ═══ ★ THE STORED RECORD IS NEVER MODIFIED ══════════════════════════════════════════════
 * This is a RENDER-TIME OVERLAY. The handoff row is the archive of what was true when it was
 * written; rewriting it to today's truth would destroy the only record of the author's state
 * of knowledge, and would be the `task_update` description-clobber defect (39abb203) wearing
 * a new hat. NOTHING in this file issues an UPDATE, and the contract test asserts the stored
 * `contexts` row is byte-identical across a render. If a future change here needs to write,
 * it is the wrong change.
 *
 * ═══ THE SHAPE OF THE FIX ═══════════════════════════════════════════════════════════════
 * Two halves, deliberately split at the sync/async seam the renderer already has:
 *   resolveHandoffStamps()  — ASYNC, runs in gatherBriefingData. Scans the handoff text for
 *                             id-shaped tokens (utils/namedIdScan.ts — the SAME scanner the
 *                             trunk-demotion rule uses) and resolves each against `tasks`.
 *   applyHandoffStamps()    — PURE, runs in renderBriefing. Rewrites each occurrence in
 *                             place. No clock, no pool, no env — so a test can pin it.
 * The renderer stays a pure function of (data, config, now), which is the property that makes
 * every existing briefing test possible; a DB read inside it would have cost that.
 *
 * ═══ UNIFORM, NOT CLEVER (constraint 2) ═════════════════════════════════════════════════
 * EVERY resolvable task id is stamped with its current status — including `todo`, including
 * ids whose status never moved. A stamp that appeared only when something CHANGED would make
 * the reader infer meaning from ABSENCE, and absence-means-something is precisely the
 * collision the capture vocabulary exists to avoid: an unstamped id would be
 * indistinguishable from an id the resolver could not resolve. Uniform is cheap (see the
 * measured char cost in the run report) and unambiguous.
 *
 * ═══ THE THREE AMBIGUOUS CASES (constraint 3), DECIDED AND WHY ══════════════════════════
 * A false `[now: completed]` on the wrong task is far worse than no stamp, so every case
 * that cannot name ONE task in THIS project resolves to NO STAMP:
 *
 *   (a) AN id8 MATCHING MORE THAN ONE TASK — no stamp. A warning naming the token is
 *       returned to the CALLER, and the briefing (this function's only product caller)
 *       deliberately discards it: no-stamp is already the safe outcome, and the briefing has
 *       no warning channel to render it into. Do not go hunting for that warning in a boot
 *       package — it is not there. Give `warnings` a consumer before relying on it.
 *       Inherited, not re-decided: `resolveMintEndpoint` throws AmbiguousIdError and NEVER
 *       first-matches. Picking one would print a confident status for a
 *       task the writer may never have meant.
 *   (b) A DELETED TASK — STAMPED, as `[now: deleted]` (label in briefingConfig.ts). This is
 *       the one case that is stamped rather than skipped, because deletion is a FACT the row
 *       carries in a field (`archived_at IS NOT NULL`), and it is the single most useful
 *       thing a reader can be told about an id in a to-do list: the work item it names is
 *       gone. Rendering it as "unresolvable" would hide a fact we hold.
 *   (c) A HEX-LOOKING STRING THAT IS NOT AN ID — no stamp, silently. Prose is full of 8-hex
 *       words (commit prefixes, hashes, hex constants); resolution against `tasks` is the
 *       gate, exactly as it is on the mint path. No warning: this is the COMMON case, not an
 *       anomaly, and warning on it would bury (a).
 *
 * A fourth, inherited for free: an id naming a task in ANOTHER project resolves to nothing
 * here, because resolution is project-scoped. No stamp.
 *
 * NO STAMP IS NOT A SILENT "RESOLVED" (constraint 3's real requirement): the stamp is the
 * ONLY thing this feature adds, so its absence asserts nothing at all — an unstamped id reads
 * exactly as it read before this feature existed. The failure mode being guarded against is a
 * WRONG stamp, and there is no path here that emits one for an unresolved token.
 *
 * ═══ SCOPE: TASKS ONLY (constraint 4) ═══════════════════════════════════════════════════
 * Decisions and contexts are deliberately out of scope this round. "Rebuild finished work" is
 * a task-shaped failure; a decision has no status that goes stale the same way.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import {
  scanNamedIdTokens,
  namedIdCombinedRe,
  MAX_NAMED_ID_CANDIDATES,
} from '../utils/namedIdScan.js';
import { AmbiguousIdError, IdNotFoundError, resolveMintEndpoint } from '../utils/idResolver.js';

import { HANDOFF_STAMP_STATUS_PLACEHOLDER } from '../config/briefingConfig.js';

/**
 * The render-time overlay for ONE handoff: token (lower-cased, exactly as it appears in the
 * text) -> the STATUS WORD to stamp it with. Never the rendered stamp string: the format is a
 * render concern and lives in config, so the gather stage stores only the fact it measured.
 *
 * A token that resolved to nothing is ABSENT from the map rather than present-with-null —
 * "no stamp" and "a stamp whose value is nothing" must not be representable as the same
 * thing (C1's third state: could-not-resolve gets no key, not an empty one).
 */
export type HandoffStamps = Readonly<Record<string, string>>;

/** An empty overlay — what a flag-off render, or a handoff naming no ids, carries. */
export const NO_HANDOFF_STAMPS: HandoffStamps = Object.freeze({});

export interface HandoffStampResolution {
  stamps: HandoffStamps;
  /** Ambiguity + failure surfacing, never thrown (a briefing must not fail on a stamp). */
  warnings: string[];
}

/**
 * Resolve every task id named in `text` to its CURRENT status. Async; DB-reading; called
 * from gatherBriefingData.
 *
 * NEVER THROWS. This runs on the boot path of every briefing; a resolver hiccup must cost
 * the reader a stamp, not the whole handoff. Failures land in `warnings`.
 *
 * BOUNDED by MAX_NAMED_ID_CANDIDATES — the SAME bound the mint path uses, imported rather
 * than re-chosen, so a body that is pathologically id-dense cannot turn one briefing into
 * hundreds of resolver queries on either path.
 */
export async function resolveHandoffStamps(
  text: string,
  projectId: string,
  deletedLabel: string,
  pool: Pool = db,
): Promise<HandoffStampResolution> {
  const stamps: Record<string, string> = {};
  const warnings: string[] = [];
  const tokens = scanNamedIdTokens(text);

  let resolved = 0;
  for (const token of tokens) {
    if (resolved >= MAX_NAMED_ID_CANDIDATES) {
      warnings.push(
        `handoff stamp scan stopped at ${MAX_NAMED_ID_CANDIDATES} candidates (handoff unusually id-dense)`,
      );
      break;
    }
    resolved++;
    try {
      // resolveMintEndpoint, not a bespoke query: it is the ONE definition of "this id names
      // exactly one task in this project", including the never-first-match refusal. A second
      // resolution rule here could stamp a task the mint path would refuse to link.
      const id = await resolveMintEndpoint('task', token, projectId, pool);
      // The status read is a SEPARATE, id-keyed lookup rather than something folded into the
      // resolver, because `archived_at` is not the resolver's business — it resolves ids, it
      // does not decide what a caller considers live. Case (b) is decided HERE, in the file
      // that documents it.
      const row = (
        await pool.query(
          `SELECT status, archived_at FROM tasks WHERE id = $1`,
          [id],
        )
      ).rows[0];
      if (!row) continue; // Resolved then vanished (a delete racing the render): no stamp.
      stamps[token] = row.archived_at === null ? String(row.status) : deletedLabel;
    } catch (e) {
      if (e instanceof AmbiguousIdError) {
        warnings.push(
          `handoff id '${token}' is AMBIGUOUS (${e.candidates.length} tasks match) — not stamped (never first-match)`,
        );
      } else if (!(e instanceof IdNotFoundError)) {
        warnings.push(`handoff stamp resolution failed for '${token}': ${(e as Error).message}`);
      }
      // IdNotFoundError -> case (c): ordinary prose hex, or another project's id. Silent.
    }
  }
  return { stamps, warnings };
}

/**
 * Apply the overlay to the handoff text. PURE — same inputs, same output, no clock, no pool.
 *
 * DRIVEN BY THE SAME REGEX THE SCAN USED (utils/namedIdScan.ts), not by a per-token
 * search-and-replace. A `String.replace` per token would have to re-derive the word-boundary
 * rules that decide, e.g., that the leading octet of a full uuid is not an id8 — and a
 * rewrite whose boundaries disagree with the scan's is how a token gets stamped in the middle
 * of a longer hex run. One pattern, one pass, both directions.
 *
 * An id NOT in `stamps` is returned untouched, which is what makes the three unresolvable
 * cases inert rather than merely quiet.
 */
export function applyHandoffStamps(
  text: string,
  stamps: HandoffStamps,
  format: string,
): string {
  if (Object.keys(stamps).length === 0) return text;
  return (text ?? '').replace(namedIdCombinedRe(), (match) => {
    const status = stamps[match.toLowerCase()];
    if (status === undefined) return match;
    return match + format.replace(HANDOFF_STAMP_STATUS_PLACEHOLDER, status);
  });
}

/**
 * The char cost this overlay ADDS to a given text — measured, not estimated.
 *
 * EXPORTED because the handoff is EXEMPT from the briefing's size cap (projectBriefing.ts),
 * so these chars land in the one section the cap cannot trim. A number that can only be
 * obtained by eyeballing two renders is a number nobody checks; this makes it assertable.
 */
export function handoffStampCharCost(text: string, stamps: HandoffStamps, format: string): number {
  return applyHandoffStamps(text, stamps, format).length - (text ?? '').length;
}

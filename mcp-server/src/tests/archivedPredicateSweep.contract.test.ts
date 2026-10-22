/**
 * ARCHIVED-PREDICATE SOURCE SWEEP (Reviewer F1 — the deeper half)
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * `statsSearchCountReconcile.contract.test.ts` derives its population from
 * `OpRegistryEntry.reportsCount`. That is a DECLARATION, and a declaration has an obvious
 * hole: nothing forces a new count-reporting op to set it. Ask "what happens if someone adds
 * a count tool and does not flag it?" and the honest answer over there is "nothing catches
 * it" — which is a smaller version of the very failure that guard was rewritten for (its
 * population used to be a NAME REGEX, and an Reviewer proved `session_record_counts` sailed
 * through it while the real session tools counted archived rows on prod).
 *
 * So this file guards the same rule from the other end, where no declaration is involved:
 * THE SQL ITSELF. Every aggregate over a soft-deletable table must either carry an archived
 * predicate, or carry a co-located marker saying why it does not. A new count tool written
 * by someone who never heard of `reportsCount` still has to write a query, and the query is
 * what this reads.
 *
 * ── THE CHOKE POINT ────────────────────────────────────────────────────────────────────
 * Not "tools named *_stats", not "ops that declare a flag": every SQL string in the product
 * source that runs an aggregate (COUNT / SUM / AVG) against a table that HAS an `archived_at`
 * column. That is the narrowest thing every instance of this defect must pass through.
 *
 * ── THE POPULATION, AND WHAT IT IS NOT ─────────────────────────────────────────────────
 * ENUMERATES: `mcp-server/src/**\/*.ts`, excluding `src/tests/`. The soft-deletable table
 * list is READ FROM information_schema at test time (not hardcoded), so a fourth table
 * gaining `archived_at` widens this sweep automatically.
 *
 * DOES NOT ENUMERATE, stated so nobody over-trusts it:
 *   1. Other packages. `mandrel-command/backend` and the `v_session_summaries` view are NOT
 *      scanned here (a vitest suite in mcp-server cannot see them). Their copies of the
 *      session-count rule are guarded by sessionCountRule.contract.test.ts + its backend twin.
 *   2. SQL that is not a string literal in these files — anything assembled from fragments
 *      too far apart to see, or generated at runtime.
 *   3. Correctness. It proves a predicate is PRESENT, not that it is right. Whether the
 *      numbers actually reconcile is statsSearchCountReconcile's job. The two are deliberately
 *      different instruments: one reads declarations and behaviour, this one reads source.
 *
 * ── EXEMPTIONS ARE CO-LOCATED, NEVER CENTRAL ───────────────────────────────────────────
 * A query that legitimately must not filter carries `SOFT-DELETE-EXEMPT: <reason>` in a
 * comment within EXEMPTION_WINDOW lines above it. A central allow-list in this file would
 * rot the moment code moves; a marker travels with the query and has to be re-justified by
 * whoever moves it. An empty reason is rejected — the marker is the reason, not
 * a mute switch.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { db } from '../config/database.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** How many lines above a query a SOFT-DELETE-EXEMPT marker may sit and still apply. */
const EXEMPTION_WINDOW = 14;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'tests' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Blank out comments so PROSE cannot be mistaken for code. A doc comment in context.ts
 * quotes `SELECT count(*) … FROM contexts` as evidence in an explanation; flagging it would
 * train the next person to delete the comment to appease the gate. Replaces comment bodies
 * with spaces so every byte offset (and therefore every line number) is preserved.
 */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * THE SWEEP USED TO FAIL OPEN, AND IT PRODUCED A FALSE GREEN (round 3 finding).
 *
 * The extractor skipped any candidate whose `FROM <soft-deletable table>` it could not see
 * literally. That is fine when the FROM names a table we can read — we know it is out of
 * scope. It is NOT fine when the FROM TARGET IS HIDDEN behind an interpolation, because then
 * the sweep cannot tell whether the query is in scope, and it silently chose "not in scope".
 *
 * Measured cost: `countRepairable` in services/graphBackfill.ts was FLAGGED by this sweep in
 * round 1. In round 2 it became unflagged — not because it was fixed, but because a refactor
 * moved its `FROM contexts` into a shared template fragment. A guard went RED -> SILENT,
 * which is indistinguishable from RED -> GREEN when you are reading a gate result. The
 * soft-delete defect fixed alongside this (the repair leg ignoring `archived_at`) is exactly
 * the kind of thing that hid in that blind spot.
 *
 * SO: A HIDDEN FROM TARGET IS NOW A FINDING, not a silent exclusion. It can be resolved in
 * one of two honest ways, and neither is a mute switch:
 *
 *   SOFT-DELETE-VIA: <identifier> — <reason>
 *     The predicate IS present, assembled in <identifier> rather than inline. Verified, not
 *     trusted: <identifier> must actually appear in this file, and this file must contain an
 *     `archived_at` predicate. Use when the query is FILTERED but not visibly so.
 *
 *   SOFT-DELETE-EXEMPT: <reason>
 *     The query legitimately must count archived rows. Use when the query is genuinely NOT
 *     filtered and should not be.
 *
 * The distinction matters and is the whole reason there are two markers: writing "EXEMPT" on
 * a query that is actually filtered puts a FALSE STATEMENT in the source to buy a green gate,
 * which is worse than the red it buys.
 *
 * ── WHAT THIS CHECK MATCHES (limits, stated) ────────────────────────────────────────────
 * It matches a template literal containing an aggregate whose FROM target is interpolated or
 * absent. The SOFT-DELETE-VIA verification proves that the named identifier is present in the
 * file and that the file carries an archived_at predicate somewhere — it does NOT perform
 * dataflow analysis and does not prove that THAT identifier's value is what carries the
 * predicate. It is a co-location check with teeth, not a proof. Deliberately: a full
 * cross-function SQL dataflow analyser is a second product, and the honest place to settle
 * this class is at the executed-SQL boundary rather than in a source scanner (filed
 * separately; explicitly out of scope for this round).
 */
const HIDDEN_FROM = /\bfrom\s*\(?\s*\$\{/i;
const HAS_INTERPOLATION = /\$\{/;

/**
 * Resolve a `SOFT-DELETE-VIA: <identifier> — <reason>` marker found in `window` (RAW source,
 * because the marker lives in a comment) against `code` (COMMENT-BLANKED source, because the
 * claim is about code). Returns null when there is no marker, `{ok:true}` when the claim
 * verifies, `{ok:false, why}` when it does not.
 *
 * THE TWO ARGUMENTS ARE DIFFERENT ON PURPOSE, and getting this wrong made the guard hollow.
 * The first version verified the identifier against the RAW file — but the marker comment
 * ITSELF contains the identifier, so every marker proved its own claim and the check passed
 * for any string whatsoever. A mutation probe naming `NoSuchIdentifierAnywhere` stayed GREEN.
 * That is C1's "an instrument can be inside its own sample": the evidence was the assertion.
 * Verifying against blanked code removes the marker's own text from the sample, so the
 * identifier must appear in real code and `archived_at` must appear in a real predicate.
 *
 * Used on BOTH arms of the sweep — the hidden-FROM arm and the visible-FROM arm — because
 * "the predicate is assembled elsewhere" is equally true of a query whose table you CAN read
 * (`FROM contexts c WHERE ${ORPHAN_PREDICATE_SQL}`) and one whose table you cannot. Wiring it
 * to only one arm would have forced the other to lie with an EXEMPT marker.
 */
function resolveVia(window: string, code: string): { ok: boolean; why?: string } | null {
  const via = window.match(/SOFT-DELETE-VIA:\s*([A-Za-z_$][\w$]*)\s*[—:-]\s*(.+)/);
  if (!via) return null;
  const ident = via[1];
  const reason = via[2].trim();
  if (!new RegExp(`\\b${ident}\\b`).test(code)) {
    return { ok: false, why: `SOFT-DELETE-VIA names "${ident}" but no such identifier appears in this file` };
  }
  if (!/archived_at/i.test(code)) {
    return { ok: false, why: `SOFT-DELETE-VIA names "${ident}" but this file contains no archived_at predicate at all` };
  }
  if (reason.length < 20) {
    return { ok: false, why: `SOFT-DELETE-VIA names "${ident}" but its reason is too short to be a reason` };
  }
  return { ok: true };
}

type Site = { file: string; line: number; sql: string; reason: string };

function findUnguardedSites(tables: string[]): { sites: Site[]; scanned: number; guarded: number; exempt: number } {
  const tableAlt = tables.join('|');
  const fromJoin = new RegExp(`\\b(?:from|join)\\s+(?:${tableAlt})\\b`, 'i');
  const agg = /\b(?:count|sum|avg)\s*\(/i;
  const sites: Site[] = [];
  let scanned = 0;
  let guarded = 0;
  let exempt = 0;

  for (const file of sourceFiles(SRC)) {
    const raw = readFileSync(file, 'utf8');
    const src = blankComments(raw);
    const rawLines = raw.split('\n');

    // Template literals AND single-quoted strings — both are used for SQL in this tree.
    const candidates = [...src.matchAll(/`([^`]*)`/g), ...src.matchAll(/'([^'\n]{30,})'/g)];

    for (const m of candidates) {
      const sql = m[1];
      if (!agg.test(sql)) continue;

      const inScopeLiterally = /\bfrom\b/i.test(sql) && fromJoin.test(sql);

      // FAIL-CLOSED ARM: an aggregate whose FROM target we cannot read. Previously this fell
      // through the `continue` below and vanished. See the block comment above.
      const targetHidden =
        HAS_INTERPOLATION.test(sql) && (HIDDEN_FROM.test(sql) || !/\bfrom\b/i.test(sql));

      if (!inScopeLiterally && !targetHidden) continue; // genuinely out of scope: FROM is readable
      scanned++;

      if (targetHidden && !inScopeLiterally) {
        const hLine = src.slice(0, m.index!).split('\n').length;
        const hWindow = rawLines
          .slice(Math.max(0, hLine - 1 - EXEMPTION_WINDOW), hLine)
          .join('\n');

        const hVia = resolveVia(hWindow, src);
        if (hVia?.ok) { guarded++; continue; }
        if (hVia && !hVia.ok) {
          sites.push({ file: path.relative(SRC, file), line: hLine,
            sql: sql.replace(/\s+/g, ' ').trim().slice(0, 140), reason: hVia.why! });
          continue;
        }

        const hExempt = hWindow.match(/SOFT-DELETE-EXEMPT:\s*(.+)/);
        if (hExempt && hExempt[1].trim().length >= 20) {
          exempt++;
          continue;
        }

        sites.push({
          file: path.relative(SRC, file),
          line: hLine,
          sql: sql.replace(/\s+/g, ' ').trim().slice(0, 140),
          reason:
            'the FROM target is hidden behind an interpolation, so this sweep CANNOT TELL ' +
            'whether it aggregates a soft-deletable table. That is a finding, not a pass — ' +
            'add SOFT-DELETE-VIA: <identifier> — <reason> if the predicate is assembled ' +
            'elsewhere, or SOFT-DELETE-EXEMPT: <reason> if it must count archived rows',
        });
        continue;
      }

      // GUARDED if the predicate is literal, OR interpolated through a variable whose name
      // says archived (the single-source `${archivedFilter}` idiom used across this tree).
      const literal = /archived_at/i.test(sql);
      const interpolated = /\$\{[^}]*archived[^}]*\}/i.test(sql);
      if (literal || interpolated) {
        guarded++;
        continue;
      }

      const line = src.slice(0, m.index!).split('\n').length;
      const window = rawLines.slice(Math.max(0, line - 1 - EXEMPTION_WINDOW), line).join('\n');

      // SOFT-DELETE-VIA applies here too. A query can name its table plainly and still
      // assemble its predicate elsewhere — `FROM contexts c WHERE ${ORPHAN_PREDICATE_SQL}` is
      // FILTERED, and the filter is one identifier away. Without this arm the only marker
      // available would be EXEMPT, which would be a false statement bought to turn a gate
      // green.
      const vVia = resolveVia(window, src);
      if (vVia?.ok) { guarded++; continue; }
      if (vVia && !vVia.ok) {
        sites.push({ file: path.relative(SRC, file), line,
          sql: sql.replace(/\s+/g, ' ').trim().slice(0, 140), reason: vVia.why! });
        continue;
      }

      const marker = window.match(/SOFT-DELETE-EXEMPT:\s*(.+)/);
      if (marker && marker[1].trim().length >= 20) {
        exempt++;
        continue;
      }

      sites.push({
        file: path.relative(SRC, file),
        line,
        sql: sql.replace(/\s+/g, ' ').trim().slice(0, 140),
        reason: marker ? 'SOFT-DELETE-EXEMPT marker present but its reason is too short to be a reason' : 'no archived predicate and no marker',
      });
    }
  }
  return { sites, scanned, guarded, exempt };
}

describe('every aggregate over a soft-deletable table filters archived rows, or says why not', () => {
  test('the soft-deletable table list is read from the DB, not remembered', async () => {
    const tables = (
      await db.query(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'archived_at' ORDER BY table_name`,
      )
    ).rows.map((r: any) => r.table_name);
    // Empty-population probe: an empty list makes the whole sweep vacuous.
    expect(tables.length).toBeGreaterThan(0);
    expect(tables).toContain('contexts');
    expect(tables).toContain('technical_decisions');
    expect(tables).toContain('tasks');
  });

  test('the sweep instrument itself finds a non-trivial number of sites', async () => {
    const tables = (
      await db.query(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'archived_at'`,
      )
    ).rows.map((r: any) => r.table_name);

    const { scanned, guarded } = findUnguardedSites(tables);
    // If a refactor moved every query out of string literals this sweep would silently
    // scan nothing and pass forever. Assert it still sees the corpus it is meant to police.
    expect(scanned, 'the sweep found no aggregate SQL at all — the extractor has broken').toBeGreaterThan(20);
    expect(guarded, 'no site is filtered — implausible; the detector has broken').toBeGreaterThan(15);
  });

  test('NO aggregate over a soft-deletable table is missing its archived predicate', async () => {
    const tables = (
      await db.query(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'archived_at'`,
      )
    ).rows.map((r: any) => r.table_name);

    const { sites } = findUnguardedSites(tables);
    const report = sites
      .map((s) => `\n  ${s.file}:${s.line} — ${s.reason}\n      ${s.sql}`)
      .join('');

    expect(
      sites,
      `Aggregate(s) over a soft-deletable table with no archived_at predicate:${report}\n\n` +
        `Either add the predicate (see handlers/decisions.ts for the one-predicate-built-once ` +
        `idiom), or, if this query genuinely must count archived rows, put ` +
        `"SOFT-DELETE-EXEMPT: <why>" in a comment within ${EXEMPTION_WINDOW} lines above it. ` +
        `This is how decision_stats reported 556 while decision_search reported 127 on prod.`,
    ).toEqual([]);
  });
});

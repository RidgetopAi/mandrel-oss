#!/usr/bin/env node

/**
 * LENS-AXIS RETAG — CLI.
 *
 * ═══ THE DEFECT ══════════════════════════════════════════════════════════════════════
 * 257 threading-tag instances across 197 records carry a value their axis does not
 * accept. They are not typos: reading all 65 distinct values showed they are RIGHT values
 * on axes that did not exist — components on `scope:`, agent names on `owner:`, phase
 * labels on `tranche:`. an earlier Decision minted `component:` / `actor:` / `batch:` and
 * added `ops` to `owner:`. This script moves the existing rows onto the new vocabulary.
 *
 * IT IS NOT retag-tag-collisions.ts, AND THAT SCRIPT CANNOT DO THIS. That one collapses
 * SPELLING variants of one concept (`needs-operator` vs `needs:operator`) by folding on
 * separators; every tag here is spelled correctly and sits on the wrong axis, which its
 * fold key cannot see. This is the second half of the same clean-up, not a duplicate.
 *
 * ═══ SAFETY POSTURE — READ THIS BEFORE YOU RUN IT ════════════════════════════════════
 * DRY-RUN IS THE DEFAULT, and a live write requires an explicit `--apply` (the posture is
 * copied from retag-tag-collisions.ts on purpose — one script's habits should be the
 * other's). This is a DATA WRITE over customer records: pointing it at prod is the coordinator's or
 * The operator's call after reading a dry run, on the box that owns the data.
 *
 * ═══ IT INVENTS NOTHING ══════════════════════════════════════════════════════════════
 * Every rewrite this script proposes is DERIVED from the shipped vocabulary
 * (`src/config/threadingVocabConfig.ts`) and the shipped quarantine grammar
 * (`src/utils/threadingTags.ts`), never from a hand-written mapping table:
 *
 *   R0 REPAIR    the value is valid on its OWN axis but the row stores the QUARANTINED
 *                form — un-quarantine it in place. (This is what the `ops` widening
 *                needs, and what any row written after a future widening will need.)
 *   R1 OPERATOR  an explicit `--map scope:mandrel=component:prod-mandrel`, repeatable.
 *                Highest precedence. This is the ONLY way a judgement call gets applied,
 *                and it is made by a human at the command line, after reading the census.
 *   R2 CLOSED    the value is a member of exactly ONE OTHER closed axis → move it there.
 *                (`scope:rnd` → `owner:rnd`; `scope:surveyor` → `component:surveyor`.)
 *   R3 ACTOR     the value names a registered actor → move it to `actor:`.
 *                (`owner:builder` → `actor:builder`.)
 *   R4 BATCH     an out-of-set `tranche:` value that is a well-formed batch label →
 *                `batch:`. Restricted to the `tranche:` source axis DELIBERATELY: the
 *                batch axis is validated by SHAPE, so it accepts nearly any token, and an
 *                unrestricted rule would swallow every unmapped value on every axis and
 *                call the migration complete. The census that justified it is specific —
 *                ALL 13 out-of-set tranche values are phase labels (p4, p3, sprint0,
 *                batch-2).
 *
 * If two rules produce different targets the row is reported AMBIGUOUS and left alone. If
 * none produce one it is reported UNMAPPED — with its count, so the biggest unresolved
 * populations are the ones you see first. UNMAPPED is the expected outcome for values the
 * registry does not name (`infra`, `clean-gate`, `mcp-server`) and for spellings that are
 * a judgement call (`mandrel` — the product? the prod instance? the repo?). Those need a
 * ruling, and a ruling is `--map`, not a guess compiled into this file.
 *
 * ═══ WHAT IT DOES TO A ROW ═══════════════════════════════════════════════════════════
 * Replaces the offending tag with the retargeted one IN PLACE, preserving the order of
 * every other tag and de-duplicating (a row that already carries the target keeps ONE
 * copy). Idempotent: a second run finds nothing, because the rewritten tag is valid.
 *
 * USAGE
 *   npx tsx scripts/retag-lens-axes.ts                              # census, all projects
 *   npx tsx scripts/retag-lens-axes.ts --project riverbend
 *   npx tsx scripts/retag-lens-axes.ts --map scope:mandrel=component:prod-mandrel
 *   npx tsx scripts/retag-lens-axes.ts --project riverbend --apply
 *   npx tsx scripts/retag-lens-axes.ts --help
 */

import { LENS_AXES, type LensAxisSpec } from '../src/config/threadingVocabConfig.js';
import {
  THREADING_QUARANTINE_PREFIX,
  isQuarantinedThreadingTag,
} from '../src/utils/threadingTags.js';

/** The three tag-bearing tables. Named once; every query below iterates THIS. */
const TAG_TABLES = ['contexts', 'tasks', 'technical_decisions'] as const;
type TagTable = (typeof TAG_TABLES)[number];

/** The axes with an enumerable roster — the population rule R2 searches. */
const CLOSED_AXES = LENS_AXES.filter(a => a.values !== null);
/** The shape-validated `actor:` axis, used by R3. Absent → R3 is simply never proposed. */
const ACTOR_AXIS = LENS_AXES.find(a => a.prefix === 'actor:') ?? null;
/** R4's source and target axes, looked up rather than spelled as literals. */
const TRANCHE_AXIS = LENS_AXES.find(a => a.prefix === 'tranche:') ?? null;
const BATCH_AXIS = LENS_AXES.find(a => a.prefix === 'batch:') ?? null;

interface Row {
  table: TagTable;
  id: string;
  projectName: string | null;
  tags: string[];
}

type RuleId = 'R0-repair' | 'R1-operator' | 'R2-closed' | 'R3-actor' | 'R4-batch';

interface Proposal {
  /** The tag exactly as stored (possibly wearing the quarantine marker). */
  stored: string;
  /** The tag it would become. */
  next: string;
  rule: RuleId;
}

interface Finding {
  /** The stored tag, verbatim. */
  stored: string;
  /** The axis it claims, after unwrapping any quarantine marker. */
  prefix: string;
  /** The value it carries. */
  value: string;
  proposal: Proposal | null;
  /** Why nothing was proposed, when nothing was. */
  blocked: 'unmapped' | 'ambiguous' | null;
  /** Every candidate any rule produced, for the ambiguity report. */
  candidates: string[];
  rows: Row[];
}

/** Strip the quarantine marker if present, returning the tag as the author wrote it. */
function unwrap(tag: string): string {
  return isQuarantinedThreadingTag(tag)
    ? tag.trim().toLowerCase().slice(THREADING_QUARANTINE_PREFIX.length)
    : tag.trim().toLowerCase();
}

/** The lens axis a (already-unwrapped) tag claims, or null. */
function axisOf(tag: string): LensAxisSpec | null {
  return LENS_AXES.find(a => tag.startsWith(a.prefix)) ?? null;
}

function usage(): string {
  return `
retag-lens-axes — move threading-tag values onto the axis that actually accepts them.

  --project <name>       restrict to one project (default: all)
  --axis <prefix>        restrict to one source axis, e.g. scope: (default: all lens axes)
  --map <from>=<to>      an OPERATOR ruling, e.g. scope:mandrel=component:prod-mandrel.
                         Repeatable. Highest precedence. The target must be VALID.
  --apply                actually write. WITHOUT THIS NOTHING IS WRITTEN.
  --help

DRY-RUN IS THE DEFAULT. Values no rule can place are REPORTED, never guessed at.
`.trim();
}

/**
 * Every target the rules can justify for one stored tag. Returned as a list (not a single
 * answer) so DISAGREEMENT is visible: two rules pointing at two axes is a finding, not
 * something to resolve by rule order.
 */
function proposalsFor(
  stored: string,
  operatorMap: Map<string, string>,
): { proposals: Proposal[]; prefix: string; value: string } | null {
  const bare = unwrap(stored);
  const axis = axisOf(bare);
  if (!axis) return null; // not a lens tag (an id-bearing prefix, a ref, or prose)
  const value = bare.slice(axis.prefix.length);

  const out: Proposal[] = [];

  // R0 — valid on its own axis, but stored quarantined. Repair in place.
  if (axis.isValid(value)) {
    if (isQuarantinedThreadingTag(stored)) out.push({ stored, next: bare, rule: 'R0-repair' });
    return { proposals: out, prefix: axis.prefix, value };
  }

  // R1 — an explicit operator ruling wins outright.
  const ruling = operatorMap.get(bare);
  if (ruling) return { proposals: [{ stored, next: ruling, rule: 'R1-operator' }], prefix: axis.prefix, value };

  // R2 — a member of exactly one OTHER closed axis.
  const closedHits = CLOSED_AXES.filter(a => a.prefix !== axis.prefix && a.isValid(value));
  for (const hit of closedHits) out.push({ stored, next: `${hit.prefix}${value}`, rule: 'R2-closed' });

  // R3 — the value names a registered actor.
  if (ACTOR_AXIS && axis.prefix !== ACTOR_AXIS.prefix && ACTOR_AXIS.isValid(value)) {
    out.push({ stored, next: `${ACTOR_AXIS.prefix}${value}`, rule: 'R3-actor' });
  }

  // R4 — a phase label written on `tranche:`. Source-restricted; see the header.
  if (TRANCHE_AXIS && BATCH_AXIS && axis.prefix === TRANCHE_AXIS.prefix && BATCH_AXIS.isValid(value)) {
    out.push({ stored, next: `${BATCH_AXIS.prefix}${value}`, rule: 'R4-batch' });
  }

  return { proposals: out, prefix: axis.prefix, value };
}

/** Parse `--map a:b=c:d` pairs, refusing any target the shipped vocabulary rejects. */
function parseOperatorMap(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--map') continue;
    const raw = argv[i + 1];
    if (!raw || !raw.includes('=')) throw new Error('--map needs <from>=<to>, e.g. scope:mandrel=component:prod-mandrel');
    const [from, to] = raw.split('=').map(s => s.trim().toLowerCase());
    const toAxis = axisOf(to);
    if (!toAxis) throw new Error(`--map target "${to}" does not name a lens axis.`);
    if (!toAxis.isValid(to.slice(toAxis.prefix.length))) {
      throw new Error(
        `--map target "${to}" is not a value that axis accepts (${toAxis.expects}). This ` +
          'script will not write a tag the product would quarantine on the next edit.',
      );
    }
    if (!axisOf(from)) throw new Error(`--map source "${from}" does not name a lens axis.`);
    out.set(from, to);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  /**
   * Read a flag's VALUE, refusing to swallow the next flag as one. `--project --apply`
   * would otherwise set project="--apply" silently and scope the run to a project that
   * cannot exist — a run that reports "0 records" and looks like a clean census. On a
   * script whose other switch WRITES CUSTOMER DATA, a silently mis-scoped run is worth
   * three lines to make impossible.
   */
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    if (i === -1) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${n} needs a value (got ${value === undefined ? 'nothing' : `"${value}"`}).`);
    }
    return value;
  };
  const onlyProject = flag('--project');
  const onlyAxis = flag('--axis');
  const apply = argv.includes('--apply');
  const operatorMap = parseOperatorMap(argv);

  if (onlyAxis && !LENS_AXES.some(a => a.prefix === onlyAxis)) {
    throw new Error(`--axis "${onlyAxis}" is not a lens axis. Known: ${LENS_AXES.map(a => a.prefix).join(' ')}`);
  }

  const { db, closeDatabase } = await import('../src/config/database.js');

  // ── COLLECT ────────────────────────────────────────────────────────────────────────
  const rows: Row[] = [];
  for (const table of TAG_TABLES) {
    const { rows: r } = await db.query(
      `SELECT t.id, p.name AS project_name, t.tags
         FROM ${table} t LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.tags IS NOT NULL AND array_length(t.tags, 1) > 0`,
    );
    for (const x of r) {
      if (onlyProject && x.project_name !== onlyProject) continue;
      rows.push({ table, id: x.id, projectName: x.project_name, tags: x.tags });
    }
  }

  // ── CLASSIFY (one finding per distinct stored tag) ──────────────────────────────────
  const findings = new Map<string, Finding>();
  for (const row of rows) {
    for (const tag of row.tags) {
      const result = proposalsFor(tag, operatorMap);
      if (!result) continue;
      if (onlyAxis && result.prefix !== onlyAxis) continue;
      const { proposals, prefix, value } = result;
      // A tag already valid AND already unquarantined has nothing to say.
      const axis = axisOf(unwrap(tag))!;
      if (proposals.length === 0 && axis.isValid(value)) continue;

      const key = tag.trim().toLowerCase();
      let f = findings.get(key);
      if (!f) {
        const targets = [...new Set(proposals.map(p => p.next))];
        f = {
          stored: key,
          prefix,
          value,
          proposal: targets.length === 1 ? proposals[0] : null,
          blocked: targets.length === 0 ? 'unmapped' : targets.length > 1 ? 'ambiguous' : null,
          candidates: targets,
          rows: [],
        };
        findings.set(key, f);
      }
      f.rows.push(row);
    }
  }

  // ── REPORT ─────────────────────────────────────────────────────────────────────────
  const byCount = [...findings.values()].sort((a, b) => b.rows.length - a.rows.length);
  const actionable = byCount.filter(f => f.proposal);
  const unmapped = byCount.filter(f => f.blocked === 'unmapped');
  const ambiguous = byCount.filter(f => f.blocked === 'ambiguous');
  const instances = (fs: Finding[]) => fs.reduce((n, f) => n + f.rows.length, 0);

  console.log(
    `\n${apply ? 'LIVE (--apply)' : 'DRY-RUN (no writes)'} — scanned ${rows.length} tagged record(s)` +
      `${onlyProject ? ` in project "${onlyProject}"` : ' across all projects'}` +
      `${onlyAxis ? `, axis ${onlyAxis}` : ''}\n`,
  );

  console.log(`WOULD RETAG — ${actionable.length} distinct tag(s), ${instances(actionable)} instance(s)`);
  for (const f of actionable) {
    console.log(`  ${f.stored.padEnd(38)} -> ${f.proposal!.next.padEnd(30)} ${f.proposal!.rule.padEnd(11)} ${f.rows.length} record(s)`);
  }

  if (ambiguous.length) {
    console.log(`\nAMBIGUOUS — ${ambiguous.length} distinct tag(s), ${instances(ambiguous)} instance(s) — LEFT ALONE`);
    for (const f of ambiguous) {
      console.log(`  ${f.stored.padEnd(38)} candidates: ${f.candidates.join(' | ')} (${f.rows.length} record(s))`);
    }
  }

  console.log(
    `\nNEEDS A RULING — ${unmapped.length} distinct tag(s), ${instances(unmapped)} instance(s) — LEFT ALONE`,
  );
  for (const f of unmapped) {
    // The hint prints the UNWRAPPED tag, because that is what --map matches on: a ruling is
    // about a VALUE on an AXIS, and the quarantine marker is storage state, not vocabulary.
    console.log(`  ${f.stored.padEnd(38)} ${f.rows.length} record(s)   --map ${unwrap(f.stored)}=<axis:value>`);
  }

  // ── WRITE ──────────────────────────────────────────────────────────────────────────
  let touched = 0;
  if (apply) {
    // Group by row so a record carrying two retargetable tags is written ONCE.
    const perRow = new Map<string, { row: Row; swaps: Map<string, string> }>();
    for (const f of actionable) {
      for (const row of f.rows) {
        const key = `${row.table}:${row.id}`;
        let e = perRow.get(key);
        if (!e) {
          e = { row, swaps: new Map() };
          perRow.set(key, e);
        }
        e.swaps.set(f.stored, f.proposal!.next);
      }
    }
    for (const { row, swaps } of perRow.values()) {
      const next: string[] = [];
      for (const t of row.tags) {
        const v = swaps.get(t.trim().toLowerCase()) ?? t;
        if (!next.includes(v)) next.push(v);
      }
      await db.query(`UPDATE ${row.table} SET tags = $1 WHERE id = $2`, [next, row.id]);
      touched++;
    }
  }

  console.log(
    `\n${apply ? `Rewrote ${touched}` : `Would rewrite ${new Set(actionable.flatMap(f => f.rows.map(r => `${r.table}:${r.id}`))).size}`} record(s).\n`,
  );
  await closeDatabase();
}

main().catch(e => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});

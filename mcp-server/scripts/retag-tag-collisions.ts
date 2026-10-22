#!/usr/bin/env node

/**
 * TAG SPELLING-COLLISION RETAG — CLI (defect 2).
 *
 * ═══ THE DEFECT ══════════════════════════════════════════════════════════════════════
 * `needs-operator` and `needs:operator` are ONE CONCEPT SPELLED TWO WAYS, both live, so any
 * consumer that selects on one spelling sees a fraction of the population. The DETECTION
 * already shipped — `config/blockedOnConfig.ts` folds tags on separators and the briefing
 * renders the finding — and it deliberately REPORTS without normalising, because folding
 * at read time hides the defect while the stored rows stay split. This script is the other
 * half: the write that actually collapses the split.
 *
 * ═══ SAFETY POSTURE — READ THIS BEFORE YOU RUN IT ════════════════════════════════════
 * DRY-RUN IS THE DEFAULT. A live write requires an explicit `--apply`. This is a DATA
 * WRITE over customer records: do NOT point it at prod from a dev build. That run is
 * The coordinator's / the operator's call after review, on the box that owns the data.
 *
 * It also refuses to invent a canonical spelling. `--to` must name a spelling that is
 * ALREADY PRESENT in the group, so the script can only ever collapse spellings that exist
 * — it can never mint a new one nobody chose. `--auto` applies a stated, deterministic
 * rule instead (see pickCanonical) and PRINTS the choice for every group before writing.
 *
 * ═══ THE FOLD KEY IS IMPORTED, NOT RE-TYPED ══════════════════════════════════════════
 * `TAG_COLLISION_NORMALIZE_RE` / `TAG_COLLISION_SEPARATOR` come from the SHIPPED config
 * that the briefing's finding uses. A second hand-written copy of that regex here would
 * be the exact drift class this repo keeps closing, and worse: the script
 * would then retag a population the product does not consider collided.
 *
 * ═══ WHAT IT DOES TO A ROW ═══════════════════════════════════════════════════════════
 * Replaces every non-canonical spelling in the group with the canonical one, DE-DUPLICATING
 * — a row carrying BOTH spellings ends with ONE tag, not two identical ones — and leaving
 * every other tag, and their order, untouched. It is idempotent: a second run finds nothing.
 *
 * USAGE
 *   npx tsx scripts/retag-tag-collisions.ts                          # census, all projects
 *   npx tsx scripts/retag-tag-collisions.ts --project riverbend --group needs-operator
 *   npx tsx scripts/retag-tag-collisions.ts --project riverbend --group needs-operator \
 *       --to needs-operator --apply
 *   npx tsx scripts/retag-tag-collisions.ts --help
 */

import {
  TAG_COLLISION_NORMALIZE_RE,
  TAG_COLLISION_SEPARATOR,
} from '../src/config/blockedOnConfig.js';

/** The three tag-bearing tables. Named once; every query below iterates THIS. */
const TAG_TABLES = ['contexts', 'tasks', 'technical_decisions'] as const;
type TagTable = (typeof TAG_TABLES)[number];

interface Row {
  table: TagTable;
  id: string;
  projectName: string | null;
  tags: string[];
}
interface Group {
  projectName: string;
  fold: string;
  spellings: Map<string, number>;
  rows: Row[];
}

/**
 * The SHIPPED fold: the same key the briefing's collision finding groups by.
 *
 * NOTE the regex is GLOBAL, so it carries `lastIndex` state across calls. A fresh RegExp
 * per call is the only safe way to reuse an imported /g pattern — sharing it would make
 * this function return different answers for the same input depending on call order.
 */
function foldKey(tag: string): string {
  const re = new RegExp(TAG_COLLISION_NORMALIZE_RE.source, TAG_COLLISION_NORMALIZE_RE.flags);
  return tag.trim().toLowerCase().replace(re, TAG_COLLISION_SEPARATOR);
}

function usage(): string {
  return `
retag-tag-collisions — collapse tags that are one concept spelled several ways.

  --project <name>   restrict to one project (default: all)
  --group <fold>     restrict to one fold key, e.g. needs-operator (default: all)
  --to <spelling>    the canonical spelling. MUST already exist in the group.
  --auto             choose the canonical by the stated rule instead of --to
  --apply            actually write. WITHOUT THIS NOTHING IS WRITTEN.
  --help

DRY-RUN IS THE DEFAULT. --to and --auto are mutually exclusive. A live run needs a
canonical (--to or --auto); a census run needs neither.
`.trim();
}

/**
 * THE STATED RULE, applied only under --auto, in this order:
 *   1. the spelling on the MOST records — the majority is the one already in people's heads;
 *   2. tie-break: the spelling that does NOT contain ':'. A colon is the THREADING grammar's
 *      separator (`task:` / `scope:` / `owner:`), so a non-threading tag wearing one squats
 *      a reserved namespace and reads to a human as a threading tag that threads nothing —
 *      the sibling defect of this very task;
 *   3. tie-break: the all-lowercase form;
 *   4. tie-break: lexicographic, so the choice is deterministic rather than dictated by the
 *      order rows happened to come back in.
 * It is a RULE, not a judgement: --auto prints its pick for every group before writing.
 */
function pickCanonical(spellings: Map<string, number>): string {
  return [...spellings.entries()].sort(
    (a, b) =>
      b[1] - a[1] ||
      Number(a[0].includes(':')) - Number(b[0].includes(':')) ||
      Number(a[0] !== a[0].toLowerCase()) - Number(b[0] !== b[0].toLowerCase()) ||
      a[0].localeCompare(b[0]),
  )[0][0];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const onlyProject = flag('--project');
  const onlyGroup = flag('--group');
  const to = flag('--to');
  const auto = argv.includes('--auto');
  const apply = argv.includes('--apply');

  if (to && auto) {
    throw new Error('--to and --auto are mutually exclusive: pick one canonical source.');
  }
  if (apply && !to && !auto) {
    throw new Error('--apply needs a canonical: pass --to <spelling> or --auto.');
  }
  if (to && !onlyGroup) {
    throw new Error('--to names ONE group of spellings; pass --group as well.');
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

  // ── GROUP (per project: a collision is a property of ONE project's own tag set) ─────
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const tag of row.tags) {
      const fold = foldKey(tag);
      if (onlyGroup && fold !== onlyGroup) continue;
      // JSON key rather than a delimiter-joined string: a project name can contain any
      // character, so any separator we picked could collide. This one cannot.
      const key = JSON.stringify([row.projectName ?? '(none)', fold]);
      let g = groups.get(key);
      if (!g) {
        g = { projectName: row.projectName ?? '(none)', fold, spellings: new Map(), rows: [] };
        groups.set(key, g);
      }
      g.spellings.set(tag, (g.spellings.get(tag) ?? 0) + 1);
      if (!seen.has(key)) {
        g.rows.push(row);
        seen.add(key);
      }
    }
  }
  const collided = [...groups.values()]
    .filter((g) => g.spellings.size > 1)
    .sort((a, b) => b.rows.length - a.rows.length);

  console.log(
    `\n${apply ? 'LIVE (--apply)' : 'DRY-RUN (no writes)'} — ${collided.length} collision group(s)\n`,
  );
  let wouldTouch = 0;

  for (const g of collided) {
    const canonical = to ?? (auto ? pickCanonical(g.spellings) : null);
    const forms = [...g.spellings.entries()].map(([s, n]) => `${s} (${n})`).join(' | ');
    console.log(`  ${g.projectName} / ${g.fold}: ${forms}`);
    if (!canonical) continue;
    if (!g.spellings.has(canonical)) {
      throw new Error(
        `--to "${canonical}" is not a spelling present in ${g.projectName}/${g.fold}. ` +
          'This script collapses EXISTING spellings; it will not mint a new one.',
      );
    }
    const targets = g.rows.filter((r) =>
      r.tags.some((t) => foldKey(t) === g.fold && t !== canonical),
    );
    wouldTouch += targets.length;
    console.log(`     -> canonical "${canonical}"; ${targets.length} record(s) to rewrite`);

    if (!apply) continue;
    for (const r of targets) {
      // Rewrite in place, preserving order, de-duplicating if BOTH spellings are present.
      const next: string[] = [];
      for (const t of r.tags) {
        const v = foldKey(t) === g.fold ? canonical : t;
        if (!next.includes(v)) next.push(v);
      }
      await db.query(`UPDATE ${r.table} SET tags = $1 WHERE id = $2`, [next, r.id]);
    }
  }

  console.log(`\n${apply ? 'Rewrote' : 'Would rewrite'} ${wouldTouch} record(s).\n`);
  await closeDatabase();
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});

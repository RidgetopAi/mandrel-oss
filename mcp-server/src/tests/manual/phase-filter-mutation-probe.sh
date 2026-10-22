#!/usr/bin/env bash
# MUTATION PROBE for the task_list phase-spelling guard.
#
# COUNT THE DIRECTIONS, NOT THE PROBES. A guard on a MATCHER can fail two opposite ways,
# and a probe suite that only narrows proves half of it:
#   A — NARROWED  : the shipped defect. Only `phase-<v>` is generated, so the colon and
#                   no-separator bands go missing and the caller sees `total: 0`.
#   B — OVER-WIDE : the plausible "improvement". Fold BOTH sides by deleting separators,
#                   so `phase:"1.2"` also matches a `phase-12` task. A suite of positive
#                   cases alone stays GREEN through this, which is why the negative cases
#                   in the contract test exist.
#
# THE SECOND READ PATH GETS ITS OWN TWO DIRECTIONS (added in REJECT ROUND 1, Reviewer
# verdict 7c2977e2 F1). The same commit changed task_progress_summary(groupBy:'phase') --
# the tool's DEFAULT grouping -- and directions A and B do not touch it: they mutate the
# candidate GENERATOR the task_list filter uses, while the summary goes through the SQL
# RECOGNISER and the CANONICAL fold. Reviewer proved that gap by reverting both helpers to
# the shipped dash-only defect and still getting 313 files / 3977 tests / exit 0. So:
#   C -- RECOGNISER NARROWED: Reviewer's exact mutation. Separator class `[-_:. ]` -> `[-]`
#                   and the optional-separator `?` deleted. The non-dash spellings vanish
#                   from the summary with no trace -- 43 of 163 live tasks on prod.
#   D -- FOLD REMOVED: the recogniser still matches every spelling, but the canonical key
#                   returns the RAW tag, so one phase becomes five groups of one instead of
#                   one group of five. C and D are NOT the same failure: C loses rows, D
#                   keeps every row and splits the answer. A guard that only checked the
#                   row TOTAL would miss D completely.
#
# THREE ASSERTIONS PER DIRECTION, all of them, every time:
#   1. the mutation LANDED — witnessed from INSIDE the mutated code path (a marker file the
#      mutated function itself writes), never from the diff. An edit that is in the file but
#      whose module never loaded proves nothing, and a mutant that cannot even compile emits
#      plenty of output while testing nothing.
#   2. the guard went RED.
#   3. the UNMUTATED control is GREEN.
#
# RUN (needs a disposable ci_* DB, never production):
#   bash scripts/provision-test-db.sh ci_phaseprobe   # prints the DATABASE_* exports
#   ... export them, then:
#   bash mcp-server/src/tests/manual/phase-filter-mutation-probe.sh
set -uo pipefail

cd "$(dirname "$0")/../../.." || exit 2   # -> mcp-server/

TEST=src/tests/phaseFilterSpellings.contract.test.ts
CFG=src/config/phaseTagConfig.ts
HND=src/handlers/tasks.ts
WORK=$(mktemp -d)
trap 'cp "$WORK/phaseTagConfig.ts" "$CFG"; cp "$WORK/tasks.ts" "$HND"; rm -rf "$WORK"' EXIT

cp "$CFG" "$WORK/phaseTagConfig.ts"
cp "$HND" "$WORK/tasks.ts"

run_suite() {   # -> prints PASS/FAIL
  if npx vitest run "$TEST" >"$WORK/out.log" 2>&1; then echo PASS; else echo FAIL; fi
}

fail=0
assert() { # assert <label> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "   ok   $1: $3"; else echo "   FAIL $1: expected $2, got $3"; fail=1; fi
}

echo "== CONTROL (unmutated) =="
assert "control is GREEN" PASS "$(run_suite)"

probe() { # probe <letter> <python-mutator>
  local letter="$1" mutator="$2"
  echo "== DIRECTION $letter =="
  cp "$WORK/phaseTagConfig.ts" "$CFG"; cp "$WORK/tasks.ts" "$HND"
  rm -f "$WORK/witness.txt"
  python3 -c "$mutator" || { echo "   FAIL mutator did not apply"; fail=1; return; }
  PHASE_PROBE_WITNESS="$WORK/witness.txt" run_suite >"$WORK/verdict.txt"
  local verdict; verdict=$(cat "$WORK/verdict.txt")
  # 1. LANDED — the marker is written BY THE MUTATED FUNCTION, and the exact marker text is
  #    required. "output is non-empty" would be satisfied by a compile error.
  local landed=no
  [ -f "$WORK/witness.txt" ] && grep -q "MUTANT-$letter-EXECUTED" "$WORK/witness.txt" && landed=yes
  assert "mutation LANDED (witnessed from inside the path)" yes "$landed"
  # 2. RED
  assert "guard went RED" FAIL "$verdict"
  grep -E '^\s+[×✓].*(NEGATIVE|colon|NO-SEPARATOR|2c|collapse|DEFAULT call|dropped|canonical five|LOWERCASES)' "$WORK/out.log" | head -8
}

# ── DIRECTION A: narrow the grammar back to the shipped defect ───────────────────────────
probe A "$(cat <<'PY'
p='src/config/phaseTagConfig.ts'; s=open(p).read()
old="  return PHASE_TAG_BOUNDARY_SEPARATORS.map(sep => `${PHASE_TAG_PREFIX}${sep}${value}`);"
new=("  require('fs').appendFileSync(process.env.PHASE_PROBE_WITNESS, 'MUTANT-A-EXECUTED\\n');\n"
     "  return [`${PHASE_TAG_PREFIX}-${value}`];")
assert s.count(old)==1
s=s.replace(old, ''.join(new))
s="import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n"+s
open(p,'w').write(s)
PY
)"

# ── DIRECTION B: over-widen by deleting separators on BOTH sides ─────────────────────────
probe B "$(cat <<'PY'
p='src/handlers/tasks.ts'; s=open(p).read()
old="""            clause += ` AND EXISTS (SELECT 1 FROM unnest(tags) AS phase_tag` +
                      ` WHERE lower(phase_tag) = ANY($${paramIndex}::text[]))`;
            params.push(candidates);"""
new="""            require('fs').appendFileSync(process.env.PHASE_PROBE_WITNESS, 'MUTANT-B-EXECUTED\\n');
            clause += ` AND EXISTS (SELECT 1 FROM unnest(tags) AS phase_tag` +
                      ` WHERE regexp_replace(lower(phase_tag), '[^a-z0-9]', '', 'g')` +
                      ` = ANY($${paramIndex}::text[]))`;
            params.push(candidates.map(c => c.replace(/[^a-z0-9]/g, '')));"""
assert s.count(old)==1
s=s.replace(old,new)
s="import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n"+s
open(p,'w').write(s)
PY
)"

# ── DIRECTION C: narrow the SQL RECOGNISER back to dash-only (Reviewer's mutation) ─────
probe C "$(cat <<'PY'
p='src/config/phaseTagConfig.ts'; s=open(p).read()
old = "export const PHASE_TAG_SEPARATOR_CLASS = '[-_:. ]';"
assert s.count(old)==1
s = s.replace(old, "export const PHASE_TAG_SEPARATOR_CLASS = '[-]';")
# The other half of the shipped defect: `phase5` has no separator at all, so delete the
# optional-separator marker in BOTH builders.
assert s.count('${PHASE_TAG_SEPARATOR_CLASS}?') == 2
s = s.replace('${PHASE_TAG_SEPARATOR_CLASS}?', '${PHASE_TAG_SEPARATOR_CLASS}')
old2 = "export function phaseTagRecognizerSql(tagExpr: string): string {"
assert s.count(old2)==1
s = s.replace(old2, old2 + "\n  require('fs').appendFileSync(process.env.PHASE_PROBE_WITNESS, 'MUTANT-C-EXECUTED\\n');")
s = "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n" + s
open(p,'w').write(s)
PY
)"

# ── DIRECTION D: keep the recogniser, DELETE the canonical fold (raw tag as the key) ─────
probe D "$(cat <<'PY'
p='src/config/phaseTagConfig.ts'; s=open(p).read()
i = s.index("  return `('${PHASE_TAG_PREFIX}-' || substring(lower(${tagExpr}) from `")
j = s.index("\n", s.index("(.+)$'))`;", i))
new = ("  require('fs').appendFileSync(process.env.PHASE_PROBE_WITNESS, 'MUTANT-D-EXECUTED\\n');\n"
       "  return tagExpr;")
s = s[:i] + new + s[j:]
s = "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n" + s
open(p,'w').write(s)
PY
)"

cp "$WORK/phaseTagConfig.ts" "$CFG"; cp "$WORK/tasks.ts" "$HND"
echo "== CONTROL AFTER RESTORE =="
assert "restored tree is GREEN" PASS "$(run_suite)"

[ "$fail" = 0 ] && echo "PROBE RESULT: all assertions held" || echo "PROBE RESULT: SOMETHING DID NOT HOLD"
exit "$fail"

#!/usr/bin/env bash
# MUTATION PROBE for the task_list branch-membership join (step 1).
#
# COUNT THE DIRECTIONS, NOT THE PROBES. This guard is about a FIELD, and a field fails two
# opposite ways that a single probe cannot separate:
#   A — ABSENT           : the join is gone, so nothing about branches reaches the list.
#                          This is the state the fix replaced.
#   B — PRESENT BUT HOLLOW: the key is emitted for every row and its value is always `null`.
#                          A guard that asserted "the key is there" stays GREEN through this
#                          — and a consumer reading it counts every declared member as
#                          branchless, which is the EXACT miscount the field exists to end.
#                          B is the direction that matters; A is the easy one.
#
# THREE ASSERTIONS PER DIRECTION, all of them, every time:
#   1. the mutation LANDED — witnessed from INSIDE the mutated path (the mutated code writes
#      a marker with an exact string), never from the diff. An edit whose module never loads,
#      or a mutant that fails to compile, produces plenty of output and tests nothing.
#   2. the guard went RED.
#   3. the UNMUTATED control is GREEN.
#
# RUN (needs a disposable ci_* DB, never production):
#   bash scripts/provision-test-db.sh ci_memprobe   # prints the DATABASE_* exports
#   ... export them, then:
#   bash mcp-server/src/tests/manual/membership-join-mutation-probe.sh
set -uo pipefail

cd "$(dirname "$0")/../../.." || exit 2   # -> mcp-server/

TEST=src/tests/taskListBranchMembership.contract.test.ts
HND=src/handlers/tasks.ts
WORK=$(mktemp -d)
trap 'cp "$WORK/tasks.ts" "$HND"; rm -rf "$WORK"' EXIT
cp "$HND" "$WORK/tasks.ts"

run_suite() { if npx vitest run "$TEST" >"$WORK/out.log" 2>&1; then echo PASS; else echo FAIL; fi; }

fail=0
assert() { if [ "$2" = "$3" ]; then echo "   ok   $1: $3"; else echo "   FAIL $1: expected $2, got $3"; fail=1; fi; }

echo "== CONTROL (unmutated) =="
assert "control is GREEN" PASS "$(run_suite)"

probe() { # probe <letter> <python-mutator>
  local letter="$1" mutator="$2"
  echo "== DIRECTION $letter =="
  cp "$WORK/tasks.ts" "$HND"
  rm -f "$WORK/witness.txt"
  python3 -c "$mutator" || { echo "   FAIL mutator did not apply"; fail=1; return; }
  PHASE_PROBE_WITNESS="$WORK/witness.txt" run_suite >"$WORK/verdict.txt"
  local verdict; verdict=$(cat "$WORK/verdict.txt")
  local landed=no
  [ -f "$WORK/witness.txt" ] && grep -q "MUTANT-$letter-EXECUTED" "$WORK/witness.txt" && landed=yes
  assert "mutation LANDED (witnessed from inside the path)" yes "$landed"
  assert "guard went RED" FAIL "$verdict"
  grep -E '^\s+[×✓].*(DECLARED|MISCOUNT|null|ABSENT|human channel)' "$WORK/out.log" | head -6
}

# ── DIRECTION A: drop the join — membership never reaches the list at all ───────────────
probe A "$(cat <<'PY'
p='src/handlers/tasks.ts'; s=open(p).read()
i=s.index('let query = `SELECT tasks.*,')
j=s.index('${clause}`;', i)+len('${clause}`;')
new=("require('fs').appendFileSync(process.env.PHASE_PROBE_WITNESS, 'MUTANT-A-EXECUTED\\n');\n"
     "            let query = `SELECT * FROM tasks ${clause}`;")
s=s[:i]+''.join(new)+s[j:]
s="import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n"+s
open(p,'w').write(s)
PY
)"

# ── DIRECTION B: keep the key, always emit null (the hollow serializer) ─────────────────
probe B "$(cat <<'PY'
p='src/handlers/tasks.ts'; s=open(p).read()
old="""            ...('membership_spine_id' in row
                ? {
                    branchMembership: row.membership_spine_id"""
new="""            ...('membership_spine_id' in row
                ? {
                    branchMembership: (require('fs').appendFileSync(process.env.PHASE_PROBE_WITNESS, 'MUTANT-B-EXECUTED\\n'), false)"""
assert s.count(old)==1
s=s.replace(old,new)
s="import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n"+s
open(p,'w').write(s)
PY
)"

cp "$WORK/tasks.ts" "$HND"
echo "== CONTROL AFTER RESTORE =="
assert "restored tree is GREEN" PASS "$(run_suite)"

[ "$fail" = 0 ] && echo "PROBE RESULT: all assertions held" || echo "PROBE RESULT: SOMETHING DID NOT HOLD"
exit "$fail"

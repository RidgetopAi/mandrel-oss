#!/usr/bin/env bash
# supersession-docs-install.test.sh — (1) README.md, docs/manual and .env.example never mention Groq;
# (2) docs/manual/supersession.md carries the recommended setup, options and daily-cap section;
# (3) install.sh's supersession mode report prints tiered / anthropic / off for both keys / only the
# Anthropic key / no keys, prints the cap, recommends a Snap key in the Anthropic-only case, and
# never prints a key value.
# Env: DOCS_ROOT overrides the repo root (the critic's mutation runs use a mutated copy).
# Exit: 0 pass · 1 a check failed · 2 could not measure.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${DOCS_ROOT:-$(cd "$HERE/../.." && pwd)}"
DOC="$ROOT/docs/manual/supersession.md"
for f in "$DOC" "$ROOT/install.sh" "$ROOT/README.md" "$ROOT/.env.example"; do
  [[ -f "$f" ]] || { echo "  CANNOT MEASURE: missing $f"; exit 2; }
done
FAILS=0
ok()  { printf '  [PASS] %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
has() { grep -qiE -- "$1" "$2"; }

# --- (1) no Groq -------------------------------------------------------------------------------
groq_hits="$(grep -rniI groq "$ROOT/README.md" "$ROOT/docs/manual" "$ROOT/.env.example" || true)"
check "no 'groq' (any case) in README.md, docs/manual, .env.example" test -z "$groq_hits"
[[ -z "$groq_hits" ]] || printf '%s\n' "$groq_hits" | sed 's/^/      /'

# --- (2) supersession.md content -----------------------------------------------------------------
check "doc recommends Snap + Anthropic"                has 'Recommended: Snap \+ Anthropic' "$DOC"
check "doc says preview next to Snap pricing"          has 'preview.*pricing|pricing.*preview' "$DOC"
check "doc has a Snap only option"                     has '^### Snap only' "$DOC"
check "doc has an Anthropic only option"               has '^### Anthropic only' "$DOC"
check "doc has a local-model option (openai-compat)"   has '^### A local or smaller model' "$DOC"
check "doc has the daily spend cap section"            has '^## The daily spend cap' "$DOC"
cap_sec="$(sed -n '/^## The daily spend cap/,$p' "$DOC")"
check "cap section names MANDREL_BELIEF_DAILY_SPEND_CAP_USD" grep -q 'MANDREL_BELIEF_DAILY_SPEND_CAP_USD' <<<"$cap_sec"
check "cap section states the default of 2"            grep -qE 'default is `2`' <<<"$cap_sec"
check "cap section says writes keep working"           grep -qi 'writes keep working' <<<"$cap_sec"

# --- (3) install.sh mode report ------------------------------------------------------------------
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# install.sh reads the mode from `docker compose config`; fake it by rendering the real compose file
# against the case's .env (scripts/test/lib/compose-render.py), so no container runtime is needed.
mkdir -p "$T/bin"
cat >"$T/bin/docker" <<FAKE
#!/usr/bin/env bash
[[ "\$1 \$2" == "compose config" ]] || exit 0
exec python3 -I "$ROOT/scripts/test/lib/compose-render.py" "$ROOT/docker-compose.yml" "\$FAKE_ENV"
FAKE
chmod +x "$T/bin/docker"
# Fixture values are assembled at runtime so no `NAME=<literal>` line exists for the credential-env rule.
SUBQ_SECRET="$(printf '%s-%s-%s' subq secret VALUE-0001)"; ANTH_SECRET="$(printf '%s-%s-%s' anth secret VALUE-0002)"
run_report() { # run_report <env-file-content> -> output of report_supersession_mode from a copy of install.sh
  local d; d="$(mktemp -d "$T/case.XXXXXX")"
  cp "$ROOT/install.sh" "$d/install.sh"; printf '%s' "$1" >"$d/.env"
  ( env -u SUBQ_API_KEY -u ANTHROPIC_API_KEY -u MANDREL_BELIEF_DAILY_SPEND_CAP_USD \
      -u MANDREL_BELIEF_ENABLED -u MANDREL_BELIEF_ADJUDICATOR_PROVIDER \
      PATH="$T/bin:$PATH" FAKE_ENV="$d/.env" \
      bash -c 'D=$1; set --; source "$D/install.sh" && report_supersession_mode' _ "$d" 2>&1 )
}
out_both="$(run_report "SUBQ_API_KEY=$SUBQ_SECRET
ANTHROPIC_API_KEY=$ANTH_SECRET
")"
out_anth="$(run_report "ANTHROPIC_API_KEY=$ANTH_SECRET
")"
out_none="$(run_report "SUBQ_API_KEY=
ANTHROPIC_API_KEY=
")"
check "both keys -> mode tiered"        grep -qx 'Supersession mode: tiered' <<<"$out_both"
check "Anthropic only -> mode anthropic" grep -qx 'Supersession mode: anthropic' <<<"$out_anth"
check "no keys -> mode off"             grep -qx 'Supersession mode: off' <<<"$out_none"
for c in both anth none; do
  v="out_$c"
  check "$c: daily cap printed (default 2)" grep -qE 'Daily spend cap: \$2 ' <<<"${!v}"
done
check "Anthropic only: recommends a Snap key" grep -q 'add SUBQ_API_KEY' <<<"$out_anth"
check "both keys: no Snap recommendation"     bash -c '! grep -q "add SUBQ_API_KEY" <<<"$1"' _ "$out_both"
check "no keys: no Snap recommendation"       bash -c '! grep -q "add SUBQ_API_KEY" <<<"$1"' _ "$out_none"
out_cap="$(run_report "ANTHROPIC_API_KEY=$ANTH_SECRET
MANDREL_BELIEF_DAILY_SPEND_CAP_USD=7
")"
check "configured cap (7) is the one printed" grep -qE 'Daily spend cap: \$7 ' <<<"$out_cap"
all="$out_both$out_anth$out_none$out_cap"
check "no key value appears in any output" bash -c '! grep -qE "$1|$2" <<<"$3"' _ "$SUBQ_SECRET" "$ANTH_SECRET" "$all"

if (( FAILS )); then echo "supersession-docs-install: $FAILS check(s) FAILED"; exit 1; fi
echo "supersession-docs-install: all checks passed"

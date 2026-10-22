#!/usr/bin/env bash
# supersession-mode-report.test.sh — install.sh's supersession mode report describes what the
# SERVER will run (the environment the mcp-server container receives, from the rendered compose
# config), not what .env alone says.
#  * .env holds both keys but the compose environment delivers neither -> the report says off
#  * both keys delivered (the real docker-compose.yml, rendered) -> tiered, with the delivered cap
#  * no key value appears in any output
# `docker compose config` is faked: it renders the chosen compose file against the case's .env with
# scripts/test/lib/compose-render.py (no docker, no network).
# Env: COMPOSE_FILE overrides the compose file for the "delivered" case; INSTALL_SH the script.
# Exit: 0 pass · 1 a check failed · 2 could not measure.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
INSTALL="${INSTALL_SH:-$ROOT/install.sh}"
REAL_COMPOSE="${COMPOSE_FILE:-$ROOT/docker-compose.yml}"
UNFORWARDED="$HERE/fixtures/compose-supersession-unforwarded.yml"
RENDER="$HERE/lib/compose-render.py"
for f in "$INSTALL" "$REAL_COMPOSE" "$UNFORWARDED" "$RENDER"; do
  [[ -f "$f" ]] || { echo "  CANNOT MEASURE: missing $f"; exit 2; }
done
python3 -c 'import yaml' 2>/dev/null || { echo "  CANNOT MEASURE: python3 yaml module missing"; exit 2; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAILS=0
ok()  { printf '  [PASS] %s\n' "$*"; }
bad() { printf '  [FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

mkdir -p "$T/bin"
cat >"$T/bin/docker" <<FAKE
#!/usr/bin/env bash
[[ "\$1 \$2" == "compose config" ]] || exit 0
exec python3 -I "$RENDER" "\$FAKE_COMPOSE" "\$FAKE_ENV"
FAKE
chmod +x "$T/bin/docker"

# Fixture values are assembled at runtime so no `NAME=<literal>` line exists for the credential-env rule.
SUBQ_SECRET="$(printf '%s-%s-%s' subq secret VALUE-0001)"; ANTH_SECRET="$(printf '%s-%s-%s' anth secret VALUE-0002)"
ENV_BOTH="SUBQ_API_KEY=$SUBQ_SECRET
ANTHROPIC_API_KEY=$ANTH_SECRET
MANDREL_BELIEF_DAILY_SPEND_CAP_USD=0.01
"
run_report() { # run_report <compose file> <.env content>
  local d; d="$(mktemp -d "$T/case.XXXXXX")"
  cp "$INSTALL" "$d/install.sh"; printf '%s' "$2" >"$d/.env"
  ( env -u SUBQ_API_KEY -u ANTHROPIC_API_KEY -u MANDREL_BELIEF_DAILY_SPEND_CAP_USD \
      -u MANDREL_BELIEF_ENABLED -u MANDREL_BELIEF_ADJUDICATOR_PROVIDER \
      PATH="$T/bin:$PATH" FAKE_COMPOSE="$1" FAKE_ENV="$d/.env" \
      bash -c 'D=$1; set --; source "$D/install.sh" && report_supersession_mode' _ "$d" 2>&1 )
}

out_off="$(run_report "$UNFORWARDED" "$ENV_BOTH")"
out_on="$(run_report "$REAL_COMPOSE" "$ENV_BOTH")"
out_default="$(run_report "$REAL_COMPOSE" "SUBQ_API_KEY=$SUBQ_SECRET
ANTHROPIC_API_KEY=$ANTH_SECRET
")"
out_forced="$(run_report "$REAL_COMPOSE" "${ENV_BOTH}MANDREL_BELIEF_ENABLED=false
")"

check "keys in .env but not delivered by compose -> mode off"   grep -qx 'Supersession mode: off' <<<"$out_off"
check "undelivered keys: the report does not claim tiered"      bash -c '! grep -qi tiered <<<"$1"' _ "$out_off"
check "undelivered keys: the report notes .env holds a key"     grep -q '\.env holds a supersession key' <<<"$out_off"
check "undelivered keys: the server default cap (2) is reported, not the .env 0.01" grep -qE 'Daily spend cap: \$2 ' <<<"$out_off"
check "both keys delivered -> mode tiered"                      grep -qx 'Supersession mode: tiered' <<<"$out_on"
check "both keys delivered -> the delivered cap (0.01) is printed" grep -qE 'Daily spend cap: \$0\.01 ' <<<"$out_on"
check "both keys delivered, no cap set -> default cap 2"        grep -qE 'Daily spend cap: \$2 ' <<<"$out_default"
check "MANDREL_BELIEF_ENABLED=false delivered -> mode off"      grep -qx 'Supersession mode: off' <<<"$out_forced"
check "no key value appears in any output" bash -c '! grep -qE "$1|$2" <<<"$3"' _ "$SUBQ_SECRET" "$ANTH_SECRET" "$out_off$out_on$out_default$out_forced"

if (( FAILS )); then echo "supersession-mode-report: $FAILS check(s) FAILED"; exit 1; fi
echo "supersession-mode-report: all checks passed"

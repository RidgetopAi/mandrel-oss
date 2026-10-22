#!/usr/bin/env bash
# gitleaks-allowlist.test.sh — the repo's .gitleaks.toml allowlists placeholder values
# but still fails a real-looking token.
# In a throwaway git repo: `MANDREL_TOKEN=<40 random hex>` must exit 1, the same file with
# `example-token` must exit 0. Values are assembled at runtime so this file carries no literal.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CFG="${GITLEAKS_CONFIG:-$ROOT/.gitleaks.toml}"
command -v gitleaks >/dev/null 2>&1 || { echo "FAIL: gitleaks not installed"; exit 2; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
# Prints rc, then (on a finding) the rule ids, so a caller can require that the repo's OWN
# env-assignment rule is the one that fired — a widened allowlist on it cannot hide behind
# the vendor generic-api-key rule also matching 40 hex.
scan() { # $1 = value ; prints rc
  local d="$TMP/r.$RANDOM"; mkdir -p "$d"
  ( cd "$d" && git init -q && git config user.email t@example.invalid && git config user.name t \
    && printf 'MANDREL_%s=%s\n' "TOKEN" "$1" > app.env && git add app.env && git commit -qm fixture \
    && gitleaks detect --config "$CFG" --no-banner --redact -f json -r "$d.json" >/dev/null 2>&1 )
  local rc=$?
  echo "$rc"
  [ -s "$d.json" ] && grep -o '"RuleID": *"[^"]*"' "$d.json" | sort -u
  return 0
}
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS: $1 (rc=$3)"; else echo "FAIL: $1 expected rc=$2 got rc=$3"; fail=1; fi
}

hex="$(od -An -N20 -tx1 /dev/urandom | tr -d ' \n')"
[ "${#hex}" -eq 40 ] || { echo "FAIL: could not generate 40 hex chars"; exit 2; }
out="$(scan "$hex")"
check "40 random hex token is flagged" 1 "$(head -n1 <<<"$out")"
if grep -q 'mandrel-credential-env-assignment' <<<"$out"; then echo "PASS: flagged by mandrel-credential-env-assignment"
else echo "FAIL: mandrel-credential-env-assignment did not fire on the hex token"; fail=1; fi
check "placeholder example-token is allowed" 0 "$(scan "example-token" | head -n1)"
exit "$fail"

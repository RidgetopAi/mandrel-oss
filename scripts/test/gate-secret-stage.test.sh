#!/usr/bin/env bash
# gate-secret-stage.test.sh — scripts/oss-gate.sh STAGE S runs gitleaks with the SAME rules and
# arguments as .github/workflows/secrets.yml.
#   A. static: the gate's invocation uses the repo's .gitleaks.toml, scans history, is redacted, and
#      those values equal what the workflow passes. Checked on the real files, then on a MUTANT gate
#      with the config dropped (must FAIL), so the check cannot pass vacuously.
#   B. behavioral (throwaway clone): a credential-shaped fixture line committed on a scratch branch
#      turns `oss-gate.sh --secrets-only` RED; the unmutated control is GREEN.
# Fixture values are assembled at runtime so this file carries no literal of its own.
# Exit 0 = pass, 1 = fail.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/secrets.yml"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# --- A. static agreement ----------------------------------------------------------------------------
echo "== A. gate arguments match the workflow =="
# wf_arg <flag> — the value the workflow's `gitleaks detect` passes for <flag> (quotes stripped).
wf_arg() { tr '\\\n' '  ' <"$WORKFLOW" | grep -o -- "$1[= ]\"\?[^ \"]*" | head -n1 | sed -E "s/^$1[= ]\"?//"; }
wf_config="$(wf_arg --config)"; wf_logopts="$(wf_arg --log-opts)"
# gate_conf <config.sh> <var> — the value a gate config assigns to <var>.
gate_conf() { sed -n -E "s/^$2=\"([^\"]*)\".*/\1/p" "$1" | head -n1; }

# gate_matches <gate.sh> <config.sh> — every property the gate's secret stage must keep.
gate_matches() {
  local gate="$1" conf="$2" ok=0
  [[ -n "$wf_config" && -n "$wf_logopts" ]] || { echo "    workflow args unreadable (config='$wf_config' log-opts='$wf_logopts')"; return 1; }
  [[ "$(gate_conf "$conf" OSS_GATE_GITLEAKS_CONFIG)" == "$wf_config" ]] || { echo "    gate config != workflow --config $wf_config"; ok=1; }
  [[ "$(gate_conf "$conf" OSS_GATE_GITLEAKS_LOG_OPTS)" == "$wf_logopts" ]] || { echo "    gate log-opts != workflow --log-opts $wf_logopts"; ok=1; }
  # The history invocation: gitleaks detect, no --no-git, with --config "$OSS_GATE_GITLEAKS_CONFIG" and the log-opts var.
  local hist; hist="$(tr '\\\n' '  ' <"$gate" | grep -o 'clean gitleaks detect --redact[^>]*' | head -n1)"
  [[ -n "$hist" ]] || { echo "    no history-aware 'gitleaks detect' invocation in the gate"; return 1; }
  grep -q -- '--config "\$OSS_GATE_GITLEAKS_CONFIG"' <<<"$hist" || { echo "    history scan does not pass the repo config"; ok=1; }
  grep -q -- '--log-opts="\$OSS_GATE_GITLEAKS_LOG_OPTS"' <<<"$hist" || { echo "    history scan does not pass --log-opts"; ok=1; }
  grep -q -- '--redact' <<<"$hist" || { echo "    history scan is not redacted"; ok=1; }
  grep -q -- '--no-git' <<<"$hist" && { echo "    history scan uses --no-git"; ok=1; }
  # Every gitleaks run in the gate uses the repo config — none may fall back to the default ruleset.
  ! grep -q 'useDefault' "$gate" || { echo "    gate writes its own default-rules config"; ok=1; }
  [[ "$(grep -c -- '--config "\(\$ROOT/\)\?\$OSS_GATE_GITLEAKS_CONFIG"' "$gate")" -ge 2 ]] || { echo "    not every gitleaks scan passes the repo config"; ok=1; }
  return "$ok"
}
check "workflow passes a config and a history range ('$wf_config', '$wf_logopts')" test -n "$wf_config" -a -n "$wf_logopts"
check "workflow scan is redacted" grep -q -- '--redact' "$WORKFLOW"
check "gate secret stage == workflow arguments" gate_matches "$ROOT/scripts/oss-gate.sh" "$ROOT/scripts/oss-gate/config.sh"

# Mutants: each must make gate_matches FAIL.
sed 's|--config "\$OSS_GATE_GITLEAKS_CONFIG"||' "$ROOT/scripts/oss-gate.sh" >"$T/mut-noconfig.sh"
sed 's|--log-opts="\$OSS_GATE_GITLEAKS_LOG_OPTS"||' "$ROOT/scripts/oss-gate.sh" >"$T/mut-nohist.sh"
sed 's|^OSS_GATE_GITLEAKS_CONFIG=.*|OSS_GATE_GITLEAKS_CONFIG="other.toml"|' "$ROOT/scripts/oss-gate/config.sh" >"$T/mut-conf.sh"
if gate_matches "$T/mut-noconfig.sh" "$ROOT/scripts/oss-gate/config.sh" >/dev/null; then bad "MUTANT: dropping --config went undetected"; else ok "MUTANT: dropping --config from the gate is detected"; fi
if gate_matches "$T/mut-nohist.sh" "$ROOT/scripts/oss-gate/config.sh" >/dev/null; then bad "MUTANT: dropping --log-opts went undetected"; else ok "MUTANT: dropping history scanning is detected"; fi
if gate_matches "$ROOT/scripts/oss-gate.sh" "$T/mut-conf.sh" >/dev/null; then bad "MUTANT: a different config file went undetected"; else ok "MUTANT: a config differing from the workflow's is detected"; fi

# --- B. behavior on a throwaway clone ---------------------------------------------------------------
echo "== B. a fixture-shaped credential turns the gate's secret stage RED =="
if ! command -v gitleaks >/dev/null 2>&1; then bad "gitleaks not installed"; else
  git clone -q --no-hardlinks "$ROOT" "$T/clone" 2>/dev/null || { bad "could not clone"; }
  if [[ -d "$T/clone" ]]; then
    ( cd "$T/clone" && git config user.email t@example.invalid && git config user.name t \
      && git checkout -q -b scratch \
      && cp "$ROOT/scripts/oss-gate.sh" scripts/oss-gate.sh && cp "$ROOT/scripts/oss-gate/config.sh" scripts/oss-gate/config.sh \
      && cp "$ROOT/.gitleaks.toml" .gitleaks.toml \
      && git add -A && git commit -qm "overlay working-tree gate" --allow-empty )
    gate() { ( cd "$T/clone" && bash scripts/oss-gate.sh --secrets-only 2>&1 ); }
    out="$(gate)"; rc=$?
    check "control (no fixture line): secret stage GREEN" grep -q '^OSS-GATE GREEN' <<<"$out"
    # A NEW line assigning SUBQ_SECRET a value shaped like the old fixture (different digits, so not allowlisted).
    ( cd "$T/clone" && printf '%s_%s="%s-%s-%s"\n' SUBQ SECRET subq secret VALUE-0003 >>scripts/test/supersession-docs-install.test.sh \
      && git commit -qam "scratch: fixture-shaped assignment" )
    out="$(gate)"
    check "fixture-shaped SUBQ_SECRET line committed: secret stage RED" grep -q '^OSS-GATE RED — failed: S' <<<"$out"
    check "RED names the rule, not the value" grep -q 'mandrel-credential-env-assignment' <<<"$out"
    check "the value never reaches the output" bash -c '! grep -q "VALUE-0003" <<<"$1"' _ "$out"
    # The workflow's own scan agrees (so the gate really predicts CI).
    ( cd "$T/clone" && gitleaks detect --redact --no-banner --config .gitleaks.toml --log-opts="--all" >/dev/null 2>&1 ); wrc=$?
    check "the workflow's exact scan also fails on it (rc=$wrc)" test "$wrc" -eq 1
  fi
fi

echo "gate-secret-stage: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]

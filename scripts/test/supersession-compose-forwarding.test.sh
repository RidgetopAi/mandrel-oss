#!/usr/bin/env bash
# supersession-compose-forwarding.test.sh — the supersession settings docs/manual/supersession.md
# tells the user to put in .env actually reach the mcp-server container.
#  (1) docker-compose.yml's mcp-server environment maps SUBQ_API_KEY, ANTHROPIC_API_KEY and
#      MANDREL_BELIEF_DAILY_SPEND_CAP_USD from .env under the names the server reads, and does not
#      pin MANDREL_BELIEF_ENABLED to a fixed false (that would defeat the key-derived default).
#  (2) every variable the doc tells the user to set in .env (read from the doc: KEY=value lines in
#      its ```bash fences and inline `KEY=value` spans — never a hard-coded list) is forwarded.
# Env: COMPOSE_FILE / SUPERSESSION_DOC override the inputs (the critic's mutation runs).
# Exit: 0 pass · 1 a check failed · 2 could not measure.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE="${COMPOSE_FILE:-$ROOT/docker-compose.yml}"
DOC="${SUPERSESSION_DOC:-$ROOT/docs/manual/supersession.md}"
for f in "$COMPOSE" "$DOC"; do [[ -f "$f" ]] || { echo "  CANNOT MEASURE: missing $f"; exit 2; }; done
python3 -c 'import yaml' 2>/dev/null || { echo "  CANNOT MEASURE: python3 yaml module missing"; exit 2; }

exec python3 -I - "$COMPOSE" "$DOC" <<'PYEOF'
import re
import sys
import yaml

compose_path, doc_path = sys.argv[1], sys.argv[2]
fails = 0


def check(desc, cond):
    global fails
    print(f"  [{'PASS' if cond else 'FAIL'}] {desc}")
    if not cond:
        fails += 1


with open(compose_path) as fh:
    env = yaml.safe_load(fh)["services"]["mcp-server"].get("environment", {})
if isinstance(env, list):
    env = {e.split("=", 1)[0]: (e.split("=", 1)[1] if "=" in e else None) for e in env}

REF = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-[^}]*)?\}$")


def source_of(key):
    """The .env variable a container variable is filled from (None = not forwarded)."""
    if key not in env:
        return None
    val = env[key]
    if val is None:
        return key  # bare pass-through
    m = REF.match(str(val))
    return m.group(1) if m else None


# --- (1) the three named mappings, and the master switch ------------------------------------------
for key in ("SUBQ_API_KEY", "ANTHROPIC_API_KEY", "MANDREL_BELIEF_DAILY_SPEND_CAP_USD"):
    check(f"mcp-server {key} is filled from .env {key}", source_of(key) == key)
en = env.get("MANDREL_BELIEF_ENABLED", None)
fixed = en is not None and not str(en).startswith("${")
default_false = en is not None and re.search(r":?-\s*(false|0|no|off)\s*\}", str(en), re.I) is not None
check("MANDREL_BELIEF_ENABLED is not set to a fixed false", not fixed and not default_false)
check("MANDREL_BELIEF_ENABLED is still forwardable when the user sets it",
      "MANDREL_BELIEF_ENABLED" in env and (en is None or source_of("MANDREL_BELIEF_ENABLED") == "MANDREL_BELIEF_ENABLED"))

# --- (2) every variable the doc tells the user to set in .env is forwarded --------------------------
doc = open(doc_path).read()
wanted = set()
KV = re.compile(r"^\s*([A-Z][A-Z0-9_]*)=")
for m in re.finditer(r"```(\w*)\n(.*?)```", doc, re.S):
    if m.group(1) in ("bash", "sh", "env", ""):
        for line in m.group(2).splitlines():
            k = KV.match(line)
            if k:
                wanted.add(k.group(1))
prose = re.sub(r"```.*?```", "", doc, flags=re.S)
for m in re.finditer(r"`([A-Z][A-Z0-9_]*)=[^`]*`", prose):
    wanted.add(m.group(1))
# Supersession variables only: the server's MANDREL_BELIEF_* settings and the provider API keys.
# (Other names in the doc, e.g. OLLAMA_HOST, are settings of a different program on the host.)
wanted = {k for k in wanted if k.startswith("MANDREL_BELIEF_") or k.endswith("_API_KEY")}
print(f"  doc names {len(wanted)} variable(s) to set in .env: {', '.join(sorted(wanted))}")
check("the doc yields a non-empty variable list (a parser that finds nothing must not pass)", len(wanted) >= 4)
for key in sorted(wanted):
    check(f"doc variable {key} is forwarded to mcp-server by docker-compose.yml", source_of(key) == key)

print(f"supersession-compose-forwarding: {'%d check(s) FAILED' % fails if fails else 'all checks passed'}")
sys.exit(1 if fails else 0)
PYEOF

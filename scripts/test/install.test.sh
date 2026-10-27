#!/usr/bin/env bash
# install.test.sh — drives ./install.sh and scripts/validate-install.sh in a FRESH copy of the
# checkout against a recording container-runtime fake written here (no real docker, no network).
# Covers: .env creation/mode/idempotence, runtime-absent and unhealthy-service failures,
# the printed connect block, validate-install's no-host-psql rule and mock-embeddings failure,
# and the host-port preflight (section 7: a REAL listener holds a port; the fake prints a real
# `compose config` render, scripts/test/fixtures/install-compose-config.yml).
# Exit: 0 pass · 1 a check failed · 2 could not measure.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_INSTALL="${INSTALL_SH:-$REPO_DIR/install.sh}"
SRC_VALIDATE="${VALIDATE_SH:-$REPO_DIR/scripts/validate-install.sh}"
RENDER_FIXTURE="$REPO_DIR/scripts/test/fixtures/install-compose-config.yml"
for f in "$SRC_INSTALL" "$SRC_VALIDATE" "$REPO_DIR/.env.example" "$RENDER_FIXTURE"; do
  [[ -f "$f" ]] || { echo "  CANNOT MEASURE: missing $f"; exit 2; }
done

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
FAILS=0
ok()   { printf '  [PASS] %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { local d="$1"; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

# --- the fake runtime ------------------------------------------------------------------------------
BIN="$T/bin"; mkdir -p "$BIN"
cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
case "$1 $2" in
  "compose version") exit 0 ;;
  "compose up") echo "REV=${MANDREL_IMAGE_REVISION:-}" >>"$FAKE_LOG"; exit 0 ;;
  "compose config")
    [[ "${3:-}" == "--services" ]] && { printf 'postgres\nredis\nmcp-server\n'; exit 0; }
    # The real render, with the host ports this run asks for; FAKE_PORT_PG empty = no published line.
    if [[ -z "${FAKE_PORT_PG:-}" ]]; then pgsed='/published: "@PG@"/d'; else pgsed="s/@PG@/${FAKE_PORT_PG}/"; fi
    [[ -n "${FAKE_NO_FIXED:-}" ]] && pgsed='/published: /d'
    sed -e "s/@MCP@/${FAKE_PORT_MCP:-8080}/" -e "s/@BACKEND@/${FAKE_PORT_BACKEND:-5000}/" \
        -e "s/@FRONTEND@/${FAKE_PORT_FRONTEND:-3000}/" -e "$pgsed" "$FAKE_RENDER"
    exit 0 ;;
  "compose port") [[ -n "${FAKE_OWN:-}" && "$3:$4" == "${FAKE_OWN%%=*}" ]] && echo "127.0.0.1:${FAKE_OWN#*=}"; exit 0 ;;
  "compose ps") echo "cid-${@: -1}"; exit 0 ;;
  "compose exec")
    shift 2; [[ "$1" == "-T" ]] && shift
    ADMIN_ENV=()
    while [[ "$1" == "-e" ]]; do ADMIN_ENV+=("$2"); shift 2; done
    svc="$1"; shift
    if [[ "$svc" == "mandrel-command-backend" && "$1" == "node" ]]; then
      # record what the real exec would receive; the password itself goes to its own file
      echo "ADMIN-CREATE script=$2 user=${ADMIN_USERNAME:-} envnames=${ADMIN_ENV[*]}" >>"$FAKE_LOG"
      printf '%s' "${ADMIN_PASSWORD:-}" >>"$FAKE_ADMIN_PW_LOG"
      [[ -n "${FAKE_ADMIN_FAIL:-}" ]] && { echo "boom" >&2; exit 1; }
      exit 0
    fi
    case "$1" in
      pg_isready) exit 0 ;;
      psql) echo 1; exit 0 ;;
      redis-cli) echo PONG; exit 0 ;;
      wget) printf '{"status":"healthy","version":"1.0.0","embeddings":"%s"}\n' "${FAKE_EMBEDDINGS:-real}"; exit 0 ;;
    esac ;;
esac
case "$1" in
  info) exit 0 ;;
  inspect) [[ "${@: -1}" == "cid-${FAKE_UNHEALTHY:-none}" ]] && echo unhealthy || echo healthy; exit 0 ;;
esac
exit 0
FAKE
cat >"$BIN/psql" <<'FAKE'
#!/usr/bin/env bash
echo "HOST-PSQL $*" >>"$FAKE_LOG"; exit 0
FAKE
chmod +x "$BIN"/*
# A PATH with the tools install.sh needs but NO container runtime.
NODOCKER="$T/nodocker"; mkdir -p "$NODOCKER"
for t in bash env dirname grep cut tail head awk mktemp chmod cp tr od cat rm sleep sed date openssl id git printf; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$NODOCKER/$t"
done

fresh() { # fresh <name> -> path of a fresh checkout copy
  local d="$T/$1"; mkdir -p "$d/scripts"
  cp "$SRC_INSTALL" "$d/install.sh"; cp "$SRC_VALIDATE" "$d/scripts/validate-install.sh"
  cp "$REPO_DIR/.env.example" "$d/.env.example"; chmod +x "$d/install.sh"
  echo "$d"
}
run() { # run <dir> <path> [VAR=val...] — captures $OUT and $RC
  local d="$1" p="$2"; shift 2
  # MANDREL_SKIP_PORT_CHECK=1: sections 1-6 must not depend on which ports this host has busy;
  # section 7 turns the check back on (=0) against ports it controls.
  OUT="$(cd "$d" && env -i HOME="$T" PATH="$p" FAKE_LOG="$d/fake.log" FAKE_ADMIN_PW_LOG="$d/adminpw.log" FAKE_RENDER="$RENDER_FIXTURE" USER="${FAKE_USER:-tester}" MANDREL_INSTALL_TIMEOUT=2 MANDREL_INSTALL_POLL=1 MANDREL_SKIP_PORT_CHECK=1 "$@" ./install.sh 2>&1)"; RC=$?
}
getv() { grep -E "^$2=" "$1/.env" | tail -n1 | cut -d= -f2-; }

# --- (1) .env generation + idempotence --------------------------------------------------------------
A="$(fresh a)"; run "$A" "$BIN:$NODOCKER"
check "install succeeds against the fake runtime (rc=$RC)" test "$RC" -eq 0
check ".env created with mode 600" test "$(stat -c %a "$A/.env" 2>/dev/null)" = 600
check "POSTGRES_PASSWORD non-empty" test -n "$(getv "$A" POSTGRES_PASSWORD)"
check "MCP_AUTH_TOKEN is >=32 hex chars" bash -c '[[ "$1" =~ ^[0-9a-f]{32,}$ ]]' _ "$(getv "$A" MCP_AUTH_TOKEN)"
check "MCP_ALLOWED_HOSTS set" test -n "$(getv "$A" MCP_ALLOWED_HOSTS)"
check "MCP on the default 8080: MCP_ALLOWED_HOSTS is the first-run default" test "$(getv "$A" MCP_ALLOWED_HOSTS)" = "localhost,127.0.0.1"
check "compose up was issued" grep -q '^docker compose up' "$A/fake.log"
P1="$(getv "$A" POSTGRES_PASSWORD)"; K1="$(getv "$A" MCP_AUTH_TOKEN)"
run "$A" "$BIN:$NODOCKER"
check "second run keeps POSTGRES_PASSWORD" test "$(getv "$A" POSTGRES_PASSWORD)" = "$P1"
check "second run keeps MCP_AUTH_TOKEN" test "$(getv "$A" MCP_AUTH_TOKEN)" = "$K1"
check "second run leaves one POSTGRES_PASSWORD line" test "$(grep -c '^POSTGRES_PASSWORD=' "$A/.env")" -eq 1
check "mode still 600 after re-run" test "$(stat -c %a "$A/.env")" = 600

# --- (2) failure modes ------------------------------------------------------------------------------
B="$(fresh b)"; run "$B" "$NODOCKER"
check "runtime absent: exits non-zero" test "$RC" -ne 0
check "runtime absent: prints the install link" grep -q 'https://docs.docker.com/engine/install' <<<"$OUT"
check "runtime absent: prints the macOS Docker Desktop link" grep -q 'https://docs.docker.com/desktop/setup/install/mac-install/' <<<"$OUT"
check "runtime absent: labels each link by OS" bash -c 'grep -q "Linux" <<<"$1" && grep -q "macOS" <<<"$1"' _ "$OUT"
check "runtime absent: no .env side effects" test ! -e "$B/.env"
C="$(fresh c)"; run "$C" "$BIN:$NODOCKER" FAKE_UNHEALTHY=redis
check "unhealthy service: exits non-zero" test "$RC" -ne 0
check "unhealthy service: names the service" grep -q 'service "redis" is not healthy' <<<"$OUT"
check "unhealthy service: names the logs command" grep -q 'docker compose logs redis' <<<"$OUT"
check "unhealthy service: does not claim success" bash -c '! grep -q "Mandrel is running" <<<"$1"' _ "$OUT"

# --- (3) success output + validator -----------------------------------------------------------------
TOK="$(getv "$A" MCP_AUTH_TOKEN)"
run "$A" "$BIN:$NODOCKER"
check "prints the MCP endpoint" grep -q 'http://localhost:8080/mcp' <<<"$OUT"
check "prints the dashboard URL" grep -q 'http://localhost:3000' <<<"$OUT"
check "prints a client config block containing the token" grep -q "Bearer $TOK" <<<"$OUT"
check "prints a JSON mcpServers block" grep -q '"mcpServers"' <<<"$OUT"
check "validator ran no host psql" bash -c '! grep -q HOST-PSQL "$1"' _ "$A/fake.log"
check "validator exec'd psql inside the container" grep -q 'compose exec -T postgres psql' "$A/fake.log"
check "install output does not leak the DB password" bash -c '! grep -q "$1" <<<"$2"' _ "$(getv "$A" POSTGRES_PASSWORD)" "$OUT"

M="$T/m.out"
( cd "$A" && env -i HOME="$T" PATH="$BIN:$NODOCKER" FAKE_LOG="$A/fake.log" FAKE_EMBEDDINGS=mock bash scripts/validate-install.sh ) >"$M" 2>&1; RC=$?
check "validator exits non-zero on mock embeddings" test "$RC" -ne 0
check "validator names the mock embeddings" grep -qi 'MOCK embeddings' "$M"
( cd "$A" && env -i HOME="$T" PATH="$BIN:$NODOCKER" FAKE_LOG="$A/fake.log" bash scripts/validate-install.sh ) >"$M" 2>&1; RC=$?
check "validator exits 0 on real embeddings" test "$RC" -eq 0
D="$(fresh d)"; run "$D" "$BIN:$NODOCKER" FAKE_EMBEDDINGS=mock
check "install.sh exits non-zero when the server reports mock embeddings" test "$RC" -ne 0

# --- (4) every printed client config carries Authorization AND X-Actor-ID -----------
run "$A" "$BIN:$NODOCKER"
check "prints the claude mcp add snippet" grep -q 'claude mcp add' <<<"$OUT"
check "claude mcp add line has Authorization and X-Actor-ID" bash -c 'grep "claude mcp add" <<<"$1" | grep -q "Authorization: Bearer" && grep "claude mcp add" <<<"$1" | grep -q "X-Actor-ID: tester"' _ "$OUT"
check "JSON block has an X-Actor-ID header" grep -q '"X-Actor-ID": "tester"' <<<"$OUT"
SNIPPETS="$(grep -c 'Authorization' <<<"$OUT")"; ACTORS="$(grep -c 'X-Actor-ID' <<<"$OUT")"
check "every snippet with Authorization has X-Actor-ID ($SNIPPETS vs $ACTORS)" bash -c '[[ "$1" -ge 2 && "$2" -ge "$1" ]]' _ "$SNIPPETS" "$ACTORS"
run "$A" "$BIN:$NODOCKER" MANDREL_ACTOR_ID=alice
check "MANDREL_ACTOR_ID overrides the default actor" grep -q '"X-Actor-ID": "alice"' <<<"$OUT"

# --- (5) dashboard admin: generated once, printed, created via the backend ----------
E="$(fresh e)"; run "$E" "$BIN:$NODOCKER"
PW1="$(getv "$E" DASHBOARD_ADMIN_PASSWORD)"
check "first run writes DASHBOARD_ADMIN_PASSWORD (>=24 hex) into .env" bash -c '[[ "$1" =~ ^[0-9a-f]{24,}$ ]]' _ "$PW1"
check ".env still mode 600" test "$(stat -c %a "$E/.env")" = 600
check "prints the admin username" grep -q 'username admin ' <<<"$OUT"
check "prints the admin password" grep -qF "password $PW1" <<<"$OUT"
check "prints the dashboard URL with the login" grep -q 'Dashboard    : http://localhost:3000' <<<"$OUT"
check "admin created via the backend's node script, not psql" grep -q 'ADMIN-CREATE script=dist/scripts/createAdmin.js user=admin envnames=ADMIN_USERNAME ADMIN_PASSWORD' "$E/fake.log"
check "install.sh has no admin_users SQL" bash -c '! grep -qi "admin_users" "$1"' _ "$SRC_INSTALL"
check "the exec received the generated password" test "$(cat "$E/adminpw.log")" = "$PW1"
check "password is not on any docker command line" bash -c '! grep -qF "$1" "$2"' _ "$PW1" "$E/fake.log"
run "$E" "$BIN:$NODOCKER"
check "second run keeps the same password in .env" test "$(getv "$E" DASHBOARD_ADMIN_PASSWORD)" = "$PW1"
check "second run prints the same password" grep -qF "password $PW1" <<<"$OUT"
check "second run leaves one DASHBOARD_ADMIN_PASSWORD line" test "$(grep -c '^DASHBOARD_ADMIN_PASSWORD=' "$E/.env")" -eq 1
F="$(fresh f)"; run "$F" "$BIN:$NODOCKER" FAKE_ADMIN_FAIL=1
check "admin creation failure fails the install" test "$RC" -ne 0
check "admin creation failure does not claim success" bash -c '! grep -q "Mandrel is running" <<<"$1"' _ "$OUT"

# --- (6) the image build carries the git revision ------------------------------------
G="$(fresh g)"; ( cd "$G" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x ) 
REV="$(git -C "$G" rev-parse HEAD)"
run "$G" "$BIN:$NODOCKER:$(dirname "$(command -v git)")"
check "revision reaches compose up as MANDREL_IMAGE_REVISION" grep -q "^REV=$REV" "$G/fake.log"
H="$(fresh h)"; run "$H" "$BIN:$NODOCKER"
check "no git checkout: revision left empty" grep -q '^REV=$' "$H/fake.log"
check "compose passes MANDREL_IMAGE_REVISION to the mcp-server build" grep -q 'MANDREL_IMAGE_REVISION: "${MANDREL_IMAGE_REVISION:-}"' "$REPO_DIR/docker-compose.yml"
check "compose has no top-level version key" bash -c '! grep -qE "^version:" "$1"' _ "$REPO_DIR/docker-compose.yml"
check "compose: PostgreSQL has no fixed host port by default" grep -qF '"127.0.0.1:${MANDREL_POSTGRES_HOST_PORT:-${TENANT_PG_PORT:-}}:5432"' "$REPO_DIR/docker-compose.yml"
check "compose: Redis has no fixed host port by default" grep -qF '"127.0.0.1:${MANDREL_REDIS_HOST_PORT:-${TENANT_REDIS_PORT:-}}:6379"' "$REPO_DIR/docker-compose.yml"
check "compose defaults MANDREL_TOOL_SURFACE to gateway" grep -q 'MANDREL_TOOL_SURFACE:-gateway' "$REPO_DIR/docker-compose.yml"
check ".env.example sets MANDREL_TOOL_SURFACE=gateway" grep -qx 'MANDREL_TOOL_SURFACE=gateway' "$REPO_DIR/.env.example"

# --- (7) host-port preflight: a busy port stops the install BEFORE compose up ---------------
# A REAL listener holds the port (python3, the gate's own dependency); the fake runtime renders
# the stack with that port published, exactly as `compose config` would.
command -v python3 >/dev/null 2>&1 || { echo "  CANNOT MEASURE: python3 is needed to hold a port open"; exit 2; }
free_ports() { python3 -c 'import socket
ss = [socket.socket() for _ in range(4)]
for s in ss: s.bind(("127.0.0.1", 0))
print(" ".join(str(s.getsockname()[1]) for s in ss))'; }
read -r FP_MCP FP_BACKEND FP_FRONTEND FP_PG <<<"$(free_ports)"
[[ "$FP_MCP" =~ ^[0-9]+$ && "$FP_PG" =~ ^[0-9]+$ ]] || { echo "  CANNOT MEASURE: could not pick free ports"; exit 2; }
python3 -c 'import socket, sys, time
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(8)
open(sys.argv[1], "w").write(str(s.getsockname()[1])); time.sleep(300)' "$T/busy.port" &
LISTENER=$!
trap 'kill "$LISTENER" 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 50); do [[ -s "$T/busy.port" ]] && break; sleep 0.1; done
BUSY="$(cat "$T/busy.port" 2>/dev/null)"
[[ "$BUSY" =~ ^[0-9]+$ ]] || { echo "  CANNOT MEASURE: the listener did not start"; exit 2; }
( exec 3<>"/dev/tcp/127.0.0.1/$BUSY" ) 2>/dev/null || { echo "  CANNOT MEASURE: port $BUSY is not accepting connections"; exit 2; }
PORTS_FREE=(MANDREL_SKIP_PORT_CHECK=0 FAKE_PORT_MCP="$FP_MCP" FAKE_PORT_BACKEND="$FP_BACKEND" FAKE_PORT_FRONTEND="$FP_FRONTEND")

P="$(fresh p)"; run "$P" "$BIN:$NODOCKER" "${PORTS_FREE[@]}" FAKE_PORT_MCP="$BUSY"
check "busy MCP port: exits 1 (rc=$RC)" test "$RC" -eq 1
check "busy MCP port: names the port and the service" grep -q "host port $BUSY (127.0.0.1) is already in use; Mandrel's mcp-server service needs it" <<<"$OUT"
check "busy MCP port: names the .env line that moves it" grep -qE "^      MANDREL_MCP_HOST_PORT=[0-9]+\$" <<<"$OUT"
check "busy MCP port: names the .env file" grep -qF "add this line to $P/.env" <<<"$OUT"
check "busy MCP port: compose up was NEVER issued" bash -c '! grep -q "^docker compose up" "$1"' _ "$P/fake.log"
check "busy MCP port: does not claim success" bash -c '! grep -q "Mandrel is running" <<<"$1"' _ "$OUT"
check "busy MCP port: names the MANDREL_SKIP_PORT_CHECK=1 escape" grep -qF "MANDREL_SKIP_PORT_CHECK=1 ./install.sh" <<<"$OUT"
check "busy MCP port: the free ports are not reported" bash -c '! grep -qE "host port ($2|$3) " <<<"$1"' _ "$OUT" "$FP_BACKEND" "$FP_FRONTEND"

Q="$(fresh q)"; run "$Q" "$BIN:$NODOCKER" "${PORTS_FREE[@]}"
check "all ports free: install proceeds (rc=$RC)" test "$RC" -eq 0
check "all ports free: says how many it checked" grep -q "Host ports free (3 checked)" <<<"$OUT"
check "all ports free: compose up was issued" grep -q '^docker compose up' "$Q/fake.log"
check "printed MCP endpoint follows the published port" grep -q "MCP endpoint : http://localhost:$FP_MCP/mcp" <<<"$OUT"
check "printed dashboard URL follows the published port" grep -q "Dashboard    : http://localhost:$FP_FRONTEND\$" <<<"$OUT"
check "PostgreSQL with no published port is not checked" bash -c '! grep -q "postgres service" <<<"$1"' _ "$OUT"
AH="$(getv "$Q" MCP_ALLOWED_HOSTS)"
check "moved MCP port is added to MCP_ALLOWED_HOSTS (got: $AH)" test "$AH" = "localhost,127.0.0.1,localhost:$FP_MCP,127.0.0.1:$FP_MCP"
check "and the install says so" grep -q "Added localhost:$FP_MCP,127.0.0.1:$FP_MCP to MCP_ALLOWED_HOSTS" <<<"$OUT"
run "$Q" "$BIN:$NODOCKER" "${PORTS_FREE[@]}" FAKE_OWN="mcp-server:8080=$FP_MCP"
check "re-run leaves MCP_ALLOWED_HOSTS as it was, on one line" bash -c '[[ "$(grep -c "^MCP_ALLOWED_HOSTS=" "$1")" -eq 1 && "$(grep "^MCP_ALLOWED_HOSTS=" "$1")" == "MCP_ALLOWED_HOSTS=$2" ]]' _ "$Q/.env" "$AH"

R="$(fresh r)"; run "$R" "$BIN:$NODOCKER" "${PORTS_FREE[@]}" FAKE_PORT_PG="$BUSY"
check "opted-in PostgreSQL port busy: exits 1" test "$RC" -eq 1
check "opted-in PostgreSQL port busy: names postgres and MANDREL_POSTGRES_HOST_PORT" bash -c 'grep -q "postgres service needs it" <<<"$1" && grep -qE "^      MANDREL_POSTGRES_HOST_PORT=[0-9]+\$" <<<"$1"' _ "$OUT"

S="$(fresh s)"; run "$S" "$BIN:$NODOCKER" "${PORTS_FREE[@]}" FAKE_PORT_MCP="$BUSY" FAKE_OWN="mcp-server:8080=$BUSY"
check "re-run: a port this stack's own container holds is not a conflict (rc=$RC)" test "$RC" -eq 0

V="$(fresh v)"; run "$V" "$BIN:$NODOCKER" "${PORTS_FREE[@]}" FAKE_NO_FIXED=1
check "no fixed host port at all (empty population): proceeds and says it checked nothing" bash -c '[[ "$2" -eq 0 ]] && grep -q "no fixed host port found" <<<"$1"' _ "$OUT" "$RC"

U="$(fresh u)"; run "$U" "$BIN:$NODOCKER" "${PORTS_FREE[@]}" FAKE_PORT_MCP="$BUSY" MANDREL_SKIP_PORT_CHECK=1
check "MANDREL_SKIP_PORT_CHECK=1 skips the check and says so" bash -c '[[ "$2" -eq 0 ]] && grep -q "Skipping the host port check" <<<"$1"' _ "$OUT" "$RC"

# Every knob install.sh names is a host-port variable docker-compose.yml reads and .env.example
# documents — the two copies of the name cannot drift apart unnoticed.
KNOBS="$(sed -n 's/^PORT_KNOBS="\(.*\)"$/\1/p' "$SRC_INSTALL")"
check "install.sh declares five port knobs" test "$(wc -w <<<"$KNOBS")" -eq 5
for kv in $KNOBS; do
  check "docker-compose.yml reads ${kv#*=} (the ${kv%%=*} host port)" grep -qF "\${${kv#*=}:-" "$REPO_DIR/docker-compose.yml"
  check ".env.example documents ${kv#*=}" grep -qE "^#? ?${kv#*=}=" "$REPO_DIR/.env.example"
done

echo
if (( FAILS == 0 )); then echo "install.test.sh: all checks passed"; exit 0; fi
echo "install.test.sh: $FAILS check(s) FAILED"; exit 1

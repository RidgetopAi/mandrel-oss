#!/usr/bin/env bash
# install.sh — the ONE supported Mandrel install: the full container stack.
#
#   git clone <this repository> mandrel-oss && cd mandrel-oss && ./install.sh
#
# What it does, in order:
#   1. checks the container runtime and its compose plugin are present and usable
#   2. creates .env (mode 600) on first run with a generated POSTGRES_PASSWORD and
#      MCP_AUTH_TOKEN and MCP_ALLOWED_HOSTS; a re-run keeps every existing value
#      and, for the dashboard, DASHBOARD_ADMIN_PASSWORD (generated once, never regenerated)
#   2b. checks every host port the stack will publish is free BEFORE starting anything; a busy
#      one fails with the port, the service and the exact .env line that moves it. A moved MCP
#      port is added to MCP_ALLOWED_HOSTS (the server checks the Host header, port included)
#   3. brings the stack up from docker-compose.yml and waits until every service is healthy
#   4. runs scripts/validate-install.sh
#   4b. creates the dashboard admin user (through the dashboard backend's own user model)
#   4c. prints which supersession mode the server will really run (from the rendered compose environment), and the daily spend cap
#   5. prints the MCP endpoint, the dashboard URL and its login, and Claude Code MCP config
#      snippets carrying both Authorization and X-Actor-ID headers
#
# Tunables (environment):
#   MANDREL_INSTALL_TIMEOUT   seconds to wait for every service to be healthy   (default 900)
#   MANDREL_INSTALL_POLL      seconds between health polls                      (default 5)
#   MANDREL_ALLOWED_HOSTS_DEFAULT  value written to MCP_ALLOWED_HOSTS on first run (default localhost,127.0.0.1)
#   MANDREL_MCP_URL / MANDREL_DASHBOARD_URL  what is printed (default: localhost and the host port
#                             the stack publishes, e.g. http://localhost:8080/mcp and :3000)
#   MANDREL_SKIP_PORT_CHECK   1 skips step 2b (only if it reports a port busy that compose can bind)
#   MANDREL_ACTOR_ID          X-Actor-ID in the printed config  (default: .env MANDREL_ACTOR_ID, else your login name)
#   DASHBOARD_ADMIN_USERNAME  dashboard admin login             (default admin; .env value wins)
#   MANDREL_RUNTIME           the container CLI                                 (default docker)
#
# Exit codes: 0 installed and validated · 1 failed (the message names why) · 2 bad usage
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

RUNTIME="${MANDREL_RUNTIME:-docker}"
TIMEOUT="${MANDREL_INSTALL_TIMEOUT:-900}"
POLL="${MANDREL_INSTALL_POLL:-5}"
ALLOWED_HOSTS_DEFAULT="${MANDREL_ALLOWED_HOSTS_DEFAULT:-localhost,127.0.0.1}"
# Filled from the rendered stack in main() unless set here (see print_connect).
MCP_URL="${MANDREL_MCP_URL:-}"
DASHBOARD_URL="${MANDREL_DASHBOARD_URL:-}"
ENV_FILE="$ROOT/.env"
ADMIN_USERNAME_DEFAULT="${DASHBOARD_ADMIN_USERNAME:-admin}"
DOCKER_INSTALL_URL="https://docs.docker.com/engine/install/"
DOCKER_MAC_INSTALL_URL="https://docs.docker.com/desktop/setup/install/mac-install/"
DOCKER_POST_INSTALL_URL="https://docs.docker.com/engine/install/linux-postinstall/"

say()  { printf '%s\n' "$*"; }
die()  { printf 'install.sh: ERROR: %s\n' "$*" >&2; exit 1; }
dc()   { "$RUNTIME" compose "$@"; }

[[ $# -eq 0 ]] || { say "usage: ./install.sh   (tunables are environment variables; see the header)" >&2; exit 2; }
[[ "$TIMEOUT" =~ ^[0-9]+$ && "$POLL" =~ ^[1-9][0-9]*$ ]] || die "MANDREL_INSTALL_TIMEOUT / MANDREL_INSTALL_POLL must be positive integers"

# --- 1. container runtime ----------------------------------------------------------------------
check_runtime() {
  if ! command -v "$RUNTIME" >/dev/null 2>&1; then
    die "'$RUNTIME' was not found on PATH. Install a container runtime with compose — Linux (Docker Engine): $DOCKER_INSTALL_URL ; macOS (Docker Desktop): $DOCKER_MAC_INSTALL_URL"
  fi
  if ! dc version >/dev/null 2>&1; then
    die "'$RUNTIME compose' is not available. Install the Docker Compose plugin: $DOCKER_INSTALL_URL"
  fi
  if ! "$RUNTIME" info >/dev/null 2>&1; then
    die "'$RUNTIME' is installed but this user cannot use it (daemon stopped, or no permission). Start Docker; on Linux add yourself to the docker group — sudo usermod -aG docker \"\$USER\" — then log out and back in ($DOCKER_POST_INSTALL_URL)"
  fi
}

# --- 2. .env -----------------------------------------------------------------------------------
rand_hex() { # rand_hex <bytes>
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; fi
}

env_get() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-; }

# env_ensure KEY VALUE — set KEY only when it is absent or empty; an existing value is never touched.
env_ensure() {
  local key="$1" value="$2" tmp
  [[ -n "$(env_get "$key")" ]] && return 0
  if grep -qE "^$key=" "$ENV_FILE"; then
    tmp="$(mktemp "$ROOT/.env.XXXXXX")" || die "cannot create a temp file in $ROOT"
    awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" && !done {print k"="v; done=1; next} {print}' "$ENV_FILE" >"$tmp"
    cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

# env_set KEY VALUE — overwrite the LAST KEY= line (the one env_get and compose read), or append.
env_set() {
  local key="$1" value="$2" tmp
  if grep -qE "^$key=" "$ENV_FILE"; then
    tmp="$(mktemp "$ROOT/.env.XXXXXX")" || die "cannot create a temp file in $ROOT"
    awk -v k="$key" -v v="$value" 'NR == FNR { if ($0 ~ "^"k"=") last = FNR; next }
      FNR == last { print k"="v; next } { print }' "$ENV_FILE" "$ENV_FILE" >"$tmp"
    cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

prepare_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$ROOT/.env.example" ]] || die ".env.example is missing from $ROOT — is this a complete checkout?"
    (umask 077; cp "$ROOT/.env.example" "$ENV_FILE") || die "cannot create $ENV_FILE"
    say "Created .env from .env.example"
  else
    say "Keeping existing .env (only empty required values are filled in)"
  fi
  chmod 600 "$ENV_FILE" || die "cannot set mode 600 on $ENV_FILE"
  env_ensure POSTGRES_PASSWORD "$(rand_hex 24)"
  env_ensure MCP_AUTH_TOKEN "$(rand_hex 32)"
  env_ensure MCP_ALLOWED_HOSTS "$ALLOWED_HOSTS_DEFAULT"
  env_ensure DASHBOARD_ADMIN_USERNAME "$ADMIN_USERNAME_DEFAULT"
  env_ensure DASHBOARD_ADMIN_PASSWORD "$(rand_hex 12)"
  [[ -n "$(env_get POSTGRES_PASSWORD)" && -n "$(env_get MCP_AUTH_TOKEN)" ]] || die "could not generate secrets into $ENV_FILE"
  [[ -n "$(env_get DASHBOARD_ADMIN_PASSWORD)" ]] || die "could not generate the dashboard admin password into $ENV_FILE"
}

# The git revision the image is built from, so /health reads <semver>+<sha12>. Left unset (and
# the version reads +unknown) when this is not a git checkout.
export_revision() {
  [[ -n "${MANDREL_IMAGE_REVISION:-}" ]] && { export MANDREL_IMAGE_REVISION; return 0; }
  command -v git >/dev/null 2>&1 || return 0
  local rev; rev="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || return 0
  [[ "$rev" =~ ^[0-9a-f]{40}$ ]] && export MANDREL_IMAGE_REVISION="$rev"
  return 0
}

# actor_id — what the printed config sends as X-Actor-ID.
actor_id() {
  local a; a="$(env_get MANDREL_ACTOR_ID)"
  [[ -n "$a" ]] || a="${MANDREL_ACTOR_ID:-}"
  [[ -n "$a" ]] || a="${USER:-${LOGNAME:-$(id -un 2>/dev/null)}}"
  printf '%s' "${a:-mandrel-user}"
}

# create_admin — create the dashboard admin via the backend's own user model; idempotent.
create_admin() {
  local out
  out="$(ADMIN_USERNAME="$(env_get DASHBOARD_ADMIN_USERNAME)" ADMIN_PASSWORD="$(env_get DASHBOARD_ADMIN_PASSWORD)" \
    dc exec -T -e ADMIN_USERNAME -e ADMIN_PASSWORD mandrel-command-backend node dist/scripts/createAdmin.js 2>&1)" \
    || die "creating the dashboard admin user failed: $out"
}

# --- 2b. host ports ----------------------------------------------------------------------------
# The .env name that moves each service's host port (docker-compose.yml "Host ports" header).
PORT_KNOBS="postgres=MANDREL_POSTGRES_HOST_PORT redis=MANDREL_REDIS_HOST_PORT mcp-server=MANDREL_MCP_HOST_PORT mandrel-command-backend=MANDREL_DASHBOARD_API_HOST_PORT mandrel-command-frontend=MANDREL_DASHBOARD_HOST_PORT"
RENDERED_PORTS=""   # "<service> <host_ip> <host port> <container port>" per fixed host port

port_knob() { local kv; for kv in $PORT_KNOBS; do [[ "${kv%%=*}" == "$1" ]] && { printf '%s' "${kv#*=}"; return 0; }; done; return 1; }

# published_ports — reads `compose config` output on stdin and prints one row per port with a
# FIXED host port. A port with no published value gets a random free one from Docker (PostgreSQL
# and Redis, by default) and cannot collide, so it is not a row.
published_ports() {
  awk '
    function parse(kv,   i, k, v) {
      i = index(kv, ":"); k = substr(kv, 1, i - 1); v = substr(kv, i + 1)
      sub(/^[ ]+/, "", v); gsub(/"/, "", v)
      if (k == "host_ip") ip = v; else if (k == "published") pub = v; else if (k == "target") tgt = v
    }
    function flush() {
      if (pub ~ /^[0-9]+$/) print svc, (ip == "" ? "0.0.0.0" : ip), pub, tgt
      ip = ""; pub = ""; tgt = ""
    }
    /^[^ #]/                  { flush(); in_svcs = ($0 ~ /^services:/); svc = ""; in_ports = 0; next }
    in_svcs && /^  [^ ]/      { flush(); svc = $1; sub(/:$/, "", svc); in_ports = 0; next }
    svc != "" && /^    [^ ]/  { flush(); in_ports = ($0 ~ /^    ports:[ ]*$/); next }
    in_ports && /^      - /   { flush(); parse(substr($0, 9)); next }
    in_ports && /^        [a-z_]+:/ { parse(substr($0, 9)); next }
    END { flush() }'
}

# port_busy <ip> <port> — 0 when something on this machine accepts a TCP connection there. bash's
# own /dev/tcp, so it needs no ss/lsof/nc (absent on some Linux and macOS installs). It can err
# BOTH ways: a failed connect reads as free (compose up still reports that port), and a listener
# on the wildcard address (macOS AirPlay on *:5000) reads as busy even where Docker's 127.0.0.1
# bind could coexist with it — the busy message names MANDREL_SKIP_PORT_CHECK=1 for that case.
port_busy() {
  local ip="$1"
  case "$ip" in 0.0.0.0|::|"") ip=127.0.0.1 ;; esac
  (exec 3<>"/dev/tcp/$ip/$2") 2>/dev/null
}

# free_port_near <port> — a port that is free now and not used by the stack, to suggest.
free_port_near() {
  local p try
  for try in 10000 11000 12000 -10000 -20000; do
    p=$(( $1 + try )); (( p >= 1024 && p <= 65535 )) || continue
    grep -qE " $p [0-9]+\$" <<<"$RENDERED_PORTS" && continue
    port_busy 127.0.0.1 "$p" || { printf '%s' "$p"; return 0; }
  done
  printf '%s' '<a free port>'
}

render_ports() {
  local rendered
  if ! rendered="$(dc config 2>/dev/null)"; then
    dc config >/dev/null   # again, so its own error reaches the terminal
    die "'$RUNTIME compose config' failed (see above), so the stack cannot start — is docker-compose.yml valid and .env complete?"
  fi
  RENDERED_PORTS="$(published_ports <<<"$rendered")"
}

# check_ports — every fixed host port must be free BEFORE compose starts anything. A port this
# stack's own running container already holds (a re-run) is not a conflict.
check_ports() {
  local svc ip pub tgt knob busy=0 n=0
  if [[ "${MANDREL_SKIP_PORT_CHECK:-}" == 1 ]]; then say "Skipping the host port check (MANDREL_SKIP_PORT_CHECK=1)."; return 0; fi
  if [[ -z "$RENDERED_PORTS" ]]; then
    say "Note: no fixed host port found in '$RUNTIME compose config'; skipping the host port check."
    return 0
  fi
  while read -r svc ip pub tgt; do
    n=$((n + 1))
    port_busy "$ip" "$pub" || continue
    [[ "$(dc port "$svc" "$tgt" 2>/dev/null </dev/null)" == *":$pub" ]] && continue
    busy=$((busy + 1))
    printf 'install.sh: ERROR: host port %s (%s) is already in use; Mandrel'"'"'s %s service needs it.\n' "$pub" "$ip" "$svc" >&2
    printf '  See what holds it:  Linux: ss -ltnp '"'"'sport = :%s'"'"'   macOS: lsof -nP -iTCP:%s -sTCP:LISTEN\n' "$pub" "$pub" >&2
    if knob="$(port_knob "$svc")"; then
      printf '  Or move Mandrel'"'"'s %s: add this line to %s and re-run ./install.sh:\n      %s=%s\n' "$svc" "$ENV_FILE" "$knob" "$(free_port_near "$pub")" >&2
    else
      printf '  Or move it: change the host side of its ports: entry in docker-compose.yml.\n' >&2
    fi
  done <<<"$RENDERED_PORTS"
  if (( busy > 0 )); then
    printf 'install.sh: nothing was started. Free the port(s) above or move them, then re-run ./install.sh.\n' >&2
    printf '  Sure Docker can bind it anyway (e.g. macOS AirPlay listens on *:5000)? MANDREL_SKIP_PORT_CHECK=1 ./install.sh\n' >&2
    exit 1
  fi
  say "Host ports free ($n checked)."
}

# allow_mcp_port — the MCP server accepts a request only when its Host header is listed in
# MCP_ALLOWED_HOSTS, PORT INCLUDED, and it lists only localhost:8080 / 127.0.0.1:8080 itself.
# On a moved MCP host port every client request would be refused (403 "Invalid Host header")
# while /health stays green, so add the moved port's two loopback names to .env.
allow_mcp_port() {
  local p cur h add=""
  p="$(awk '$1 == "mcp-server" { print $3; exit }' <<<"$RENDERED_PORTS")"
  [[ -n "$p" && "$p" != 8080 ]] || return 0
  cur="$(env_get MCP_ALLOWED_HOSTS)"
  for h in "localhost:$p" "127.0.0.1:$p"; do
    [[ ",$cur," == *",$h,"* ]] || add="${add:+$add,}$h"
  done
  [[ -n "$add" ]] || return 0
  env_set MCP_ALLOWED_HOSTS "${cur:+$cur,}$add"
  say "Added $add to MCP_ALLOWED_HOSTS in .env (the MCP server checks the Host header, port included)."
}

# The URL of a service on its rendered host port; <fallback port> when it publishes none.
service_url() { # service_url <service> <fallback port> <path>
  local p; p="$(awk -v s="$1" '$1 == s { print $3; exit }' <<<"$RENDERED_PORTS")"
  printf 'http://localhost:%s%s' "${p:-$2}" "$3"
}

# --- 3. bring up + wait ------------------------------------------------------------------------
service_state() { # service_state <service> -> healthy | unhealthy | starting | missing
  local id st
  id="$(dc ps -q "$1" 2>/dev/null | head -n1)"
  [[ -n "$id" ]] || { echo missing; return; }
  st="$("$RUNTIME" inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)"
  case "$st" in
    healthy|running) echo healthy ;;
    unhealthy|exited|dead|restarting) echo unhealthy ;;
    *) echo starting ;;
  esac
}

# wait_healthy — 0 when every service is healthy; else prints the offender(s) and returns 1.
wait_healthy() {
  local services svc deadline bad
  services="$(dc config --services 2>/dev/null)" || die "'$RUNTIME compose config' failed — is docker-compose.yml valid and .env complete?"
  [[ -n "$services" ]] || die "compose reports no services"
  deadline=$(( SECONDS + TIMEOUT ))
  while :; do
    bad=()
    for svc in $services; do
      [[ "$(service_state "$svc")" == healthy ]] || bad+=("$svc")
    done
    [[ ${#bad[@]} -eq 0 ]] && return 0
    if (( SECONDS >= deadline )); then
      for svc in "${bad[@]}"; do
        printf 'install.sh: ERROR: service "%s" is not healthy after %ss. See why: %s compose logs %s\n' "$svc" "$TIMEOUT" "$RUNTIME" "$svc" >&2
      done
      return 1
    fi
    sleep "$POLL"
  done
}

# --- 4c. supersession mode report --------------------------------------------------------------
# Mirrors the server's key-following rule (docs/manual/supersession.md): an explicit
# MANDREL_BELIEF_ADJUDICATOR_PROVIDER wins; otherwise both keys -> tiered, SUBQ only -> subq,
# ANTHROPIC only -> anthropic, neither -> off. MANDREL_BELIEF_ENABLED=false forces off.
# The inputs are read from the environment the mcp-server container will RECEIVE — the rendered
# `compose config` (which already folds in .env, the shell and any compose override file) —
# NOT from .env alone: a key in .env that compose does not forward is not a key the server has.
# Prints key NAMES only, never values.
DAILY_CAP_DEFAULT_USD=2   # the server default for MANDREL_BELIEF_DAILY_SPEND_CAP_USD

# delivered_env — print `NAME=value` for the mcp-server service's rendered environment.
delivered_env() {
  dc config 2>/dev/null | awk '
    /^[^ #]/            { in_svcs = ($0 ~ /^services:/); in_mcp = 0; in_env = 0; next }
    in_svcs && /^  [^ ]/ { in_mcp = ($0 ~ /^  mcp-server:[ ]*$/); in_env = 0; next }
    in_mcp && /^    [^ ]/ { in_env = ($0 ~ /^    environment:[ ]*$/); next }
    in_env && /^      [A-Za-z_][A-Za-z0-9_]*:/ {
      line = substr($0, 7); i = index(line, ":"); k = substr(line, 1, i - 1)
      v = substr(line, i + 1); sub(/^[ ]+/, "", v); sub(/[ ]+$/, "", v)
      q = sprintf("%c", 39)
      if (v ~ /^".*"$/ || (substr(v, 1, 1) == q && substr(v, length(v), 1) == q)) v = substr(v, 2, length(v) - 2)
      print k "=" v
    }'
}

report_supersession_mode() {
  local delivered enabled provider has_subq="" has_anth="" mode cap
  delivered="$(delivered_env)"
  if [[ -z "$delivered" ]]; then
    say ""
    say "Supersession mode: unknown"
    say "  Could not read the mcp-server environment from '$RUNTIME compose config'; run it yourself to see what the server receives."
    return 0
  fi
  cfg_get() { local v; v="$(grep -E "^$1=" <<<"$delivered" | tail -n1 | cut -d= -f2-)"; printf '%s' "$v"; }
  enabled="$(cfg_get MANDREL_BELIEF_ENABLED)"; provider="$(cfg_get MANDREL_BELIEF_ADJUDICATOR_PROVIDER)"
  [[ -n "$(cfg_get SUBQ_API_KEY)" ]] && has_subq=1
  [[ -n "$(cfg_get ANTHROPIC_API_KEY)" ]] && has_anth=1
  if [[ "$enabled" == false ]]; then mode=off
  elif [[ -n "$provider" ]]; then mode="$provider"
  elif [[ -n "$has_subq" && -n "$has_anth" ]]; then mode=tiered
  elif [[ -n "$has_subq" ]]; then mode=subq
  elif [[ -n "$has_anth" ]]; then mode=anthropic
  else mode=off
  fi
  cap="$(cfg_get MANDREL_BELIEF_DAILY_SPEND_CAP_USD)"; cap="${cap:-$DAILY_CAP_DEFAULT_USD}"
  say ""
  say "Supersession mode: $mode"
  case "$mode" in
    tiered)    say "  SubQ Snap (tier 1) judges every pair; Sonnet (tier 2) only for pairs Snap flags." ;;
    anthropic) say "  Every pair goes to Sonnet (higher cost)."
               [[ -n "$has_subq" ]] || say "  Tip: add SUBQ_API_KEY (SubQ Snap, public preview) to lower cost — see docs/manual/supersession.md." ;;
    subq)      say "  SubQ Snap judges every pair (add ANTHROPIC_API_KEY for tier-2 reasoning)." ;;
    off)       say "  No supersession key reaches the server, so no model is called and nothing is spent."
               if [[ -n "$(env_get SUBQ_API_KEY)$(env_get ANTHROPIC_API_KEY)" ]]; then
                 say "  Note: .env holds a supersession key, but the server is not running with it (MANDREL_BELIEF_ENABLED=false, or docker-compose.yml does not forward the key)."; fi ;;
  esac
  if [[ "$cap" == 0 ]]; then say "  Daily spend cap: none (MANDREL_BELIEF_DAILY_SPEND_CAP_USD=0)."
  else say "  Daily spend cap: \$$cap per UTC day (MANDREL_BELIEF_DAILY_SPEND_CAP_USD); writes keep working when it is reached."; fi
}

# --- 5. how to connect -------------------------------------------------------------------------
print_connect() {
  local token actor admin_user admin_pass
  token="$(env_get MCP_AUTH_TOKEN)"; actor="$(actor_id)"
  admin_user="$(env_get DASHBOARD_ADMIN_USERNAME)"; admin_pass="$(env_get DASHBOARD_ADMIN_PASSWORD)"
  cat <<OUT

Mandrel is running.

  MCP endpoint : $MCP_URL
  Dashboard    : $DASHBOARD_URL
  Dashboard login:  username $admin_user   password $admin_pass   (kept in $ENV_FILE)

Connect Claude Code (run this once):

  claude mcp add --transport http mandrel $MCP_URL --header "Authorization: Bearer $token" --header "X-Actor-ID: $actor"

or paste this into your MCP client config (.mcp.json):

{
  "mcpServers": {
    "mandrel": {
      "type": "http",
      "url": "$MCP_URL",
      "headers": {
        "Authorization": "Bearer $token",
        "X-Actor-ID": "$actor"
      }
    }
  }
}

X-Actor-ID attributes what you store to "$actor" (change it with MANDREL_ACTOR_ID in .env).
The token is stored in $ENV_FILE (mode 600). Stop the stack: $RUNTIME compose down
OUT
}

main() {
  check_runtime
  prepare_env
  export_revision
  render_ports
  check_ports
  allow_mcp_port
  [[ -n "$MCP_URL" ]] || MCP_URL="$(service_url mcp-server 8080 /mcp)"
  [[ -n "$DASHBOARD_URL" ]] || DASHBOARD_URL="$(service_url mandrel-command-frontend 3000 '')"
  say "Starting the Mandrel stack (first run builds images; this can take several minutes)..."
  dc up -d --build || die "'$RUNTIME compose up' failed — see the output above (a port in use? the Host ports block in .env.example names the line that moves each one)"
  say "Waiting up to ${TIMEOUT}s for every service to be healthy..."
  wait_healthy || exit 1
  say "All services healthy. Validating the install..."
  bash "$ROOT/scripts/validate-install.sh" || die "validation failed — see the checks above"
  create_admin
  report_supersession_mode
  print_connect
}

# run only when executed, so scripts/test/supersession-docs-install.test.sh can source the functions
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main; fi

#!/bin/sh
# =============================================================================
# retry_net.sh — retry a network-fetching command with exponential backoff.
# =============================================================================
# Sprint 3, an earlier task (deploy build reliability). Used inside the mcp-server
# Dockerfile to wrap every step that hits the network (`npm ci`, `npm rebuild
# sharp` which fetches prebuilt libvips, `npm install -g tsx`, apt-get). A single
# transient timeout used to abort the whole image build — and once killed a fleet
# deploy at the staging bake. Wrapping those steps here makes a transient blip
# SELF-HEAL instead of failing the build.
#
# POSIX sh only (no bashisms): the builder stage runs node:22-alpine (busybox sh).
#
# Behavior:
#   * Runs "$@" up to MAX_TRIES times (default 5).
#   * On failure, sleeps with exponential backoff: BASE, 2*BASE, 4*BASE, ... s
#     (default BASE=5 → 5,10,20,40s between the 5 attempts).
#   * Returns the command's exit code from the LAST attempt (0 on eventual success).
#   * Tunable via env: RETRY_MAX_TRIES, RETRY_BASE_SLEEP.
#
# Usage:  retry_net npm ci --only=production
#         RETRY_MAX_TRIES=3 retry_net some-flaky-command --flag
# =============================================================================
set -u

MAX_TRIES="${RETRY_MAX_TRIES:-5}"
BASE_SLEEP="${RETRY_BASE_SLEEP:-5}"

if [ "$#" -eq 0 ]; then
  echo "retry_net: no command given" >&2
  exit 2
fi

try=1
sleep_for="$BASE_SLEEP"
while : ; do
  "$@"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    [ "$try" -gt 1 ] && echo "retry_net: succeeded on attempt ${try}/${MAX_TRIES}: $*" >&2
    exit 0
  fi
  if [ "$try" -ge "$MAX_TRIES" ]; then
    echo "retry_net: FAILED after ${try} attempt(s) (rc=${rc}): $*" >&2
    exit "$rc"
  fi
  echo "retry_net: attempt ${try}/${MAX_TRIES} failed (rc=${rc}); retrying in ${sleep_for}s: $*" >&2
  sleep "$sleep_for"
  try=$((try + 1))
  sleep_for=$((sleep_for * 2))
done

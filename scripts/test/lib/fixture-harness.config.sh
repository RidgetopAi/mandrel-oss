#!/usr/bin/env bash
# =============================================================================
# fixture-harness.config.sh — the TUNABLES for scripts/test/lib/fixture-harness.sh
# -----------------------------------------------------------------------------
# NOT A TEST. Sourced by fixture-harness.sh. Every knob the harness has lives
# here and nowhere else (house rule: no hardcoded variables; tunables live in a
# named config). fixture-harness.sh contains no literal binary name, no literal
# host, and no literal exit code — it reads all of them from this file.
# =============================================================================

# The binaries a fixture must never reach by accident. Shadowed BY DEFAULT.
# Sourced from the incident that produced this harness: a suite ran the real
# prod deploy step with its real compose project name and no docker stub, and a
# PATH shim caught two `docker compose -p <prod project> ... up -d` invocations.
# Nothing was harmed only because this box has no docker.
FH_DANGEROUS_BINARIES=(docker ssh rclone systemctl psql curl scp rsync nc)

# Hosts that count as "did not leave the box" for fh_allow_loopback.
FH_LOOPBACK_HOSTS=(127.0.0.1 localhost ::1 0.0.0.0)

# Exit code a shadowed (denied) binary returns. 127 == "command not found",
# which is the state a hermetic fixture should behave as if it were in.
FH_DENY_RC=127

# Harness-error exit code. Mirrors the gate's exit codes: 0 GREEN, 1 RED,
# 2 CANNOT MEASURE. A fixture the harness cannot parse is a 2, never a pass.
FH_RC_CANNOT_MEASURE=2

# Longest argv slice recorded per logged call. Bounded so a fixture that shovels
# a megabyte of JSON at curl cannot turn the call log into the test output.
FH_MAX_LOGGED_ARG_CHARS=400

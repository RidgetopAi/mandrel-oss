#!/bin/sh
# MCP Server container entrypoint.
# Runs idempotent DB migrations (safe on every boot via the _aidis_migrations
# table) BEFORE starting the server, so a fresh customer DB self-provisions its
# schema on first boot. Then exec's the server as PID 1's child for signals.
set -e

echo "[entrypoint] Running database migrations..."
# db:migrate -> tsx scripts/migrate.ts (idempotent; applies only pending files)
tsx scripts/migrate.ts

echo "[entrypoint] Migrations complete. Starting MCP server..."
exec tsx src/main.ts

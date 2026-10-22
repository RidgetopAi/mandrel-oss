#!/usr/bin/env bash
# Wrapper to launch Mandrel Claude HTTP-MCP bridge with robust logging.
# Use this as the MCP `command` in codex config to avoid PATH issues.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
BRIDGE_JS="$ROOT_DIR/claude-http-mcp-bridge.js"

# Find node binary dynamically - supports nvm, homebrew, and system installations
find_node() {
  # 1. Check if node is already in PATH
  if command -v node &> /dev/null; then
    command -v node
    return 0
  fi

  # 2. Check nvm installation (loads nvm if available)
  if [ -f "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh" --no-use
    if command -v node &> /dev/null; then
      command -v node
      return 0
    fi
  fi

  # 3. Common installation paths
  local node_paths=(
    "/usr/local/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/bin/node"
    "$HOME/.local/bin/node"
  )

  for path in "${node_paths[@]}"; do
    if [ -x "$path" ]; then
      echo "$path"
      return 0
    fi
  done

  echo "ERROR: Could not find node. Please install Node.js 18+ or set NODE_BIN env var." >&2
  return 1
}

# Allow explicit override via NODE_BIN env var
NODE_BIN="${NODE_BIN:-$(find_node)}"

mkdir -p "$LOG_DIR"

{
  echo "[$(date --iso-8601=seconds)] Launching Mandrel bridge (pid $$)"
  echo "node: $NODE_BIN"
  echo "script: $BRIDGE_JS"
  echo "cwd: $ROOT_DIR"
} >> "$LOG_DIR/bridge-spawn.log" 2>&1

# Keep stdout attached: stdio MCP uses stdout as the protocol channel.
exec "$NODE_BIN" "$BRIDGE_JS" 2>> "$LOG_DIR/bridge-stdio.log"

#!/bin/bash
# mandrel-context-watcher.sh - Comprehensive Mandrel debugging context
set -euo pipefail

CONTEXT_DIR="./ai-context"
CURRENT_LOGS="$CONTEXT_DIR/debug-context.txt"
ARCHIVE_DIR="$CONTEXT_DIR/archive"
MAX_LOG_SIZE=100000  # 100KB for more context
MAX_LINES=2000       # More lines for deeper context

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

mkdir -p "$CONTEXT_DIR" "$ARCHIVE_DIR"

rotate_logs() {
    if [[ -f "$CURRENT_LOGS" ]] && [[ $(wc -c < "$CURRENT_LOGS") -gt $MAX_LOG_SIZE ]]; then
        local timestamp=$(date +"%Y%m%d_%H%M%S")
        mv "$CURRENT_LOGS" "$ARCHIVE_DIR/debug_$timestamp.txt"
        cd "$ARCHIVE_DIR"
        ls -1t debug_*.txt 2>/dev/null | tail -n +6 | xargs rm -f
        cd - > /dev/null
    fi
}

safe_tail() {
    local file=$1
    local lines=${2:-50}
    [[ -f "$file" && -r "$file" ]] && tail -n "$lines" "$file" 2>/dev/null
}

check_port() {
    local port=$1
    local name=$2
    if lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
        echo -e "${GREEN}✓ $name (port $port): RUNNING${NC}"
        lsof -i ":$port" -sTCP:LISTEN | tail -1
    else
        echo -e "${RED}✗ $name (port $port): NOT RUNNING${NC}"
    fi
}

collect_debug_context() {
    local temp_file=$(mktemp)

    {
        echo "=== MANDREL DEBUGGING CONTEXT ==="
        echo "Generated: $(date)"
        echo "Git Branch: $(git branch --show-current 2>/dev/null || echo 'unknown')"
        echo "Git Status: $(git status --short 2>/dev/null | wc -l) files modified"
        echo "Node: $(node --version 2>/dev/null || echo 'not found')"
        echo "npm: $(npm --version 2>/dev/null || echo 'not found')"
        echo ""

        echo "=== CRITICAL PORTS STATUS ==="
        check_port 3005 "Mandrel Command Frontend"
        check_port 5174 "Mandrel Command Backend"
        check_port 8080 "HTTP MCP Bridge"
        check_port 5432 "PostgreSQL"
        echo ""

        echo "=== MCP SERVER STATUS ==="
        if pgrep -f "mcp-server/src/server.ts" >/dev/null; then
            echo -e "${GREEN}✓ MCP Server: RUNNING${NC}"
            ps aux | grep "[m]cp-server/src/server.ts" | head -3
        else
            echo -e "${RED}✗ MCP Server: NOT RUNNING${NC}"
        fi

        # Check for MCP server in port registry
        if [[ -f "run/port-registry.json" ]]; then
            echo "--- Port Registry Status ---"
            cat run/port-registry.json 2>/dev/null || echo "Could not read port registry"
        fi

        # Check for recent MCP server logs
        if [[ -f "mcp-server/server.log" ]]; then
            echo "--- Recent MCP Logs (last 30 lines) ---"
            safe_tail "mcp-server/server.log" 30
        fi

        # Check stdout/stderr if available
        for log in run/*.log; do
            if [[ -f "$log" ]]; then
                echo "--- $(basename "$log") (last 20 lines) ---"
                safe_tail "$log" 20
            fi
        done
        echo ""

        echo "=== DATABASE CONNECTION ==="
        if psql -h localhost -p 5432 -d mandrel -c "SELECT 1" >/dev/null 2>&1; then
            echo -e "${GREEN}✓ PostgreSQL: Connected${NC}"
            psql -h localhost -p 5432 -d mandrel -c "SELECT current_database(), current_user, pg_backend_pid();" 2>&1 | head -5
            echo ""
            echo "--- Recent Database Activity ---"
            psql -h localhost -p 5432 -d mandrel -c "SELECT count(*) as total_contexts FROM contexts;" 2>&1
            psql -h localhost -p 5432 -d mandrel -c "SELECT count(*) as total_sessions FROM sessions;" 2>&1
            psql -h localhost -p 5432 -d mandrel -c "SELECT count(*) as total_projects FROM projects;" 2>&1
        else
            echo -e "${RED}✗ PostgreSQL: Connection Failed${NC}"
            echo "Last error:"
            psql -h localhost -p 5432 -d mandrel -c "SELECT 1" 2>&1 | tail -5
        fi
        echo ""

        echo "=== ENVIRONMENT VARIABLES ==="
        echo "DATABASE_URL: $(if [[ -n "${DATABASE_URL:-}" ]]; then echo 'SET'; else echo 'NOT SET'; fi)"
        echo "NODE_ENV: ${NODE_ENV:-not set}"
        echo "PORT: ${PORT:-not set}"
        echo "PGHOST: ${PGHOST:-not set}"
        echo "PGPORT: ${PGPORT:-not set}"
        echo "PGDATABASE: ${PGDATABASE:-not set}"
        echo ""

        echo "=== TYPESCRIPT BUILD STATUS ==="
        # Check if tsconfig files exist
        for tsconfig in mcp-server/tsconfig.json mandrel-command/frontend/tsconfig.json mandrel-command/backend/tsconfig.json mandrel-command/shared/tsconfig.json; do
            if [[ -f "$tsconfig" ]]; then
                echo "✓ $tsconfig exists"
            else
                echo -e "${RED}✗ $tsconfig MISSING${NC}"
            fi
        done

        # Check for build artifacts
        echo ""
        echo "--- Build Artifacts ---"
        if [[ -d "mcp-server/dist" ]]; then
            echo "✓ mcp-server/dist exists ($(ls mcp-server/dist/*.js 2>/dev/null | wc -l) JS files)"
        else
            echo -e "${YELLOW}⚠ mcp-server/dist not found${NC}"
        fi

        if [[ -d "mandrel-command/backend/dist" ]]; then
            echo "✓ mandrel-command/backend/dist exists"
        else
            echo -e "${YELLOW}⚠ mandrel-command/backend/dist not found${NC}"
        fi

        # Recent TypeScript errors
        if [[ -f "typescript-errors.log" ]]; then
            echo "--- Recent TS Errors ---"
            safe_tail "typescript-errors.log" 20
        fi
        echo ""

        echo "=== NPM/BUILD ERRORS ==="
        # npm debug logs
        for log in npm-debug.log lerna-debug.log; do
            if [[ -f "$log" ]]; then
                echo "--- $log (last 30 lines) ---"
                safe_tail "$log" 30
            fi
        done

        # Check Mandrel Command logs
        if [[ -d "mandrel-command/frontend" ]]; then
            for log in mandrel-command/frontend/*.log mandrel-command/backend/*.log; do
                if [[ -f "$log" ]]; then
                    echo "--- $log (last 20 lines) ---"
                    safe_tail "$log" 20
                fi
            done
        fi
        echo ""

        echo "=== RECENT ERROR PATTERNS ==="
        # Search for common error patterns in recent logs
        echo "Searching for: ECONNREFUSED, EADDRINUSE, TypeScript errors, Unhandled Promise..."
        {
            find . -name "*.log" -type f -mtime -1 2>/dev/null | while read log; do
                if grep -l "ECONNREFUSED\|EADDRINUSE\|TS[0-9]\{4\}\|UnhandledPromiseRejection\|Error:" "$log" 2>/dev/null; then
                    echo "Found in: $log"
                    grep "ECONNREFUSED\|EADDRINUSE\|TS[0-9]\{4\}\|UnhandledPromiseRejection\|Error:" "$log" 2>/dev/null | tail -3
                fi
            done
        } | head -20
        echo ""

        echo "=== RUNNING NODE PROCESSES ==="
        ps aux | grep -E "[n]ode|[n]pm|[t]sx|[v]ite" | head -15
        echo ""

        echo "=== DISK & NODE_MODULES STATUS ==="
        echo "Disk usage: $(df -h . | tail -1 | awk '{print $5 " used (" $4 " free)"}')"
        echo "Root node_modules: $(du -sh node_modules 2>/dev/null | cut -f1 || echo 'not found')"
        echo "MCP node_modules: $(du -sh mcp-server/node_modules 2>/dev/null | cut -f1 || echo 'not found')"
        echo "Frontend node_modules: $(du -sh mandrel-command/frontend/node_modules 2>/dev/null | cut -f1 || echo 'not found')"
        echo "Backend node_modules: $(du -sh mandrel-command/backend/node_modules 2>/dev/null | cut -f1 || echo 'not found')"
        echo ""

        echo "=== PACKAGE.JSON VERSIONS ==="
        if [[ -f "package.json" ]]; then
            echo "Root: $(jq -r '.name + " v" + .version' package.json 2>/dev/null || echo 'parse error')"
        fi
        if [[ -f "mcp-server/package.json" ]]; then
            echo "MCP Server: $(jq -r '.name + " v" + .version' mcp-server/package.json 2>/dev/null || echo 'parse error')"
        fi
        if [[ -f "mandrel-command/package.json" ]]; then
            echo "Mandrel Command: $(jq -r '.name + " v" + .version' mandrel-command/package.json 2>/dev/null || echo 'parse error')"
        fi
        echo ""

        echo "=== LAST GIT OPERATIONS ==="
        git log --oneline -5 2>/dev/null || echo "Git log unavailable"
        echo ""
        echo "--- Uncommitted Changes ---"
        # The fallback belongs to git FAILING, not to git printing nothing: a clean
        # worktree is not "No git repo". Capturing git's own status keeps that
        # distinction, which `git status | head -10 || echo ...` under pipefail did
        # not (it inverts) and an emptiness test does not either (it mislabels clean).
        local _gs _grc=0
        _gs="$(git status --short 2>/dev/null)" || _grc=$?
        if [[ "$_grc" -ne 0 ]]; then echo "No git repo"
        elif [[ -n "$_gs" ]]; then head -10 <<<"$_gs"; fi
        echo ""

        echo "=== SYSTEM RESOURCES ==="
        echo "Memory: $(free -h 2>/dev/null | grep Mem | awk '{print $3 "/" $2}' || echo 'N/A')"
        echo "Load: $(uptime | awk -F'load average:' '{print $2}')"
        echo "Open files: $(lsof 2>/dev/null | wc -l || echo 'N/A')"

    } > "$temp_file"

    head -n $MAX_LINES "$temp_file" > "$CURRENT_LOGS"
    rm "$temp_file"
}

live_monitor() {
    while true; do
        clear
        echo -e "${MAGENTA}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${MAGENTA}║       MANDREL DEBUGGING CONTEXT - $(date +%H:%M:%S)       ║${NC}"
        echo -e "${MAGENTA}╚══════════════════════════════════════════════════════════╝${NC}"
        echo ""

        rotate_logs
        collect_debug_context

        echo -e "${YELLOW}=== CRITICAL ISSUES DETECTED ===${NC}"
        if [[ -f "$CURRENT_LOGS" ]]; then
            grep -i "error\|exception\|failed\|fatal\|econnrefused\|eaddrinuse" "$CURRENT_LOGS" 2>/dev/null | tail -10 || echo -e "${GREEN}No critical issues found${NC}"
        fi

        echo ""
        echo -e "${BLUE}Context file: $CURRENT_LOGS ($(wc -c < "$CURRENT_LOGS") bytes)${NC}"
        echo -e "${BLUE}Next refresh in 15s | Ctrl+C to stop${NC}"

        sleep 15
    done
}

# CLI
case "${1:-live}" in
    "live")
        live_monitor
        ;;
    "once")
        rotate_logs
        collect_debug_context
        echo "Debug context collected: $CURRENT_LOGS"
        echo ""
        cat "$CURRENT_LOGS"
        ;;
    "errors")
        if [[ -f "$CURRENT_LOGS" ]]; then
            echo -e "${YELLOW}=== ERROR SUMMARY ===${NC}"
            grep -i "error\|exception\|failed\|fatal" "$CURRENT_LOGS" | tail -20
        else
            echo "Run 'once' first to collect context"
        fi
        ;;
    "ports")
        echo -e "${BLUE}=== PORT STATUS ===${NC}"
        check_port 3005 "Frontend"
        check_port 5174 "Backend"
        check_port 8080 "MCP Bridge"
        check_port 5432 "PostgreSQL"
        ;;
    "db")
        echo -e "${BLUE}=== DATABASE STATUS ===${NC}"
        if psql -h localhost -p 5432 -d mandrel -c "SELECT 1" >/dev/null 2>&1; then
            echo -e "${GREEN}✓ PostgreSQL: Connected${NC}"
            echo ""
            psql -h localhost -p 5432 -d mandrel -c "
                SELECT
                    (SELECT count(*) FROM contexts) as contexts,
                    (SELECT count(*) FROM sessions) as sessions,
                    (SELECT count(*) FROM projects) as projects,
                    (SELECT count(*) FROM tasks) as tasks;
            "
        else
            echo -e "${RED}✗ PostgreSQL: Connection Failed${NC}"
        fi
        ;;
    "clean")
        rm -rf "$CONTEXT_DIR"
        echo "Cleaned all debug context"
        ;;
    "help")
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  live   - Live monitoring with 15s refresh (default)"
        echo "  once   - Single collection + display"
        echo "  errors - Show only error lines from context"
        echo "  ports  - Quick port status check"
        echo "  db     - Quick database status check"
        echo "  clean  - Remove all context files"
        echo "  help   - Show this help message"
        echo ""
        echo "Examples:"
        echo "  $0 live              # Start live monitoring"
        echo "  $0 once              # Collect and display context"
        echo "  $0 errors | tail -20 # Show last 20 errors"
        ;;
    *)
        echo "Unknown command: $1"
        echo "Run '$0 help' for usage information"
        exit 1
        ;;
esac

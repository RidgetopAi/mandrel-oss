#!/bin/bash
# TR007-4: Process Supervision Strategy
# Oracle Refactor Phase 4 - Process Management

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/process-supervisor.log"
PID_FILE="$PROJECT_ROOT/run/supervisor.pid"

# Ensure directories exist
mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Check if process is running
is_running() {
    local pid=$1
    kill -0 "$pid" 2>/dev/null
}

# Get process by name pattern
get_process_pid() {
    local pattern=$1
    head -1 < <(pgrep -f "$pattern") || echo ""
}

# Health check function
health_check() {
    local service=$1
    local url=$2
    local expected_status=${3:-200}

    if grep -q "$expected_status" < <(curl -s -o /dev/null -w "%{http_code}" "$url"); then
        return 0
    else
        return 1
    fi
}

# Monitor essential processes
monitor_processes() {
    log "Starting process monitoring..."

    # Check AIDIS MCP Server (Port 8080)
    local mcp_pid=$(get_process_pid "tsx src/server.ts")
    if [[ -n "$mcp_pid" ]]; then
        if health_check "AIDIS MCP" "http://localhost:8080/health" 200; then
            log "✅ AIDIS MCP Server (PID: $mcp_pid) - Healthy"
        else
            log "⚠️  AIDIS MCP Server (PID: $mcp_pid) - Health check failed"
        fi
    else
        log "❌ AIDIS MCP Server - Not running"
    fi

    # Check Backend API (Port 5000)
    local backend_pid=$(get_process_pid "nodemon src/server.ts")
    if [[ -n "$backend_pid" ]]; then
        if health_check "Backend API" "http://localhost:5000/api/health" 200; then
            log "✅ Backend API (PID: $backend_pid) - Healthy"
        else
            log "⚠️  Backend API (PID: $backend_pid) - Health check failed"
        fi
    else
        log "❌ Backend API - Not running"
    fi

    # Check Frontend Dev Server (Port 3000)
    local frontend_pid=$(get_process_pid "react-scripts/scripts/start.js")
    if [[ -n "$frontend_pid" ]]; then
        if health_check "Frontend Dev" "http://localhost:3000" 200; then
            log "✅ Frontend Dev Server (PID: $frontend_pid) - Healthy"
        else
            log "⚠️  Frontend Dev Server (PID: $frontend_pid) - Health check failed"
        fi
    else
        log "❌ Frontend Dev Server - Not running"
    fi

    # Check HTTP-MCP Bridge
    local bridge_pid=$(get_process_pid "claude-http-mcp-bridge.js")
    if [[ -n "$bridge_pid" ]]; then
        log "✅ HTTP-MCP Bridge (PID: $bridge_pid) - Running"
    else
        log "❌ HTTP-MCP Bridge - Not running"
    fi
}

# Detect redundant processes
detect_redundancy() {
    log "Scanning for redundant processes..."

    # Count backend server instances
    local backend_count=$(pgrep -f "server.ts" | wc -l)
    if [[ $backend_count -gt 1 ]]; then
        log "⚠️  Found $backend_count backend server processes (expected: 1)"
        pgrep -f "server.ts" | head -n -1 | while read pid; do
            log "🔴 Redundant backend process: PID $pid"
        done
    fi

    # Check for duplicate TypeScript checkers
    local ts_checker_count=$(pgrep -f "fork-ts-checker" | wc -l)
    if [[ $ts_checker_count -gt 1 ]]; then
        log "⚠️  Found $ts_checker_count TypeScript checkers (expected: 1)"
    fi

    # Check for orphaned processes
    local orphaned=$(ps aux | grep -E "(nodemon|ts-node)" | grep -v grep | awk '$9 ~ /^Z/ {print $2}')
    if [[ -n "$orphaned" ]]; then
        log "🔴 Found orphaned processes: $orphaned"
    fi
}

# Port utilization check
check_ports() {
    log "Checking port utilization..."

    local ports=(3000 5000 8080)
    for port in "${ports[@]}"; do
        local process=$(lsof -ti:$port 2>/dev/null || echo "")
        if [[ -n "$process" ]]; then
            local service_name=$(ps -p $process -o comm= 2>/dev/null || echo "unknown")
            log "✅ Port $port: $service_name (PID: $process)"
        else
            log "⚠️  Port $port: No service listening"
        fi
    done
}

# Resource utilization monitoring
monitor_resources() {
    log "Monitoring resource utilization..."

    # Memory usage for Node.js processes
    local total_memory=$(ps aux | grep -E "(node|nodemon)" | grep -v grep | awk '{sum += $6} END {printf "%.1f", sum/1024}')
    log "📊 Total Node.js Memory Usage: ${total_memory}MB"

    # High memory consumers
    ps aux | grep -E "(node|nodemon)" | grep -v grep | awk '$6 > 100000 {printf "🔋 High memory: PID %s (%s) - %.1fMB\n", $2, $11, $6/1024}' | while read line; do
        log "$line"
    done

    # CPU usage
    local high_cpu=$(ps aux | grep -E "(node|nodemon)" | grep -v grep | awk '$3 > 10.0 {printf "⚡ High CPU: PID %s (%.1f%%) - %s\n", $2, $3, $11}')
    if [[ -n "$high_cpu" ]]; then
        log "$high_cpu"
    fi
}

# Generate process summary
generate_summary() {
    log "=== PROCESS SUPERVISION SUMMARY ==="

    local total_processes=$(ps aux | grep -E "(node|nodemon|ts-node)" | grep -v grep | wc -l)
    log "📈 Total Node.js processes: $total_processes"

    # Count by type
    local nodemon_count=$(pgrep -f nodemon | wc -l)
    local ts_node_count=$(pgrep -f ts-node | wc -l)
    local react_count=$(pgrep -f "react-scripts" | wc -l)
    local mcp_count=$(pgrep -f "tsx.*server.ts" | wc -l)

    log "🔧 Nodemon instances: $nodemon_count"
    log "🔧 TS-Node instances: $ts_node_count"
    log "⚛️  React instances: $react_count"
    log "🤖 AIDIS MCP instances: $mcp_count"

    # Service availability
    local services_up=0
    local services_total=3

    health_check "AIDIS MCP" "http://localhost:8080/health" && ((services_up++))
    health_check "Backend API" "http://localhost:5000/api/health" && ((services_up++))
    health_check "Frontend" "http://localhost:3000" && ((services_up++))

    log "🌐 Service Availability: $services_up/$services_total"

    if [[ $services_up -eq $services_total ]]; then
        log "✅ All services operational"
    else
        log "⚠️  Some services unavailable"
    fi
}

# Cleanup function
cleanup() {
    log "Process supervisor shutting down..."
    rm -f "$PID_FILE"
    exit 0
}

# Signal handlers
trap cleanup SIGTERM SIGINT

# Main supervision loop
main() {
    log "🚀 TR007-4 Process Supervisor Started"
    echo $$ > "$PID_FILE"

    while true; do
        monitor_processes
        detect_redundancy
        check_ports
        monitor_resources
        generate_summary

        log "--- Next check in 30 seconds ---"
        sleep 30
    done
}

# Command line interface
case "${1:-monitor}" in
    "monitor")
        main
        ;;
    "check")
        monitor_processes
        detect_redundancy
        check_ports
        monitor_resources
        generate_summary
        ;;
    "status")
        if [[ -f "$PID_FILE" ]]; then
            local supervisor_pid=$(cat "$PID_FILE")
            if is_running "$supervisor_pid"; then
                log "✅ Process supervisor running (PID: $supervisor_pid)"
            else
                log "❌ Process supervisor not running (stale PID file)"
                rm -f "$PID_FILE"
            fi
        else
            log "❌ Process supervisor not running"
        fi
        ;;
    "stop")
        if [[ -f "$PID_FILE" ]]; then
            local supervisor_pid=$(cat "$PID_FILE")
            if is_running "$supervisor_pid"; then
                kill "$supervisor_pid"
                log "✅ Process supervisor stopped"
            else
                log "❌ Process supervisor not running"
            fi
            rm -f "$PID_FILE"
        else
            log "❌ Process supervisor not running"
        fi
        ;;
    *)
        echo "Usage: $0 {monitor|check|status|stop}"
        echo "  monitor - Start continuous monitoring"
        echo "  check   - Run one-time system check"
        echo "  status  - Check supervisor status"
        echo "  stop    - Stop supervisor"
        exit 1
        ;;
esac
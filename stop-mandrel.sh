#!/bin/bash

# Mandrel Simple Process Stopper
# Gracefully stops Mandrel MCP server

cd "$(dirname "$0")"

echo "🛑 Stopping Mandrel MCP Server..."

if [ ! -f logs/mandrel.pid ]; then
    echo "⚠️  No PID file found - Mandrel may not be running"
    
    # Try to find and kill any running Mandrel processes
    MANDREL_PIDS=$(ps aux | grep -E "(tsx.*src/server\.ts|mandrel.*server\.ts)" | grep -v grep | awk '{print $2}')
    if [ ! -z "$MANDREL_PIDS" ]; then
        echo "🔍 Found running Mandrel processes: $MANDREL_PIDS"
        echo "$MANDREL_PIDS" | xargs kill
        echo "✅ Killed orphaned Mandrel processes"
    else
        echo "ℹ️  No Mandrel processes found running"
    fi
    exit 0
fi

PID=$(cat logs/mandrel.pid)

if ps -p $PID > /dev/null 2>&1; then
    echo "🛑 Stopping Mandrel (PID: $PID)"
    kill $PID
    
    # Wait for graceful shutdown
    sleep 2
    
    if ps -p $PID > /dev/null 2>&1; then
        echo "⚡ Forcing shutdown..."
        kill -9 $PID
    fi
    
    rm logs/mandrel.pid
    echo "✅ Mandrel stopped successfully"
else
    echo "⚠️  Process $PID not found - cleaning stale PID file"
    rm logs/mandrel.pid
fi

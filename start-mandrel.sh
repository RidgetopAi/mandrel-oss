#!/bin/bash

# Mandrel Simple Process Starter
# Replaces SystemD service with basic process management

cd "$(dirname "$0")"

echo "🚀 Starting Mandrel MCP Server..."

# Ensure logs directory exists
mkdir -p logs

# Check if already running
if [ -f logs/mandrel.pid ]; then
    PID=$(cat logs/mandrel.pid)
    if ps -p $PID > /dev/null 2>&1; then
        echo "⚠️  Mandrel already running (PID: $PID)"
        echo "💡 Use ./stop-mandrel.sh first or ./restart-mandrel.sh"
        exit 1
    else
        echo "🧹 Cleaning stale PID file"
        rm logs/mandrel.pid
    fi
fi

# Start Mandrel MCP server with direct STDIO for MCP protocol
cd mcp-server
npx tsx src/main.ts > ../logs/mandrel.log 2>&1 &
MANDREL_PID=$!

# Save PID for management
echo $MANDREL_PID > ../logs/mandrel.pid

# Wait a moment and verify startup
sleep 3

if ps -p $MANDREL_PID > /dev/null 2>&1; then
    echo "✅ Mandrel MCP Server started successfully (PID: $MANDREL_PID)"
    echo "📋 Logs: tail -f logs/mandrel.log"

    # Check port registry for actual assigned port
    sleep 2
    if [ -f run/port-registry.json ]; then
        ACTUAL_PORT=$(cat run/port-registry.json | grep -o '"port":[0-9]*' | head -1 | cut -d':' -f2)
        if [ -n "$ACTUAL_PORT" ]; then
            echo "🏥 Health: curl http://localhost:${ACTUAL_PORT}/healthz"
        else
            echo "🏥 Health: curl http://localhost:8080/healthz (fallback)"
        fi
    else
        echo "🏥 Health: curl http://localhost:8080/healthz (fallback)"
    fi

    echo "🛑 Stop: ./stop-mandrel.sh"
    echo "📡 Port Assignment: Check run/port-registry.json for actual ports"
else
    echo "❌ Failed to start Mandrel"
    echo "📋 Check logs: tail logs/mandrel.log"
    rm -f ../logs/mandrel.pid
    exit 1
fi

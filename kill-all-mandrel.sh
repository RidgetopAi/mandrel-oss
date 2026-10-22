#!/bin/bash

# Kill ALL Mandrel processes - nuclear option
# Use when stop-mandrel.sh fails

echo "💥 Killing ALL Mandrel processes..."

# Find all Mandrel-related processes
MANDREL_PIDS=$(ps aux | grep -E "(mandrel|tsx.*server\.ts)" | grep -v grep | awk '{print $2}')

if [ ! -z "$MANDREL_PIDS" ]; then
    echo "🎯 Found Mandrel processes: $MANDREL_PIDS"
    echo "$MANDREL_PIDS" | xargs kill -9
    echo "✅ All Mandrel processes terminated"
    
    # Clean up PID files
    rm -f logs/mandrel.pid run/mandrel*.pid mcp-server/mandrel.pid
    echo "🧹 Cleaned up PID files"
else
    echo "ℹ️  No Mandrel processes found"
fi

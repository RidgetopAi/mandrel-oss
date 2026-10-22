#!/bin/bash

# Mandrel Simple Process Restarter
# Quick restart for development workflow

cd "$(dirname "$0")"

echo "🔄 Restarting Mandrel MCP Server..."

./stop-mandrel.sh
sleep 1
./start-mandrel.sh

echo "🎯 Mandrel restart complete!"

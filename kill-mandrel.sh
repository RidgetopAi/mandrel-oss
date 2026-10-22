#!/bin/bash
echo "🧹 Killing all Mandrel processes..."
pkill -f "src/server.ts" 2>/dev/null || true
pkill -f "mandrel" 2>/dev/null || true  
pkill -f "tsx.*server" 2>/dev/null || true
pkill -9 -f "src/server.ts" 2>/dev/null || true
lsof -ti:8080 | xargs kill -9 2>/dev/null || true
echo "✅ All Mandrel processes terminated"

#!/bin/sh
set -e

# Default to port 3000 if not set
PORT="${PORT:-3000}"

echo "Starting Moltbot Gateway on port $PORT..."
exec node dist/index.js gateway run --port "$PORT" --bind lan --allow-unconfigured

#!/bin/bash
set -e

cleanup() {
  # Kill child processes on exit
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$TUNNEL_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  wait "$TUNNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

PORT="${BACKEND_PORT:-3000}"

# Start the Factory Factory server in the background
node dist/src/cli/index.js serve --host 0.0.0.0 --no-open &
SERVER_PID=$!

# Wait for the server to become healthy
echo "Waiting for server to be ready..."
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${PORT}/health" > /dev/null 2>&1; then
    echo "Server is ready on port ${PORT}."
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server process exited unexpectedly."
    exit 1
  fi
  sleep 1
done

if ! curl -sf "http://localhost:${PORT}/health" > /dev/null 2>&1; then
  echo "Server failed to become healthy within 60 seconds."
  exit 1
fi

# Start cloudflared tunnel if enabled (default: true)
TUNNEL_PID=""
if [ "${ENABLE_TUNNEL:-true}" = "true" ]; then
  echo "Starting Cloudflare tunnel..."

  TUNNEL_LOG=$(mktemp)
  cloudflared tunnel --protocol http2 --url "http://localhost:${PORT}" > "$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  # Wait for the tunnel URL to appear in cloudflared output
  TUNNEL_URL=""
  for i in $(seq 1 30); do
    TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "cloudflared exited before tunnel URL was available."
      cat "$TUNNEL_LOG" 2>/dev/null || true
      rm -f "$TUNNEL_LOG"
      break
    fi
    sleep 1
  done

  # Tail the log in the background so ongoing cloudflared output is visible
  tail -f "$TUNNEL_LOG" &
  TAIL_PID=$!

  if [ -n "$TUNNEL_URL" ]; then
    echo ""
    echo "========================================"
    echo "  Tunnel URL: ${TUNNEL_URL}"
    echo "========================================"
    echo ""
    # Write tunnel URL to file (bind-mounted to host via docker-compose)
    mkdir -p /app/tunnel-info
    echo "$TUNNEL_URL" > /app/tunnel-info/url
  else
    echo "Warning: Could not detect tunnel URL. Check cloudflared logs above."
  fi
fi

# Wait for the server process — this keeps the container alive
wait "$SERVER_PID"

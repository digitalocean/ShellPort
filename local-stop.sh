#!/usr/bin/env bash
# local-stop.sh - Stop ShellPort and clean up (for testing)
# This does NOT delete the shellport/ directory (so you can re-run local-test.sh).
# To fully remove everything, run done.sh instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { echo "[shellport] $*"; }

echo ""
info "Stopping ShellPort..."

# Stop server
if [[ -f "${SCRIPT_DIR}/.server_pid" ]]; then
    PID="$(cat "${SCRIPT_DIR}/.server_pid")"
    kill "$PID" 2>/dev/null || true
    rm -f "${SCRIPT_DIR}/.server_pid"
    info "Server stopped (PID: ${PID})"
fi
lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true

# Kill IDEs attached to container
for app in "Visual Studio Code" "Code" "Cursor" "Cursor Helper" "Windsurf" "Windsurf Helper"; do
    killall "$app" 2>/dev/null || true
done

# Stop container
if command -v docker &>/dev/null; then
    docker compose -f "${SCRIPT_DIR}/docker-compose.yml" down -v --remove-orphans 2>/dev/null || true
    info "Container stopped and volume removed"
fi

# Clean state files
rm -f "${SCRIPT_DIR}/.session_snapshot.json" 2>/dev/null || true
rm -rf "${SCRIPT_DIR}/.timer" 2>/dev/null || true

echo ""
info "Stopped. Run ./local-test.sh to start again."
echo ""

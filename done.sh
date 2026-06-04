#!/usr/bin/env bash
# done.sh - ShellPort Cleanup (macOS / Linux)
# Removes the server, container, Docker volume, and the entire project directory.
# Does NOT touch host browsers, keychain, or credentials.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { echo "[interview] $*"; }
warn() { echo "[interview] WARN: $*" >&2; }

echo ""
info "Cleaning up interview environment..."

# Stop the web server
if [[ -f "${SCRIPT_DIR}/.server_pid" ]]; then
    SERVER_PID="$(cat "${SCRIPT_DIR}/.server_pid")"
    kill "${SERVER_PID}" 2>/dev/null || true
    kill -9 "${SERVER_PID}" 2>/dev/null || true
    info "Server stopped."
fi

# Kill IDEs
for app in "Visual Studio Code" "Code" "Cursor" "Cursor Helper" "Windsurf" "Windsurf Helper"; do
    killall "$app" 2>/dev/null || true
done
sleep 1

# Docker cleanup - scoped to ShellPort only; never a global prune.
if command -v docker &>/dev/null; then
    docker compose -f "${SCRIPT_DIR}/docker-compose.yml" down -v --remove-orphans 2>/dev/null || true
fi

info "Removing ${SCRIPT_DIR}..."

# Self-destruct
cd "${HOME}"
rm -rf "${SCRIPT_DIR}"

echo ""
info "ShellPort removed. Nothing left behind."
echo ""

#!/usr/bin/env bash
# admin-done.sh - ShellPort Event Teardown (macOS / Linux)
# End-of-event cleanup for DO stations. Purges everything including
# Cursor and Claude accounts, then removes ShellPort itself.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { echo "[interview] $*"; }
warn() { echo "[interview] WARN: $*" >&2; }

echo ""
info "Tearing down interview station..."

# Stop the web server
if [[ -f "${SCRIPT_DIR}/.server_pid" ]]; then
    SERVER_PID="$(cat "${SCRIPT_DIR}/.server_pid")"
    kill "${SERVER_PID}" 2>/dev/null || true
    kill -9 "${SERVER_PID}" 2>/dev/null || true
    info "Server stopped."
fi

# Kill IDEs
for app in "Visual Studio Code" "Code" "Cursor" "Cursor Helper" "Windsurf" "Windsurf Helper" "Claude"; do
    killall "$app" 2>/dev/null || true
done
sleep 1

# Docker cleanup
if command -v docker &>/dev/null; then
    docker compose -f "${SCRIPT_DIR}/docker-compose.yml" down -v --remove-orphans 2>/dev/null || true
fi

# All credentials
for d in .config/gh .config/doctl .ssh .gitconfig .git-credentials .netrc \
         .claude .config/claude .config/Claude .anthropic .config/anthropic \
         .aider .config/aider .codeium .config/codeium \
         .continue .config/continue .copilot .config/copilot; do
    rm -rf "${HOME:?}/${d}" 2>/dev/null || true
done

info "Removing ${SCRIPT_DIR}..."

# Self-destruct
cd "${HOME}"
rm -rf "${SCRIPT_DIR}"

echo ""
info "Station teardown complete."
echo ""

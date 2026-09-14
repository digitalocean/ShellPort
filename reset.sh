#!/usr/bin/env bash
# reset.sh - ShellPort Station Reset (macOS / Linux)
# Resets a DO station between candidates. Scrubs credentials and session
# files but keeps ShellPort, Cursor, and Claude accounts intact.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { echo "[interview] $*"; }
warn() { echo "[interview] WARN: $*" >&2; }

echo ""
info "Resetting interview station..."

# Stop the web server
if [[ -f "${SCRIPT_DIR}/.server_pid" ]]; then
    SERVER_PID="$(cat "${SCRIPT_DIR}/.server_pid")"
    kill "${SERVER_PID}" 2>/dev/null || true
    kill -9 "${SERVER_PID}" 2>/dev/null || true
    info "Server stopped."
fi

# Kill IDEs (Cursor and Claude stay running — accounts stay logged in)
for app in "Visual Studio Code" "Code" "Windsurf" "Windsurf Helper"; do
    killall "$app" 2>/dev/null || true
done
sleep 1

# Docker cleanup
if command -v docker &>/dev/null; then
    docker compose -f "${SCRIPT_DIR}/docker-compose.yml" down -v --remove-orphans 2>/dev/null || true
fi

# Session files
for f in .session_snapshot .session_snapshot.json .current_question question.pdf; do
    rm -f "${SCRIPT_DIR}/${f}" 2>/dev/null || true
done
rm -rf "${SCRIPT_DIR}/.timer" 2>/dev/null || true

# Candidate credentials (.claude and Cursor config intentionally kept)
for d in .config/gh .config/doctl .ssh .gitconfig .git-credentials .netrc \
         .anthropic .config/anthropic .aider .config/aider \
         .codeium .config/codeium .continue .config/continue \
         .copilot .config/copilot; do
    rm -rf "${HOME:?}/${d}" 2>/dev/null || true
done

echo ""
info "Station reset. Ready for next candidate."
echo ""

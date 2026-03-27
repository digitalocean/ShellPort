#!/usr/bin/env bash
# local-test.sh - ShellPort local testing setup
# Run this from the shellport/ directory after unzipping.
# This replaces install.sh for local testing (install.sh downloads from GitHub Releases,
# which won't work until you push the repo and create a release).

set -euo pipefail

info() { echo "[shellport] $*"; }
warn() { echo "[shellport] WARN: $*" >&2; }
die()  { echo "[shellport] ERROR: $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "  ShellPort - Local Test"
echo ""

# Step 1: Check prerequisites
info "Checking prerequisites..."

command -v docker &>/dev/null || die "Docker not found. Install OrbStack: brew install orbstack"
docker info &>/dev/null 2>&1 || die "Docker is not running. Open OrbStack and wait for it to start."
command -v node &>/dev/null || die "Node.js not found. Install: brew install node"

info "Docker: running"
info "Node.js: $(node --version)"

# Step 2: Check for an IDE
IDE_FOUND="false"
for app in "/Applications/Visual Studio Code.app" "/Applications/Cursor.app" "/Applications/Windsurf.app"; do
    if [[ -d "$app" ]]; then
        info "IDE: $(basename "$app" .app)"
        IDE_FOUND="true"
        break
    fi
done
if [[ "$IDE_FOUND" == "false" ]]; then
    warn "No IDE found. The Browser button (code-server) will still work."
fi

# Step 3: Install server dependencies
info "Installing server dependencies..."
cd "${SCRIPT_DIR}/app"
npm install --production 2>/dev/null
cd "${SCRIPT_DIR}"

# Step 4: Kill any previous ShellPort server
if [[ -f "${SCRIPT_DIR}/.server_pid" ]]; then
    OLD_PID="$(cat "${SCRIPT_DIR}/.server_pid")"
    kill "$OLD_PID" 2>/dev/null || true
    rm -f "${SCRIPT_DIR}/.server_pid"
    info "Stopped previous server (PID: ${OLD_PID})"
fi

# Also kill any node process on port 3000
lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true

# Step 5: Build .env from defaults + SHELLPORT_ env vars
ENV_FILE="${SCRIPT_DIR}/.env"
if [[ -f "${SCRIPT_DIR}/.env.defaults" ]]; then
    cp "${SCRIPT_DIR}/.env.defaults" "${ENV_FILE}"
elif [[ ! -f "${ENV_FILE}" ]]; then
    touch "${ENV_FILE}"
fi
{
    [[ -n "${SHELLPORT_WEBHOOK:-}" ]]       && echo "QUESTION_WEBHOOK=\"${SHELLPORT_WEBHOOK}\""
    [[ -n "${SHELLPORT_QUESTIONS:-}" ]]     && echo "QUESTIONS_URL=\"${SHELLPORT_QUESTIONS}\""
    [[ -n "${SHELLPORT_QUESTION_ROW:-}" ]]  && echo "QUESTION_ROW=\"${SHELLPORT_QUESTION_ROW}\""
    [[ -n "${SHELLPORT_DO_TOKEN:-}" ]]      && echo "DO_TOKEN=\"${SHELLPORT_DO_TOKEN}\""
    [[ -n "${SHELLPORT_SPACES_BUCKET:-}" ]] && echo "SPACES_BUCKET=\"${SHELLPORT_SPACES_BUCKET}\""
    [[ -n "${SHELLPORT_SPACES_REGION:-}" ]] && echo "SPACES_REGION=\"${SHELLPORT_SPACES_REGION}\""
    [[ -n "${SHELLPORT_PROJECT:-}" ]]       && echo "PROJECT_NAME=\"${SHELLPORT_PROJECT}\""
    true
} >> "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

# Step 6: Start the server
info "Starting ShellPort server..."
cd "${SCRIPT_DIR}/app"
node server.js &
SERVER_PID=$!
echo "${SERVER_PID}" > "${SCRIPT_DIR}/.server_pid"
disown "${SERVER_PID}" 2>/dev/null || true
cd "${SCRIPT_DIR}"

sleep 2

# Verify server started
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    die "Server failed to start. Check app/server.js for errors."
fi

# Step 6: Open browser
open "http://localhost:3000"

echo ""
info "ShellPort is running at http://localhost:3000"
info "Server PID: ${SERVER_PID}"
echo ""
echo "  The dashboard is open in your browser."
echo "  First build takes 5-15 minutes. Watch the progress."
echo ""
echo "  When done testing, run:"
echo "    ./local-stop.sh"
echo ""

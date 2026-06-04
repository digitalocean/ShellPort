#!/usr/bin/env bash
# admin-install.sh - ShellPort Admin Installer (macOS / Linux)
# For company-owned DO interview stations. Downloads the admin release package,
# which includes the admin/ overlay; that overlay is what marks the machine as a
# managed DO station (ADMIN_MODE), enabling Recycle / End Event and the host scrub.
# Shortlink (go-link points here):
#   Admin (company machine):   curl -fsSL https://do.co/shellport-admin-mac | bash
# Candidates on their own machine should use install.sh (the universal package),
# which never installs the admin overlay.

set -euo pipefail

REPO="digitalocean/shellport"
INSTALL_DIR="${HOME}/shellport"

info() { echo "[shellport] $*"; }
warn() { echo "[shellport] WARN: $*" >&2; }
die()  { echo "[shellport] ERROR: $*" >&2; exit 1; }

echo ""
echo "  ShellPort (Admin)"
echo "  Managed DO interview station"
echo ""

# Prerequisites
command -v docker &>/dev/null || die "Docker not found. Install OrbStack (https://orbstack.dev) or Docker Desktop first."
docker info &>/dev/null 2>&1 || die "Docker is not running. Start Docker and try again."
command -v node &>/dev/null || die "Node.js not found. Install from https://nodejs.org first."

# Clean previous install
[[ -d "${INSTALL_DIR}" ]] && { info "Removing previous installation..."; rm -rf "${INSTALL_DIR}"; }

# Resolve version
if [[ -n "${INTERVIEW_VERSION:-}" ]]; then
    VERSION="${INTERVIEW_VERSION}"
else
    VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4)"
    [[ -z "$VERSION" ]] && die "Could not detect latest release."
fi
info "Version: ${VERSION} (admin)"

# Download and extract the admin package (includes the admin/ overlay)
TARBALL_URL="https://github.com/${REPO}/releases/download/${VERSION}/shellport-${VERSION}-admin.tar.gz"
info "Downloading..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL "${TARBALL_URL}" | tar -xz -C "${INSTALL_DIR}"

# Build .env: start with baked defaults, layer secrets from environment
info "Configuring..."
ENV_FILE="${INSTALL_DIR}/.env"

# Start with baked defaults
if [[ -f "${INSTALL_DIR}/.env.defaults" ]]; then
    cp "${INSTALL_DIR}/.env.defaults" "${ENV_FILE}"
else
    touch "${ENV_FILE}"
fi

# Append secrets from SHELLPORT_ environment variables (never in the release)
{
    [[ -n "${SHELLPORT_WEBHOOK:-}" ]]       && echo "QUESTION_WEBHOOK=\"${SHELLPORT_WEBHOOK}\""
    [[ -n "${SHELLPORT_QUESTIONS:-}" ]]     && echo "QUESTIONS_URL=\"${SHELLPORT_QUESTIONS}\""
    [[ -n "${SHELLPORT_QUESTION_ROW:-}" ]]  && echo "QUESTION_ROW=\"${SHELLPORT_QUESTION_ROW}\""
    [[ -n "${SHELLPORT_QUESTION_TAB:-}" ]]  && echo "QUESTION_TAB=\"${SHELLPORT_QUESTION_TAB}\""
    [[ -n "${SHELLPORT_PROJECT:-}" ]]       && echo "PROJECT_NAME=\"${SHELLPORT_PROJECT}\""
    [[ -n "${SHELLPORT_LABEL:-}" ]]         && echo "MACHINE_LABEL=\"${SHELLPORT_LABEL}\""
} >> "${ENV_FILE}"

chmod 600 "${ENV_FILE}"

cd "${INSTALL_DIR}/app"

# Install server dependencies
info "Installing dependencies..."
npm install --production --silent 2>/dev/null

# Start the web app
info "Starting ShellPort..."
node server.js &
SERVER_PID=$!
echo "${SERVER_PID}" > "${INSTALL_DIR}/.server_pid"
disown "${SERVER_PID}" 2>/dev/null || true

sleep 2

# Open browser
if command -v open &>/dev/null; then
    open "http://localhost:3000"
elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:3000"
fi

echo ""
info "ShellPort is running at http://localhost:3000"
echo ""
info "This is a managed station: Recycle and End Event are available"
info "in the dashboard after unlocking with the machine's OS-user password."
echo ""

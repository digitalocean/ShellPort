#!/usr/bin/env bash
# admin/macos/install.sh - ShellPort Admin Installer (macOS / Linux)
# For company-owned DO interview stations. Downloads the admin release package,
# which includes the admin/ overlay; that overlay is what marks the machine as a
# managed DO station (ADMIN_MODE), enabling Recycle / End Event and the host scrub.
# Shortlink (go-link points here):
#   Admin (company machine):   curl -fsSL https://do.co/shellport-admin-mac | bash
# Candidates on their own machine should use install.sh (the universal package),
# which never installs the admin overlay.

set -euo pipefail

REPO="digitalocean/shellport"
SELF_URL="https://do.co/shellport-admin-mac"   # canonical source of this installer
INSTALL_DIR="${HOME}/shellport"

# MDM/root re-exec (macOS): ShellPort is per-user, but Jamf runs as root. When root
# with a desktop user present, re-run as that user in their GUI session so HOME,
# PATH, Docker and the browser resolve. Lets the one-liner work interactively and via MDM.
if [ "$(uname)" = "Darwin" ] && [ "$(id -u)" -eq 0 ]; then
  consoleUser="$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || true)"
  case "${consoleUser:-}" in
    ""|root|loginwindow|_mbsetupuser)
      echo "[shellport] No desktop user is logged in — will run at the next user login."
      exit 0 ;;   # exit 0 so the MDM can re-run on a login-triggered policy
  esac
  consoleUID="$(/usr/bin/id -u "$consoleUser")"
  # Forward any SHELLPORT_* / version config the MDM set in root's environment.
  prelude=""
  for v in SHELLPORT_WEBHOOK SHELLPORT_SLACK_TOKEN SHELLPORT_SLACK_CHANNEL \
           SHELLPORT_QUESTIONS SHELLPORT_QUESTION_ROW SHELLPORT_QUESTION_TAB \
           SHELLPORT_PROJECT SHELLPORT_LABEL INTERVIEW_VERSION; do
    eval "val=\${$v:-}"
    [ -n "${val}" ] && prelude+="export ${v}=$(printf %q "${val}"); "
  done
  echo "[shellport] Running as ${consoleUser}…"
  exec launchctl asuser "${consoleUID}" sudo -u "${consoleUser}" /bin/bash -lc \
    "${prelude}curl -fsSL ${SELF_URL} | /bin/bash"
fi

info() { echo "[shellport] $*"; }
warn() { echo "[shellport] WARN: $*" >&2; }
die()  { echo "[shellport] ERROR: $*" >&2; exit 1; }

echo ""
echo "  ShellPort (Admin)"
echo "  Managed DO interview station"
echo ""

# Prerequisites — auto-install on managed stations
if ! command -v node &>/dev/null; then
    info "Node.js not found. Installing..."
    if command -v brew &>/dev/null; then
        brew install node
    else
        NODE_PKG="/tmp/node-latest.pkg"
        curl -fsSL "https://nodejs.org/dist/latest/node-latest.pkg" -o "${NODE_PKG}" \
            || die "Could not download Node.js. Install manually from https://nodejs.org"
        sudo installer -pkg "${NODE_PKG}" -target / || die "Node.js installation failed."
        rm -f "${NODE_PKG}"
    fi
    command -v node &>/dev/null || die "Node.js installation failed."
    info "Node.js $(node --version) installed."
fi

if ! command -v docker &>/dev/null; then
    info "Docker not found. Installing OrbStack..."
    if command -v brew &>/dev/null; then
        brew install orbstack
    else
        ORB_PKG="/tmp/OrbStack.dmg"
        curl -fsSL "https://orbstack.dev/download/stable/latest" -o "${ORB_PKG}" \
            || die "Could not download OrbStack. Install manually from https://orbstack.dev"
        hdiutil attach "${ORB_PKG}" -nobrowse -quiet
        cp -R "/Volumes/OrbStack/OrbStack.app" /Applications/ 2>/dev/null || true
        hdiutil detach "/Volumes/OrbStack" -quiet 2>/dev/null || true
        rm -f "${ORB_PKG}"
    fi
    open -a OrbStack
    info "Waiting for OrbStack to start..."
    for i in $(seq 1 60); do
        docker info &>/dev/null 2>&1 && break
        sleep 2
    done
    command -v docker &>/dev/null || die "OrbStack installation failed."
    info "OrbStack installed."
fi

if ! docker info &>/dev/null 2>&1; then
    info "Docker not running. Starting OrbStack..."
    open -a OrbStack 2>/dev/null || orbctl start 2>/dev/null || true
    for i in $(seq 1 30); do
        docker info &>/dev/null 2>&1 && break
        sleep 2
    done
    docker info &>/dev/null 2>&1 || die "Docker failed to start. Launch OrbStack manually."
    info "OrbStack running."
fi

# Set OrbStack to start at login
defaults write com.orbstack.OrbStack AutoStart -bool true 2>/dev/null || true

# Install host-level tools (mirrors container so candidates don't need to install anything)
if command -v brew &>/dev/null; then
    info "Installing interview tools on host..."
    brew update 2>/dev/null || true
    brew install go python@3 openjdk@21 node gh doctl kubectl terraform \
        s3cmd ripgrep jq yq neovim imagemagick helm tree httpie 2>/dev/null || true
    brew upgrade 2>/dev/null || true
    # Symlink Java so it's on PATH
    sudo ln -sfn "$(brew --prefix openjdk@21)/libexec/openjdk.jdk" \
        /Library/Java/JavaVirtualMachines/openjdk-21.jdk 2>/dev/null || true
    # Claude Code
    if command -v npm &>/dev/null; then
        npm install -g @anthropic-ai/claude-code 2>/dev/null || true
    fi
    info "Host tools installed."
else
    warn "Homebrew not found — host tools not installed. Candidates may try to install their own."
fi

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
    [[ -n "${SHELLPORT_SLACK_TOKEN:-}" ]]   && echo "SLACK_BOT_TOKEN=\"${SHELLPORT_SLACK_TOKEN}\""
    [[ -n "${SHELLPORT_SLACK_CHANNEL:-}" ]] && echo "SLACK_CHANNEL=\"${SHELLPORT_SLACK_CHANNEL}\""
    [[ -n "${SHELLPORT_QUESTIONS:-}" ]]     && echo "QUESTIONS_URL=\"${SHELLPORT_QUESTIONS}\""
    [[ -n "${SHELLPORT_QUESTION_ROW:-}" ]]  && echo "QUESTION_ROW=\"${SHELLPORT_QUESTION_ROW}\""
    [[ -n "${SHELLPORT_QUESTION_TAB:-}" ]]  && echo "QUESTION_TAB=\"${SHELLPORT_QUESTION_TAB}\""
    [[ -n "${SHELLPORT_PROJECT:-}" ]]       && echo "PROJECT_NAME=\"${SHELLPORT_PROJECT}\""
    [[ -n "${SHELLPORT_LABEL:-}" ]]         && echo "MACHINE_LABEL=\"${SHELLPORT_LABEL}\""
} >> "${ENV_FILE}"

chmod 600 "${ENV_FILE}"
chmod +x "${INSTALL_DIR}/done.sh" 2>/dev/null || true
chmod +x "${INSTALL_DIR}/admin/macos/install.sh" "${INSTALL_DIR}/admin/macos/done.sh" "${INSTALL_DIR}/admin/macos/reset.sh" 2>/dev/null || true

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

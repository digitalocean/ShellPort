#!/usr/bin/env bash
# reset.sh - ShellPort Full Host Teardown (macOS / Jamf)
# Run as root. Supports --batch for non-interactive execution from the dashboard.
#
# Usage:
#   sudo ./admin/macos/reset.sh [project_path] [--batch] [--log /path/to/log]

set -uo pipefail
# NOTE: not using -e because security/killall commands fail normally when entries don't exist

info() { echo "[reset] $*"; }
warn() { echo "[reset] WARN: $*"; }
die()  { echo "[reset] ERROR: $*"; exit 1; }

[[ "$EUID" -ne 0 ]] && die "Must be run as root."

# Parse arguments
BATCH=false
LOG_FILE=""
PROJECT_ROOT=""
LOG_FILE_NEXT=""

for arg in "$@"; do
    case "$arg" in
        --batch) BATCH=true ;;
        --log) :;; # next arg is the path
        *) 
            if [[ -n "$LOG_FILE_NEXT" ]]; then
                LOG_FILE="$arg"
                LOG_FILE_NEXT=""
            elif [[ -d "$arg" || "$arg" == /* ]]; then
                PROJECT_ROOT="$arg"
            fi
            ;;
    esac
    [[ "$arg" == "--log" ]] && LOG_FILE_NEXT=true || LOG_FILE_NEXT=""
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Discover project root
if [[ -n "$PROJECT_ROOT" && -f "${PROJECT_ROOT}/docker-compose.yml" ]]; then
    PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
elif [[ -f "${SCRIPT_DIR}/../../docker-compose.yml" ]]; then
    PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
fi

# Discover GUI user
GUI_USER="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
[[ -z "$GUI_USER" || "$GUI_USER" == "root" ]] && GUI_USER="$(who | awk 'NR==1 {print $1}')"
[[ -z "$GUI_USER" || "$GUI_USER" == "root" ]] && die "Cannot determine GUI user."

GUI_HOME="/Users/${GUI_USER}"

if [[ -z "$PROJECT_ROOT" ]]; then
    DEFAULT_INSTALL="${GUI_HOME}/shellport"
    if [[ -f "${DEFAULT_INSTALL}/docker-compose.yml" ]]; then
        PROJECT_ROOT="${DEFAULT_INSTALL}"
    else
        die "Cannot find shellport. Pass the path: sudo $0 /path/to/shellport"
    fi
fi

MARKER_FILE="${PROJECT_ROOT}/.last_station_reset"
ENV_FILE="${PROJECT_ROOT}/.env"

# Load .env
if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r k v; do
        [[ -z "$k" || "$k" =~ ^# ]] && continue
        v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
        export "${k}=${v}"
    done < "$ENV_FILE"
fi

as_user() { su - "${GUI_USER}" -c "$*" 2>/dev/null; }

info "User: ${GUI_USER}"
info "Project: ${PROJECT_ROOT}"
info "Batch: ${BATCH}"

# ========== PHASE 1: Kill ==========
info "Phase 1: Kill — stopping browsers and IDEs"

for app in "Google Chrome" "Safari" "Firefox" "Microsoft Edge" "Brave Browser" "Arc" \
    "Visual Studio Code" "Code" "Cursor" "Cursor Helper" "Windsurf" "Windsurf Helper" "Claude"; do
    killall -9 "$app" 2>/dev/null || true
done
sleep 2
info "Phase 1: Kill — complete"

# ========== PHASE 2: Audit ==========
info "Phase 2: Audit — logging file modifications"

DELTA_LOG="${GUI_HOME}/Desktop/reset_audit_$(date +%Y%m%d_%H%M%S).txt"
{
    echo "Reset Audit - $(date)"
    echo "User: ${GUI_USER}"
    echo ""
    if [[ -f "$MARKER_FILE" ]]; then
        echo "Files modified since last reset ($(cat "$MARKER_FILE")):"
        find "${GUI_HOME}" \
            \( -path "${GUI_HOME}/Library/Caches" -prune \
            -o -path "${GUI_HOME}/Library/Logs" -prune \
            -o -path "${GUI_HOME}/.Trash" -prune \) \
            -o \( -newer "${MARKER_FILE}" -type f -print \) 2>/dev/null | sort || true
    else
        echo "No marker file. First reset on this machine."
    fi
} > "${DELTA_LOG}" 2>/dev/null || true
chown "${GUI_USER}" "${DELTA_LOG}" 2>/dev/null || true
info "Phase 2: Audit — complete (${DELTA_LOG})"

# ========== PHASE 3: Docker wipe ==========
info "Phase 3: Docker — removing containers and volumes"

as_user "cd '${PROJECT_ROOT}' && docker compose down -v --remove-orphans" || true
CONTAINERS="$(as_user 'docker ps -aq' || true)"
[[ -n "$CONTAINERS" ]] && as_user "docker rm -f ${CONTAINERS}" || true
VOLUMES="$(as_user 'docker volume ls -q' || true)"
[[ -n "$VOLUMES" ]] && as_user "docker volume rm ${VOLUMES}" || true
as_user "docker system prune -af --volumes" || true
info "Phase 3: Docker — complete"

# ========== PHASE 4: CLI/agent scrub ==========
info "Phase 4: CLI — scrubbing credentials and agent state"

as_user "gh auth logout --hostname github.com" || true
as_user "doctl auth remove --context default" || true

for dir in \
    "${GUI_HOME}/.config/gh" "${GUI_HOME}/.config/doctl" \
    "${GUI_HOME}/.ssh" "${GUI_HOME}/.gitconfig" "${GUI_HOME}/.git-credentials" "${GUI_HOME}/.netrc" \
    "${GUI_HOME}/.claude" "${GUI_HOME}/.config/claude" "${GUI_HOME}/.config/Claude" \
    "${GUI_HOME}/.anthropic" "${GUI_HOME}/.config/anthropic" \
    "${GUI_HOME}/Library/Application Support/claude" "${GUI_HOME}/Library/Application Support/Claude" \
    "${GUI_HOME}/Library/Caches/claude" "${GUI_HOME}/Library/Caches/Claude" \
    "${GUI_HOME}/.aider" "${GUI_HOME}/.config/aider" \
    "${GUI_HOME}/.codeium" "${GUI_HOME}/.config/codeium" \
    "${GUI_HOME}/.continue" "${GUI_HOME}/.config/continue" \
    "${GUI_HOME}/.copilot" "${GUI_HOME}/.config/copilot"; do
    [[ -e "$dir" ]] && rm -rf "$dir" 2>/dev/null || true
done

# Scrub tokens from .env
if [[ -f "$ENV_FILE" ]]; then
    sed -i '' 's/^GH_TOKEN=.*/GH_TOKEN=""/' "${ENV_FILE}" 2>/dev/null || true
fi
info "Phase 4: CLI — complete"

# ========== PHASE 5: Keychain purge ==========
info "Phase 5: Keychain — purging credential entries"

_purge() {
    local svc="$1"
    su - "${GUI_USER}" -c "security delete-generic-password  -s '${svc}' 2>/dev/null; true" 2>/dev/null
    su - "${GUI_USER}" -c "security delete-generic-password  -l '${svc}' 2>/dev/null; true" 2>/dev/null
    su - "${GUI_USER}" -c "security delete-internet-password -s '${svc}' 2>/dev/null; true" 2>/dev/null
    su - "${GUI_USER}" -c "security delete-internet-password -l '${svc}' 2>/dev/null; true" 2>/dev/null
}

for svc in \
    "gh:github.com" "git:https://github.com" "github.com" "api.github.com" \
    "vscodevscode.github-authentication" "cursorcursor.github-authentication" \
    "cursor.github-authentication" "vscode.github-authentication" \
    "windsurfwindsurf.github-authentication" "windsurf.github-authentication" \
    "Chrome Safe Storage" "Chromium Safe Storage" "Microsoft Edge Safe Storage" \
    "Brave Safe Storage" "Arc Safe Storage" "Firefox Safe Storage" "Safari Safe Storage" \
    "docker-credential-osxkeychain" "Docker Credentials" "Claude Safe Storage" \
    "Windsurf Safe Storage" "claude" "anthropic" "doctl"; do
    _purge "$svc"
done
info "Phase 5: Keychain — complete"

# ========== PHASE 6: Deep clean IDEs and browsers ==========
info "Phase 6: Deep clean — wiping IDE and browser data"

for target in \
    "${GUI_HOME}/Library/Application Support/Code" \
    "${GUI_HOME}/Library/Caches/com.microsoft.VSCode" \
    "${GUI_HOME}/Library/Saved Application State/com.microsoft.VSCode.savedState" \
    "${GUI_HOME}/Library/Application Support/Cursor" \
    "${GUI_HOME}/Library/Caches/Cursor" \
    "${GUI_HOME}/Library/Saved Application State/com.todesktop.230313mzl4w4u92.savedState" \
    "${GUI_HOME}/Library/Application Support/Windsurf" \
    "${GUI_HOME}/Library/Caches/Windsurf" \
    "${GUI_HOME}/Library/Saved Application State/com.codeium.windsurf.savedState" \
    "${GUI_HOME}/Library/Application Support/Claude" \
    "${GUI_HOME}/Library/Caches/Claude" \
    "${GUI_HOME}/Library/Saved Application State/com.anthropic.claudefordesktop.savedState" \
    "${GUI_HOME}/Library/Application Support/Google/Chrome" \
    "${GUI_HOME}/Library/Caches/com.google.Chrome" \
    "${GUI_HOME}/Library/Saved Application State/com.google.Chrome.savedState" \
    "${GUI_HOME}/Library/Preferences/com.google.Chrome.plist" \
    "${GUI_HOME}/Library/Application Support/Microsoft Edge" \
    "${GUI_HOME}/Library/Caches/Microsoft Edge" \
    "${GUI_HOME}/Library/Saved Application State/com.microsoft.edgemac.savedState" \
    "${GUI_HOME}/Library/Application Support/BraveSoftware/Brave-Browser" \
    "${GUI_HOME}/Library/Caches/BraveSoftware" \
    "${GUI_HOME}/Library/Saved Application State/com.brave.Browser.savedState" \
    "${GUI_HOME}/Library/Application Support/Arc" \
    "${GUI_HOME}/Library/Caches/Arc" \
    "${GUI_HOME}/Library/Saved Application State/company.thebrowser.Browser.savedState" \
    "${GUI_HOME}/Library/Application Support/Firefox" \
    "${GUI_HOME}/Library/Caches/Firefox" \
    "${GUI_HOME}/Library/Saved Application State/org.mozilla.firefox.savedState" \
    "${GUI_HOME}/Library/Safari/History.db" "${GUI_HOME}/Library/Safari/History.db-wal" \
    "${GUI_HOME}/Library/Safari/History.db-shm" "${GUI_HOME}/Library/Safari/LastSession.plist" \
    "${GUI_HOME}/Library/Safari/RecentlyClosedTabs.plist" "${GUI_HOME}/Library/Safari/Downloads.plist" \
    "${GUI_HOME}/Library/Containers/com.apple.Safari" \
    "${GUI_HOME}/Library/Preferences/com.apple.Safari.plist" \
    "${GUI_HOME}/Library/WebKit"; do
    [[ -e "$target" ]] && rm -rf "$target" 2>/dev/null || true
done
info "Phase 6: Deep clean — complete"

# ========== PHASE 7: Rebuild ==========
info "Phase 7: Rebuild — clearing history and trash"

as_user "osascript -e 'tell application \"Finder\" to empty trash'" 2>/dev/null || \
    rm -rf "${GUI_HOME}/.Trash/"* 2>/dev/null || true

for hist in \
    "${GUI_HOME}/.zsh_history" "${GUI_HOME}/.bash_history" \
    "${GUI_HOME}/.local/share/fish/fish_history" "${GUI_HOME}/.node_repl_history" \
    "${GUI_HOME}/.python_history" "${GUI_HOME}/.lesshst" "${GUI_HOME}/.viminfo"; do
    [[ -f "$hist" ]] && { : > "$hist"; chown "${GUI_USER}" "$hist" 2>/dev/null || true; }
done

rm -f "${PROJECT_ROOT}/.session_snapshot" "${PROJECT_ROOT}/.session_snapshot.json" 2>/dev/null || true
rm -rf "${PROJECT_ROOT}/.timer" 2>/dev/null || true
rm -f "${PROJECT_ROOT}/.current_question" 2>/dev/null || true
info "Phase 7: Rebuild — complete"

# ========== PHASE 8: Verify ==========
info "Phase 8: Verify — checking for residue"

VERIFY_FAILURES=0
for check_dir in \
    "${GUI_HOME}/.config/gh" "${GUI_HOME}/.ssh" "${GUI_HOME}/.gitconfig" \
    "${GUI_HOME}/.git-credentials" "${GUI_HOME}/.claude" "${GUI_HOME}/.anthropic" \
    "${GUI_HOME}/Library/Application Support/Google/Chrome" \
    "${GUI_HOME}/Library/Application Support/Microsoft Edge" \
    "${GUI_HOME}/Library/Application Support/Firefox" \
    "${GUI_HOME}/Library/Application Support/BraveSoftware/Brave-Browser" \
    "${GUI_HOME}/Library/Application Support/Arc" \
    "${GUI_HOME}/Library/Application Support/Code" \
    "${GUI_HOME}/Library/Application Support/Cursor" \
    "${GUI_HOME}/Library/Application Support/Windsurf"; do
    if [[ -e "$check_dir" ]]; then
        warn "VERIFY FAIL: ${check_dir} still exists"
        VERIFY_FAILURES=$(( VERIFY_FAILURES + 1 ))
    fi
done

DOCKER_CONTAINERS="$(as_user 'docker ps -aq' || true)"
[[ -n "$DOCKER_CONTAINERS" ]] && { warn "VERIFY FAIL: Docker containers still exist"; VERIFY_FAILURES=$((VERIFY_FAILURES+1)); }
DOCKER_VOLUMES="$(as_user 'docker volume ls -q' || true)"
[[ -n "$DOCKER_VOLUMES" ]] && { warn "VERIFY FAIL: Docker volumes still exist"; VERIFY_FAILURES=$((VERIFY_FAILURES+1)); }

if [[ "$VERIFY_FAILURES" -eq 0 ]]; then
    info "Phase 8: Verify — passed. Zero residue."
else
    warn "Phase 8: Verify — ${VERIFY_FAILURES} issue(s) found. Review log."
fi

# ========== Marker file ==========
RESET_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo "${RESET_TS}" > "${MARKER_FILE}"
chown "${GUI_USER}" "${MARKER_FILE}"
info "Marker written: ${MARKER_FILE}"

# ========== Done ==========
info "Teardown complete. ${RESET_TS} | User: ${GUI_USER}"

# In batch mode, skip interactive prompts and don't rebuild (server handles that)
if [[ "$BATCH" == "true" ]]; then
    exit 0
fi

# Interactive mode: offer to start next session
su - "${GUI_USER}" -c "osascript -e 'display notification \"Environment is clean and ready.\" with title \"Station Reset Complete\"' 2>/dev/null" || true

read -r -p "[reset] Start next session now? (Y/n): " ans
if [[ ! "$ans" =~ ^[nN] ]]; then
    exec su - "${GUI_USER}" -c "cd '${PROJECT_ROOT}' && cd app && node server.js"
fi

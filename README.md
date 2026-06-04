# ShellPort

Ephemeral coding interview workstation. Any computer. One command to install. A browser-based dashboard to manage. One click to remove. Always the latest tools.

---

## Install

Two entry points, same installer. Admins set up company-owned machines; candidates set up their own machine for a remote interview.

**Admin (company-owned machine):**

```bash
# macOS / Linux
curl -fsSL https://do.co/shellport-admin-mac | bash
```

```powershell
# Windows (PowerShell)
irm https://do.co/shellport-admin-win | iex
```

**Candidate (remote BYOD):**

```bash
# macOS / Linux
curl -fsSL https://do.co/shellport-macos | bash
```

```powershell
# Windows (PowerShell)
irm https://do.co/shellport-windows | iex
```

Prerequisites: Docker (running) and Node.js. The installer handles everything else.

Your browser opens to `http://localhost:3000`. The dashboard shows setup progress in real time. When the container is ready, click any IDE to start coding.

---

## The Dashboard

The dashboard runs locally at `localhost:3000`. No cloud. No external services. Everything stays on the machine.

**During setup:**

The dashboard shows each step as it completes: Docker check, container build, code-server install, and optional question loading. The interview question (if enabled) appears while the environment builds, giving the candidate something to read.

**When ready:**

IDE launch buttons appear for every editor detected on the machine — VS Code, VS Code Insiders, Cursor, Windsurf, and VSCodium — plus always-available web options: Browser (code-server), github.dev, GitHub Codespaces, and DevPod. The candidate clicks one. The "Browser" button opens a full VS Code environment in the browser with no local IDE required.

**During cleanup:**

The dashboard shows each cleanup step: telemetry export (if enabled), IDE kill, container teardown (ShellPort's own container and volume only — never a host-wide Docker prune), and post-cleanup verification. If any residue is detected (new credentials, leftover files), the dashboard reports exactly what was found.

---

## Code

The IDE opens inside an isolated container with everything pre-installed: Go, Python, Java, Node.js, C/C++, TypeScript, GitHub Copilot, Claude Code, GitHub CLI, doctl, Homebrew, neovim, jq, yq. All tools are the latest version at install time.

A terminal summary prints every version when the container starts. All work must be saved inside `/workspaces`.

---

## Done

The candidate clicks "End Interview" in the dashboard, or runs the cleanup script directly:

**macOS / Linux:** `~/shellport/done.sh`

**Windows:** `~\shellport\Done.ps1`

This stops the server, kills IDE processes, tears down ShellPort's own container and Docker volume, and deletes the project directory. It is scoped to ShellPort — it does not run a host-wide Docker prune and does not touch unrelated images, volumes, browsers, or credentials.

### Recycle vs. End Event (operator)

Two operator actions, both gated behind OS-level admin authentication (macOS/Linux `sudo`/`pkexec`, Windows UAC) so a candidate session can't reach them:

- **Recycle** (DO interview station): scrub the host and load a fresh question for the next candidate, without rebuilding the machine.
- **End Event**: tear down the workstation. On a DO station it can power the machine off after confirmation; on a BYOD machine it returns the command to fully uninstall ShellPort.

ShellPort detects its machine type. On a candidate's own machine (BYOD) it only ever removes its own footprint — it never performs the aggressive host scrub reserved for dedicated DO stations.

---

## Repository Layout

```
.
├── app/
│   ├── server.js            # Local orchestration server
│   ├── index.html           # Dashboard frontend
│   └── package.json         # Server dependencies (ws only)
├── .devcontainer/
│   ├── devcontainer.json    # Container definition, tools, extensions, isolation
│   └── Dockerfile           # System packages (always latest)
├── docker-compose.yml
├── install.sh               # macOS/Linux installer
├── Install.ps1              # Windows installer
├── done.sh                  # macOS/Linux cleanup
├── Done.ps1                 # Windows cleanup
├── .env.example             # Optional feature configuration
├── .gitignore
├── .github/workflows/
│   └── release.yml
├── admin/                   # Optional MDM overlay
│   ├── macos/reset.sh
│   └── windows/Reset.ps1
└── README.md
```

---

## Security

Four layers of credential isolation enforced via devcontainer.json:

IDE settings block GitHub token injection, Git credential forwarding, SSH agent forwarding, and port forwarding. Terminal environment force-clears host tokens in every spawned shell. Remote environment nullifies 8 host variables and suppresses shell history. The container mounts only a named Docker volume. No host filesystem, Docker socket, or SSH agent socket is exposed.

The pre-install snapshot captures the host state (Desktop files, Downloads, credentials, SSH keys, Git config) before setup. On cleanup, the dashboard verifies nothing was left behind.

Interviewer-only surfaces — Settings, telemetry, Recycle, and End Event — require OS-level admin authentication; a candidate session cannot view or change them. Before each interview ShellPort validates the host is clean (no leftover container, session files, or — on DO stations — credential residue) and holds setup until any residue is cleared.

---

## Optional Features

All features are off by default. Enable via `.env` or by passing a config URL

| Feature | .env variable | What it does |
|---|---|---|
| Timer | ENABLE_TIMER=true | Live active/idle countdown in dashboard. On expiry: NOTIFY, LOCK, or WIPE. Idle is defined by INACTIVITY_TIMEOUT_MINUTES. |
| Telemetry | ENABLE_TELEMETRY=true | Exports shell history, AI usage, Git activity. Stats shown in dashboard. |
| Questions | QUESTIONS_URL=... | Loads an interview question during setup from the given URL (Google Sheet or doc), also offered as a downloadable PDF. Skipped when unset. QUESTION_ROW pins a specific row; QUESTION_WEBHOOK posts the chosen question. |

---

## Web Client Mode

The "Browser" button in the dashboard opens code-server inside the container. This is a full VS Code environment running in the browser. No local IDE installation required. Works on any machine with Docker and a browser.

---

## Third-Party Environments

The devcontainer.json works natively with GitHub Codespaces, DevPod, Coder, Daytona, and Gitpod. The dashboard shows launch buttons for these when available. No install or cleanup scripts are needed in these environments.

---

## Admin Overlay (IT/MDM)

For company-owned machines cycled between candidates. The `admin/` directory adds host-level sanitization: browser data wipe, keychain/credential purge, IDE state wipe, shell history clear, post-wipe verification across 14 directories, and container rebuild for the next candidate.

Admin reset finds the installation automatically. Three invocation methods:

```bash
# Local (from inside the repo)
sudo ./admin/macos/reset.sh

# Explicit path
sudo ./admin/macos/reset.sh /Users/jdoe/shellport

# MDM push (Jamf/Intune - auto-discovers ~/shellport)
```

The admin overlay is not included in the universal release package. Download the admin release separately.

---

## Releases

Push a tag. GitHub Actions builds the packages automatically.

```bash
git tag -a v1.0.0 -m "Release"
git push origin v1.0.0
```

| Package | Who | Contains |
|---|---|---|
| shellport-v1.0.0.tar.gz | Everyone (macOS/Linux) | Container + app + install + done |
| shellport-v1.0.0.zip | Everyone (Windows) | Same |
| shellport-v1.0.0-admin.tar.gz | IT only (macOS/Linux) | Above + admin/ reset scripts |
| shellport-v1.0.0-admin.zip | IT only (Windows) | Same |
| install.sh | Standalone | macOS/Linux entry point |
| Install.ps1 | Standalone | Windows entry point |

---

## Manual Fallback

If the web dashboard fails:

```bash
cd ~/shellport
docker compose up -d --build
docker compose exec interview-env bash
```

To clean up manually:

```bash
docker compose down -v --remove-orphans
rm -rf ~/shellport
```

`docker compose down -v` removes only ShellPort's own container and volume. If you also want to reclaim unused Docker space and have no other Docker projects, you can run `docker system prune -af --volumes` — but note that is host-wide. ShellPort's own scripts never run it.

---

## Maintainer

DigitalOcean IT - it@digitalocean.com

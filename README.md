# ShellPort

Ephemeral coding interview workstation. One command to install, a local browser dashboard to run it, one click to remove.

---

## Install

Two entry points, same installer — admins set up company-owned machines, candidates set up their own.

**Admin (company-owned machine):**

```bash
# macOS / Linux
curl -fsSL https://do.co/shellport-admin-mac | bash
```

```powershell
# Windows (PowerShell)
irm https://do.co/shellport-admin-win | iex
```

**Candidate (own machine):**

```bash
# macOS / Linux
curl -fsSL https://do.co/shellport-macos | bash
```

```powershell
# Windows (PowerShell)
irm https://do.co/shellport-windows | iex
```

Prerequisites: Docker (running) and Node.js. Your browser opens to `http://localhost:3000` — everything runs locally, no cloud. The dashboard shows build progress, then "Start in" buttons for each detected editor (VS Code, Cursor, Windsurf, VSCodium…), the web editors **vscode.dev** and **github.dev**, and the container terminal.

---

## The Container

The IDE opens inside an isolated container with the latest Go, Python, Java, Node.js, C/C++, TypeScript, GitHub Copilot, Claude Code, GitHub CLI, doctl, Homebrew, neovim, jq, and yq. All candidate work must be saved in `/workspaces`.

---

## Cleanup

Click "End Interview" in the dashboard, or run the script directly:

- **macOS / Linux:** `~/shellport/done.sh`
- **Windows:** `~\shellport\Done.ps1`

This stops the server, kills IDE processes, tears down ShellPort's own container and volume, and deletes the project directory. It is scoped to ShellPort — never a host-wide Docker prune, and it leaves browsers and credentials untouched.

### Recycle vs. End Event (operator)

Two operator actions, both gated behind OS-level admin auth (macOS/Linux `sudo`/`pkexec`, Windows UAC) so a candidate session can't reach them:

- **Recycle** (DO station): scrub the host and load a fresh question for the next candidate without rebuilding the machine.
- **End Event**: tear down the workstation — power off a DO station, or return the uninstall command on a BYOD machine.

ShellPort detects its machine type. On a candidate's own (BYOD) machine it only ever removes its own footprint — never the aggressive host scrub reserved for dedicated DO stations.

---

## Security

Credential isolation is enforced via `devcontainer.json`: IDE settings block GitHub token injection, Git credential forwarding, SSH agent forwarding, and port forwarding; every spawned shell force-clears host tokens; the remote environment nullifies host variables and suppresses history. The container mounts only a named Docker volume — no host filesystem, Docker socket, or SSH agent socket is exposed.

Interviewer surfaces — Settings, telemetry, Recycle, End Event — are gated behind an admin unlock (the machine's OS-user password; no separate admin password) and never appear on a BYOD machine. Before each interview ShellPort confirms the host is clean and holds setup until any residue is cleared.

---

## Optional Features

Off by default. Enable via `.env` or a config URL.

| Feature | .env variable | What it does |
|---|---|---|
| Timer | `ENABLE_TIMER=true` | Live active/idle countdown. On expiry: NOTIFY, LOCK, or WIPE. Idle defined by `INACTIVITY_TIMEOUT_MINUTES`. |
| Telemetry | `ENABLE_TELEMETRY=true` | Exports shell history, AI usage, and Git activity on cleanup. |
| Questions | `QUESTIONS_URL=…` | Loads the assigned question during setup. Source is a **Google Sheet** of `[title, docId]` rows (`QUESTION_ROW` pins the row) or a **Google Doc with one question per tab** (`QUESTION_TAB`, or paste the link with the tab selected). `QUESTION_WEBHOOK` posts the chosen question. The source is never sent to the candidate view — only the rendered question. |
| Question delivery | `QUESTION_DELIVERY=auto` | `auto` renders inline, falls back to PDF; `inline`; `pdf`; `none`. |
| Editors | `ENABLED_EDITORS=…` | Comma-separated allow-list of local editors (e.g. `VS Code,Cursor`). Empty offers every detected editor. |
| Terminal | `TERMINAL_ACCESS=false` | Hides the "Start in terminal" button. Default `true`. |

These settings, plus appearance (theme/accent/font), are also editable live in the dashboard under Admin → Settings.

---

## Repository Layout

```
.
├── app/
│   ├── server.js            # Local orchestration server
│   ├── index.html           # Dashboard frontend
│   └── package.json         # Server dependencies (ws only)
├── .devcontainer/
│   ├── devcontainer.json    # Container definition, tools, isolation
│   └── Dockerfile           # System packages (always latest)
├── docker-compose.yml
├── install.sh / Install.ps1               # Candidate / universal installers
├── admin-install.sh / admin-install.ps1   # Managed DO station installers
├── done.sh / Done.ps1                     # Cleanup
├── .env.defaults            # Baked defaults copied into .env at install
├── .env.example             # Documented reference for all options
├── .github/workflows/release.yml
├── admin/                   # Optional MDM overlay (host sanitization)
│   ├── macos/reset.sh
│   └── windows/Reset.ps1
└── README.md
```

---

## Third-Party Environments

`devcontainer.json` works natively with GitHub Codespaces, DevPod, Coder, Daytona, and Gitpod — open the repo in any of them; no ShellPort install or cleanup scripts needed.

---

## Admin Overlay (IT/MDM)

For company-owned machines cycled between candidates. The `admin/` overlay adds host-level sanitization (browser/keychain/IDE wipe, history clear, post-wipe verification, container rebuild) and marks the machine as a managed DO station. It ships only in the admin release package.

```bash
sudo ./admin/macos/reset.sh                  # local, from inside the repo
sudo ./admin/macos/reset.sh /path/shellport  # explicit path
# MDM push (Jamf/Intune) auto-discovers ~/shellport
```

---

## Releases

Push a tag; GitHub Actions builds the packages.

```bash
git tag -a v1.0.0 -m "Release" && git push origin v1.0.0
```

| Package | Audience | Contains |
|---|---|---|
| `shellport-VERSION.tar.gz` / `.zip` | Everyone | Container + app + install + cleanup |
| `shellport-VERSION-admin.tar.gz` / `.zip` | IT only | Above + `admin/` overlay |
| `install.sh` / `Install.ps1` | Standalone | Candidate entry points |
| `admin-install.sh` / `admin-install.ps1` | Standalone | Managed DO station entry points |

---

## Manual Fallback

If the dashboard fails:

```bash
cd ~/shellport
docker compose up -d --build
docker compose exec interview-env bash
```

Clean up manually:

```bash
docker compose down -v --remove-orphans
rm -rf ~/shellport
```

`docker compose down -v` removes only ShellPort's own container and volume.

---

## Maintainer

DigitalOcean IT — it@digitalocean.com

# ShellPort

Ephemeral coding interview workstation.

## Quick Start

```bash
curl -fsSL https://do.co/shellport-setup-macos | bash
```

Windows:

```powershell
irm https://do.co/shellport-setup-win | iex
```

Requires Docker (running) and Node.js.

## What It Does

ShellPort installs a containerized coding environment, opens a dashboard at `localhost:3000`, and tears everything down when the interview ends. Nothing is left on the machine.

The dashboard shows setup progress, displays the interview question (if configured), and presents IDE launch buttons when the environment is ready. Cleanup shows each step and verifies zero residue.

## Container

All tools are pre-installed and current:

- **Languages:** Go, Python, Java 21, Node.js LTS, C/C++, TypeScript
- **AI:** GitHub Copilot, Copilot Chat, Claude Code
- **CLI:** Git, GitHub CLI, doctl, Homebrew, jq, yq, s3cmd, neovim

Passwordless sudo. Work is saved in `/workspaces`. Everything outside is destroyed on cleanup.

## Configuration

Non-secret defaults ship in `.env.defaults`. Secrets are passed as environment variables at install time:

```bash
SHELLPORT_WEBHOOK="https://hooks.slack.com/..." \
SHELLPORT_QUESTIONS="https://docs.google.com/spreadsheets/d/.../edit" \
curl -fsSL https://do.co/shellport-setup-macos | bash
```

| Variable | Purpose |
|---|---|
| `SHELLPORT_WEBHOOK` | Slack notification when question is assigned (includes machine serial) |
| `SHELLPORT_QUESTIONS` | Google Sheet URL (col A = title, col B = Google Doc ID) |
| `SHELLPORT_QUESTION_ROW` | Pre-assign a specific row. Omit for random. |
| `SHELLPORT_DO_TOKEN` | DigitalOcean API token (archive feature) |
| `SHELLPORT_SPACES_BUCKET` | Spaces bucket (archive feature) |
| `SHELLPORT_PROJECT` | Project name prefix |

Non-secret `.env.defaults`:

| Variable | Default | Options |
|---|---|---|
| `ENABLE_TIMER` | `false` | Live countdown. On expiry: NOTIFY, LOCK, or WIPE. |
| `ENABLE_TELEMETRY` | `false` | Export shell history, AI usage, Git activity. |
| `ENABLE_ARCHIVE` | `false` | Zip `/workspaces` to Spaces before cleanup. |

## Interview Questions

Three options:

**Option 1: Google Sheet + Google Docs (random)**

Create a Google Sheet (row 1 = header, col A = title, col B = Doc ID). Create a Google Doc per question with full formatting. Share both as "Anyone with the link can view." Set `SHELLPORT_QUESTIONS` to the sheet URL. The server picks a random row, fetches the Doc as HTML, and renders it inside the dashboard.

**Option 2: Google Sheet + Google Docs (pre-assigned)**

Same setup as Option 1. Set `SHELLPORT_QUESTION_ROW=3` to always load row 3. The admin knows the question ahead of time.

**Option 3: Manual**

Don't set `SHELLPORT_QUESTIONS`. The question section is hidden from the dashboard entirely. Provide the question via email, placed on the computer, or verbally before the interview. The candidate uses the dashboard only for environment setup and IDE launch.

## Admin Mode

Present when the `admin/` directory exists. Adds to the dashboard:

- Feature toggles (timer, telemetry, archive)
- Timer configuration (action, limit, idle threshold)
- Question controls (reroll, hide/show)
- Question assignment display
- Telemetry stats after cleanup

**Reset for Next Candidate** runs a 7-phase host teardown directly from the dashboard:

1. Kill IDEs
2. Docker wipe
3. Credential scrub (gh, doctl, SSH, Git, Claude, Copilot)
4. Keychain purge (18 entries)
5. Browser + IDE data wipe (Chrome, Safari, Firefox, Edge, Brave, Arc)
6. Shell history, trash, session state
7. Verify zero residue

Container rebuilds automatically. Dashboard returns to ready.

## Security

Four isolation layers in `devcontainer.json`: IDE credential blocking, terminal token clearing, remote environment variable nullification, named volume (no host mounts). Pre-install snapshot with post-cleanup verification. `.env` is `chmod 600` and gitignored.

## Releases

```bash
git tag -a v1.0.0 -m "Release" && git push origin v1.0.0
```

| Asset | Audience |
|---|---|
| `shellport-v1.0.0.tar.gz` | Everyone (macOS/Linux) |
| `shellport-v1.0.0.zip` | Everyone (Windows) |
| `shellport-v1.0.0-admin.tar.gz` | IT (includes admin/) |

## Files

```
app/server.js              Dashboard server
app/index.html             Dashboard UI
.devcontainer/             Container definition
.env.defaults              Non-secret config (committed)
install.sh / Install.ps1   One-command installers
done.sh / Done.ps1         Cleanup + self-destruct
admin/                     IT reset scripts (Jamf/Intune)
```

## Manual Fallback

```bash
cd ~/shellport
docker compose up -d --build
docker compose exec interview-env bash
```

Cleanup:

```bash
docker compose down -v --remove-orphans
docker system prune -af --volumes
rm -rf ~/shellport
```

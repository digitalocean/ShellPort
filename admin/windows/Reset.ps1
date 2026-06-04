#Requires -RunAsAdministrator
# Reset.ps1 - ShellPort Nuclear Teardown (Windows / Intune)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info  { param([string]$Msg) Write-Host "[reset] $Msg" }
function Write-Warn  { param([string]$Msg) Write-Warning "[reset] WARN: $Msg" }
function Stop-Fatal  { param([string]$Msg) Write-Error "[reset] ERROR: $Msg"; exit 1 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Fatal "This script must be run as Administrator."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Discover project root:
#   1. CLI argument: .\admin\windows\Reset.ps1 C:\Users\jdoe\shellport
#   2. Relative to script location (local run from inside repo)
#   3. Default install location for interactive user (Intune push)
$CliPath = if ($args.Count -gt 0) { $args[0] } else { "" }

$ProjectRoot = ""

if ($CliPath -and (Test-Path (Join-Path $CliPath "docker-compose.yml"))) {
    $ProjectRoot = (Resolve-Path $CliPath).Path
} else {
    $candidate = Split-Path -Parent (Split-Path -Parent $ScriptDir)
    if (Test-Path (Join-Path $candidate "docker-compose.yml")) {
        $ProjectRoot = $candidate
    }
}

# Discover interactive user (needed for fallback path and all user-space operations)
$cs = Get-CimInstance Win32_ComputerSystem
$UserName = $cs.UserName -replace '^[^\\]+\\', ''
if (-not $UserName) {
    $quser = query user 2>$null | Select-Object -Skip 1 | Select-Object -First 1
    if ($quser -match '^\s*(\S+)') { $UserName = $Matches[1] }
}
if (-not $UserName) { Stop-Fatal "Cannot determine interactive user." }

$UserHome = "C:\Users\$UserName"

# Fallback: default install location (Intune push — script not inside the project)
if (-not $ProjectRoot) {
    $defaultInstall = Join-Path $UserHome "shellport"
    if (Test-Path (Join-Path $defaultInstall "docker-compose.yml")) {
        $ProjectRoot = $defaultInstall
    } else {
        Stop-Fatal "Cannot find shellport. Pass the path: .\Reset.ps1 C:\path\to\shellport"
    }
}

Write-Info "User: $UserName"
Write-Info "Project: $ProjectRoot"

$MarkerFile = Join-Path $ProjectRoot ".last_station_reset"
$SnapshotFile = Join-Path $ProjectRoot ".session_snapshot"
$TimerDir = Join-Path $ProjectRoot ".timer"
$EnvFile = Join-Path $ProjectRoot ".env"

# Feature flag defaults (overridden by .env if present)
$ENABLE_TIMER = "false"
$TIMEOUT_ACTION = "NOTIFY"
$ENABLE_TELEMETRY = "false"
$ENABLE_QUESTIONS = "false"
$ENABLE_MDM_HANDOFF = "false"
$ENABLE_PROGRESS_UI = "false"
$PROJECT_NAME = ""

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        $parts = $line -split "=", 2
        if ($parts.Count -eq 2) {
            $k = $parts[0].Trim()
            $v = $parts[1].Trim().Trim('"').Trim("'")
            Set-Variable -Name $k -Value $v -Scope Script
        }
    }
}

$logFile = Join-Path "$UserHome\Desktop" "reset_progress_$(Get-Date -Format 'HHmmss').log"
Start-Transcript -Path $logFile -Append

Set-Location $ProjectRoot

# Progress UI helper
function Notify-Phase {
    param([string]$Msg)
    if ($ENABLE_PROGRESS_UI -eq "true") {
        [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
        [System.Windows.Forms.MessageBox]::Show($Msg, 'Station Reset', 'OK', 'Information') | Out-Null
    }
}

# Phase 1: Kill
Write-Info "Phase 1: Kill"
Notify-Phase "Stopping all applications..."

$processes = @(
    "chrome", "msedge", "firefox", "brave", "Arc",
    "Code", "Cursor", "Cursor Helper",
    "Windsurf", "Windsurf Helper",
    "Claude", "claude"
)
foreach ($proc in $processes) {
    Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

$daemonJobFile = Join-Path $TimerDir "daemon_jobid"
if (Test-Path $daemonJobFile) {
    $jobId = [int](Get-Content $daemonJobFile)
    Stop-Job -Id $jobId -ErrorAction SilentlyContinue
    Remove-Job -Id $jobId -Force -ErrorAction SilentlyContinue
    Write-Info "Timer daemon stopped (Job ID: $jobId)."
}

Start-Sleep -Seconds 2

# Phase 2: Audit
Write-Info "Phase 2: Audit"
Notify-Phase "Auditing host file modifications..."

$deltaLog = Join-Path "$UserHome\Desktop" "reset_audit_$(Get-Date -Format 'yyyyMMdd_HHmmss').txt"
$auditContent = @("Reset Audit - $(Get-Date)", "User: $UserName", "")

if (Test-Path $SnapshotFile) {
    $snapLines = Get-Content $SnapshotFile
    $candidateLine = $snapLines | Where-Object { $_ -match '^CANDIDATE=' } | Select-Object -First 1
    $tsLine = $snapLines | Where-Object { $_ -match '^SNAPSHOT_TS=' } | Select-Object -First 1
    if ($candidateLine) { $auditContent += "Candidate: $($candidateLine -replace '^CANDIDATE=','')" }
    if ($tsLine) { $auditContent += "Session started: $($tsLine -replace '^SNAPSHOT_TS=','')" }
    $auditContent += ""
}

if (Test-Path (Join-Path $TimerDir "session_start")) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $tStart = [long](Get-Content (Join-Path $TimerDir "session_start"))
    $tElapsed = $now - $tStart
    $tIdleAcc = [long](Get-Content (Join-Path $TimerDir "idle_accumulated") -ErrorAction SilentlyContinue)
    $tIsIdle = (Get-Content (Join-Path $TimerDir "is_idle") -ErrorAction SilentlyContinue) -eq "true"
    if ($tIsIdle) {
        $tIdleStart = [long](Get-Content (Join-Path $TimerDir "idle_start") -ErrorAction SilentlyContinue)
        $tIdleAcc += ($now - $tIdleStart)
    }
    $tActive = $tElapsed - $tIdleAcc
    $fmtDur = { param($s) "{0:D2}:{1:D2}:{2:D2}" -f [math]::Floor($s/3600), [math]::Floor(($s%3600)/60), ($s%60) }
    $auditContent += "-- Timer session data --"
    $auditContent += "Active time: $(& $fmtDur $tActive)"
    $auditContent += "Idle time  : $(& $fmtDur $tIdleAcc)"
    $tAction = Get-Content (Join-Path $TimerDir "timeout_action") -ErrorAction SilentlyContinue
    $auditContent += "Action     : $tAction"
    if (Test-Path (Join-Path $TimerDir "enforced")) {
        $auditContent += "Enforced   : $(Get-Content (Join-Path $TimerDir 'enforced'))"
    }
    if (Test-Path (Join-Path $TimerDir "notified")) {
        $auditContent += "Notified   : $(Get-Content (Join-Path $TimerDir 'notified'))"
    }
    $auditContent += ""
}

if (Test-Path $MarkerFile) {
    $markerTime = (Get-Item $MarkerFile).LastWriteTime
    $auditContent += "Files modified since last reset ($markerTime):"
    $auditContent += ""

    $auditContent += "-- Home directory --"
    Get-ChildItem $UserHome -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.LastWriteTime -gt $markerTime -and
            $_.FullName -notmatch "\\AppData\\Local\\Temp\\"
        } |
        Sort-Object FullName |
        Select-Object -First 200 |
        ForEach-Object { $auditContent += $_.FullName }

    $auditContent += ""
    $auditContent += "-- Downloads --"
    Get-ChildItem "$UserHome\Downloads" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt $markerTime } |
        Sort-Object FullName |
        ForEach-Object { $auditContent += $_.FullName }

    $auditContent += ""
    $auditContent += "-- Desktop --"
    Get-ChildItem "$UserHome\Desktop" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt $markerTime } |
        Sort-Object FullName |
        ForEach-Object { $auditContent += $_.FullName }

    $auditContent += ""
    $auditContent += "-- Browser profiles modified --"
    $browserDirs = @(
        "$env:LOCALAPPDATA\Google\Chrome\User Data",
        "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
        "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data",
        "$env:APPDATA\Mozilla\Firefox\Profiles",
        "$env:LOCALAPPDATA\Arc\User Data"
    )
    foreach ($bd in $browserDirs) {
        if (Test-Path $bd) {
            Get-ChildItem $bd -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -gt $markerTime } |
                Select-Object -First 20 |
                ForEach-Object { $auditContent += $_.FullName }
        }
    }

    $auditContent += ""
    $auditContent += "-- IDE state modified --"
    $ideDirs = @("$env:APPDATA\Code", "$env:APPDATA\Cursor", "$env:APPDATA\Windsurf")
    foreach ($id in $ideDirs) {
        if (Test-Path $id) {
            Get-ChildItem $id -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -gt $markerTime } |
                Select-Object -First 20 |
                ForEach-Object { $auditContent += $_.FullName }
        }
    }

    if (Test-Path $SnapshotFile) {
        $auditContent += ""
        $auditContent += "-- Shell history delta --"
        $snapLines = Get-Content $SnapshotFile
        foreach ($line in $snapLines) {
            if ($line -match '^HIST:(.+):(\d+)$') {
                $histPath = $Matches[1]
                $preSize = [long]$Matches[2]
                if (Test-Path $histPath) {
                    $postSize = (Get-Item $histPath).Length
                    $delta = $postSize - $preSize
                    if ($delta -gt 0) {
                        $auditContent += "${histPath}: +${delta} bytes"
                    }
                }
            }
        }
    }
} else {
    $auditContent += "No marker file. First reset on this machine."
}
$auditContent | Set-Content $deltaLog -Encoding UTF8

# Telemetry export (feature) - must run before docker wipe
if ($ENABLE_TELEMETRY -eq "true") {
    Write-Info "Collecting telemetry..."
    Notify-Phase "Collecting AI usage telemetry..."
    $telemetryLog = Join-Path "$UserHome\Desktop" "telemetry_$(Get-Date -Format 'yyyyMMdd_HHmmss').txt"
    $telemetry = @(
        "Telemetry Report - $(Get-Date)"
    )

    if (Test-Path $SnapshotFile) {
        $candLine = Get-Content $SnapshotFile | Where-Object { $_ -match '^CANDIDATE=' } | Select-Object -First 1
        if ($candLine) { $telemetry += "Candidate: $($candLine -replace '^CANDIDATE=','')" }
    }
    $telemetry += ""

    $telemetry += "-- Container shell history --"
    $telemetry += (docker compose exec -T interview-env bash -c "cat /home/vscode/.bash_history 2>/dev/null || echo '(empty)'" 2>$null)
    $telemetry += ""

    $telemetry += "-- Claude Code usage --"
    $telemetry += (docker compose exec -T interview-env bash -c "cat /home/vscode/.claude/history.json 2>/dev/null || echo '(none)'" 2>$null)
    $telemetry += (docker compose exec -T interview-env bash -c "ls -la /home/vscode/.claude/ 2>/dev/null || echo '(no .claude directory)'" 2>$null)
    $telemetry += ""

    $telemetry += "-- GitHub Copilot logs --"
    $telemetry += (docker compose exec -T interview-env bash -c "find /home/vscode/.config -path '*/github-copilot/versions.json' -exec cat {} \; 2>/dev/null || echo '(none)'" 2>$null)
    $telemetry += ""

    $telemetry += "-- Git activity --"
    $telemetry += (docker compose exec -T interview-env bash -c "cd /workspaces && git log --oneline --all 2>/dev/null || echo '(no git history)'" 2>$null)
    $telemetry += ""

    $telemetry += "-- Files created/modified in /workspaces --"
    $telemetry += (docker compose exec -T interview-env bash -c "find /workspaces -type f -newer /workspaces 2>/dev/null | sort" 2>$null)
    $telemetry += ""

    $telemetry += "-- Installed packages (candidate additions) --"
    $telemetry += (docker compose exec -T interview-env bash -c "pip list --user 2>/dev/null || echo '(none)'" 2>$null)
    $telemetry += (docker compose exec -T interview-env bash -c "ls /home/vscode/.npm/_npx 2>/dev/null || echo '(none)'" 2>$null)

    $telemetry | Set-Content $telemetryLog -Encoding UTF8
    Write-Info "Telemetry saved: $telemetryLog"
}

# Phase 3: Docker wipe
Write-Info "Phase 3: Docker wipe"
Notify-Phase "Wiping Docker state..."

docker compose -f (Join-Path $ProjectRoot "docker-compose.yml") down -v --remove-orphans 2>$null

$containers = docker ps -aq 2>$null
if ($containers) {
    docker stop $containers 2>$null
    docker rm -f $containers 2>$null
}

$volumes = docker volume ls -q 2>$null
if ($volumes) { foreach ($v in $volumes) { docker volume rm $v 2>$null } }

docker system prune -af --volumes 2>$null

# Phase 4: CLI/agent scrub
Write-Info "Phase 4: CLI/agent scrub"
Notify-Phase "Scrubbing credentials and CLI state..."

gh auth logout --hostname github.com 2>$null
doctl auth remove --context default 2>$null

$dirsToRemove = @(
    "$UserHome\.config\gh",
    "$UserHome\.config\doctl",
    "$UserHome\.ssh",
    "$UserHome\.gitconfig",
    "$UserHome\.git-credentials",
    "$UserHome\.netrc",
    "$UserHome\.claude",
    "$UserHome\.config\claude",
    "$UserHome\.config\Claude",
    "$UserHome\.anthropic",
    "$UserHome\.config\anthropic",
    "$env:APPDATA\claude",
    "$env:APPDATA\Claude",
    "$env:LOCALAPPDATA\claude",
    "$env:LOCALAPPDATA\Claude",
    "$UserHome\.aider",
    "$UserHome\.config\aider",
    "$UserHome\.codeium",
    "$UserHome\.config\codeium",
    "$UserHome\.continue",
    "$UserHome\.config\continue",
    "$UserHome\.copilot",
    "$UserHome\.config\copilot"
)
foreach ($dir in $dirsToRemove) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

if (Test-Path $EnvFile) {
    (Get-Content $EnvFile) -replace '^GH_TOKEN=.*', 'GH_TOKEN=""' | Set-Content $EnvFile
}
$env:GH_TOKEN = ""

# Candidate work lives in the Docker volume (destroyed via `docker compose down -v`),
# never in this repo — so no `git checkout .` / `git clean -fd` here. Those would
# silently discard the operator's own uncommitted changes in the install directory.

# Phase 5: Credential purge
Write-Info "Phase 5: Credential purge"
Notify-Phase "Purging credential store..."

$patterns = @("github", "LegacyGeneric", "MicrosoftAccount", "docker", "claude", "anthropic", "gh:", "doctl", "windsurf")
$cmdkeyList = cmdkey /list 2>$null
if ($cmdkeyList) {
    foreach ($line in $cmdkeyList) {
        if ($line -match "Target:\s*(.+)") {
            $target = $Matches[1].Trim()
            foreach ($pattern in $patterns) {
                if ($target.IndexOf($pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    cmdkey /delete:$target 2>$null
                    break
                }
            }
        }
    }
}

# Phase 6: Deep clean IDEs and browsers
Write-Info "Phase 6: Deep clean IDEs and browsers"
Notify-Phase "Deep cleaning IDEs and browsers..."

$targetsToRemove = @(
    "$env:APPDATA\Code",
    "$env:APPDATA\Cursor",
    "$env:APPDATA\Windsurf",
    "$env:LOCALAPPDATA\Microsoft\VSCode",
    "$env:LOCALAPPDATA\Programs\cursor\resources",
    "$env:LOCALAPPDATA\Programs\windsurf\resources",
    "$env:APPDATA\Claude",
    "$env:LOCALAPPDATA\Claude",
    "$env:LOCALAPPDATA\Google\Chrome\User Data",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data",
    "$env:APPDATA\Mozilla\Firefox\Profiles",
    "$env:LOCALAPPDATA\Mozilla\Firefox\Profiles",
    "$env:LOCALAPPDATA\Arc\User Data"
)
foreach ($target in $targetsToRemove) {
    if (Test-Path $target) { Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue }
}

# Phase 7: Rebuild
Write-Info "Phase 7: Rebuild"
Notify-Phase "Clearing history and recycle bin..."

$shell = New-Object -ComObject Shell.Application
$recycleBin = $shell.Namespace(0xA)
if ($recycleBin.Items().Count -gt 0) {
    Clear-RecycleBin -Force -ErrorAction SilentlyContinue
}

$historyFiles = @(
    "$UserHome\.bash_history",
    "$UserHome\.node_repl_history",
    "$UserHome\.python_history",
    "$UserHome\.lesshst",
    "$UserHome\.viminfo",
    "$env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt"
)
foreach ($hist in $historyFiles) {
    if (Test-Path $hist) { Set-Content $hist "" -Force }
}

Remove-Item $SnapshotFile -Force -ErrorAction SilentlyContinue
if (Test-Path $TimerDir) { Remove-Item $TimerDir -Recurse -Force -ErrorAction SilentlyContinue }

# Phase 8: Verify
Write-Info "Phase 8: Verify"
Notify-Phase "Verifying zero residue..."

$verifyFailures = 0

$checkDirs = @(
    "$UserHome\.config\gh",
    "$UserHome\.ssh",
    "$UserHome\.gitconfig",
    "$UserHome\.git-credentials",
    "$UserHome\.claude",
    "$UserHome\.anthropic",
    "$env:LOCALAPPDATA\Google\Chrome\User Data",
    "$env:LOCALAPPDATA\Microsoft\Edge\User Data",
    "$env:APPDATA\Mozilla\Firefox\Profiles",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data",
    "$env:LOCALAPPDATA\Arc\User Data",
    "$env:APPDATA\Code",
    "$env:APPDATA\Cursor",
    "$env:APPDATA\Windsurf"
)
foreach ($check in $checkDirs) {
    if (Test-Path $check) {
        Write-Warn "VERIFY FAIL: $check still exists"
        $verifyFailures++
    }
}

$dockerContainers = docker ps -aq 2>$null
if ($dockerContainers) {
    Write-Warn "VERIFY FAIL: Docker containers still running"
    $verifyFailures++
}

$dockerVolumes = docker volume ls -q 2>$null
if ($dockerVolumes) {
    Write-Warn "VERIFY FAIL: Docker volumes still exist"
    $verifyFailures++
}

if ($verifyFailures -eq 0) {
    Write-Info "Verification passed. Zero residue detected."
} else {
    Write-Warn "Verification found $verifyFailures issue(s). Review log."
}

# Phase 9: Container rebuild
Write-Info "Phase 9: Container rebuild"
Notify-Phase "Rebuilding container..."

if (-not (Get-Command devcontainer -ErrorAction SilentlyContinue)) {
    npm install -g @devcontainers/cli
}

devcontainer up --workspace-folder $ProjectRoot --remove-existing-container

$resetTs = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Set-Content $MarkerFile $resetTs

Stop-Transcript

# Print timer session summary if present in audit log
if (Test-Path $deltaLog) {
    $timerLines = Get-Content $deltaLog | Where-Object { $_ -match "^(Active time|Idle time|Action|Enforced|Notified)" }
    if ($timerLines) {
        Write-Host ""
        Write-Host "-- Timer session data --"
        $timerLines | ForEach-Object { Write-Host $_ }
    }
}

Write-Host ""
Write-Info "Done. $resetTs | User: $UserName"
Write-Host ""

# Clean up feature artifacts
Remove-Item (Join-Path $ProjectRoot ".current_question") -Force -ErrorAction SilentlyContinue

# Handoff
if ($ENABLE_MDM_HANDOFF -eq "true") {
    Write-Info "MDM handoff enabled. Launching next session automatically..."
    & (Join-Path $ProjectRoot "Install.ps1")
    exit 0
}

$ans = Read-Host "[reset] Start next session now? (Y/n)"
if ($ans -notmatch "^[nN]") {
    & (Join-Path $ProjectRoot "Install.ps1")
}

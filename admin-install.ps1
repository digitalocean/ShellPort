# admin-install.ps1 - ShellPort Admin Installer (Windows)
# For company-owned DO interview stations. Downloads the admin release package,
# which includes the admin/ overlay; that overlay is what marks the machine as a
# managed DO station (ADMIN_MODE), enabling Recycle / End Event and the host scrub.
# Shortlink (go-link points here):
#   Admin (company machine):   irm https://do.co/shellport-admin-win | iex
# Candidates on their own machine should use Install.ps1 (the universal package),
# which never installs the admin overlay.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repo = "digitalocean/shellport"
$SelfUrl = "https://do.co/shellport-admin-win"   # canonical source of this installer
$InstallDir = Join-Path $env:USERPROFILE "shellport"

# MDM/SYSTEM re-exec (Windows): Intune runs as SYSTEM, but ShellPort is per-user.
# When SYSTEM with a user logged in, re-launch in that user's session via a one-shot
# scheduled task. (Intune "Run using logged-on credentials = Yes" skips this block.)
if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
    $loggedIn = (Get-CimInstance Win32_ComputerSystem).UserName   # DOMAIN\user, or empty
    if (-not $loggedIn) {
        Write-Host "[shellport] No interactive user is logged in — will run at the next user login."
        exit 0
    }
    $vars = "SHELLPORT_WEBHOOK","SHELLPORT_SLACK_TOKEN","SHELLPORT_SLACK_CHANNEL",
            "SHELLPORT_QUESTIONS","SHELLPORT_QUESTION_ROW","SHELLPORT_QUESTION_TAB",
            "SHELLPORT_PROJECT","SHELLPORT_LABEL","INTERVIEW_VERSION"
    $prelude = ""
    foreach ($v in $vars) {
        $val = [Environment]::GetEnvironmentVariable($v)
        if ($val) { $prelude += "`$env:$v='" + ($val -replace "'","''") + "'; " }
    }
    $inner   = "$prelude irm $SelfUrl | iex"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand $encoded"
    $principal = New-ScheduledTaskPrincipal -UserId $loggedIn -LogonType Interactive -RunLevel Limited
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName "ShellPortInstall" -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName "ShellPortInstall"
    Write-Host "[shellport] Launched in $loggedIn's session via scheduled task."
    # Wait until the task has started and finished, then remove its definition.
    for ($i = 0; $i -lt 90; $i++) {
        Start-Sleep -Seconds 2
        $state = (Get-ScheduledTask -TaskName "ShellPortInstall" -ErrorAction SilentlyContinue).State
        if ($i -gt 1 -and $state -ne "Running") { break }
    }
    Unregister-ScheduledTask -TaskName "ShellPortInstall" -Confirm:$false -ErrorAction SilentlyContinue
    exit 0
}

function Write-Info  { param([string]$Msg) Write-Host "[shellport] $Msg" }
function Write-Warn  { param([string]$Msg) Write-Warning "[shellport] WARN: $Msg" }
function Stop-Fatal  { param([string]$Msg) Write-Error "[shellport] ERROR: $Msg"; exit 1 }

Write-Host ""
Write-Host "  ShellPort (Admin)"
Write-Host "  Managed DO interview station"
Write-Host ""

# Prerequisites
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Fatal "Docker not found. Install Docker Desktop first." }
$dockerCheck = docker info 2>&1
if ($LASTEXITCODE -ne 0) { Stop-Fatal "Docker is not running. Start Docker Desktop and try again." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-Fatal "Node.js not found. Install from https://nodejs.org first." }

# Clean previous install
if (Test-Path $InstallDir) {
    Write-Info "Removing previous installation..."
    Remove-Item $InstallDir -Recurse -Force
}

# Resolve version
if ($env:INTERVIEW_VERSION) {
    $Version = $env:INTERVIEW_VERSION
} else {
    $releaseInfo = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -ErrorAction SilentlyContinue
    $Version = $releaseInfo.tag_name
    if (-not $Version) { Stop-Fatal "Could not detect latest release." }
}
Write-Info "Version: $Version (admin)"

# Download and extract the admin package (includes the admin/ overlay)
$zipUrl = "https://github.com/$Repo/releases/download/$Version/shellport-$Version-admin.zip"
$zipPath = Join-Path $env:TEMP "shellport-$Version-admin.zip"

Write-Info "Downloading..."
Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
Remove-Item $zipPath -Force

# Build .env: start with baked defaults, layer secrets from environment
Write-Info "Configuring..."
$envFile = Join-Path $InstallDir ".env"
$defaultsFile = Join-Path $InstallDir ".env.defaults"

if (Test-Path $defaultsFile) {
    Copy-Item $defaultsFile $envFile
} else {
    New-Item $envFile -ItemType File -Force | Out-Null
}

$secrets = @()
if ($env:SHELLPORT_WEBHOOK)       { $secrets += "QUESTION_WEBHOOK=`"$env:SHELLPORT_WEBHOOK`"" }
if ($env:SHELLPORT_SLACK_TOKEN)   { $secrets += "SLACK_BOT_TOKEN=`"$env:SHELLPORT_SLACK_TOKEN`"" }
if ($env:SHELLPORT_SLACK_CHANNEL) { $secrets += "SLACK_CHANNEL=`"$env:SHELLPORT_SLACK_CHANNEL`"" }
if ($env:SHELLPORT_QUESTIONS)     { $secrets += "QUESTIONS_URL=`"$env:SHELLPORT_QUESTIONS`"" }
if ($env:SHELLPORT_QUESTION_ROW)  { $secrets += "QUESTION_ROW=`"$env:SHELLPORT_QUESTION_ROW`"" }
if ($env:SHELLPORT_QUESTION_TAB)  { $secrets += "QUESTION_TAB=`"$env:SHELLPORT_QUESTION_TAB`"" }
if ($env:SHELLPORT_PROJECT)       { $secrets += "PROJECT_NAME=`"$env:SHELLPORT_PROJECT`"" }
if ($env:SHELLPORT_LABEL)         { $secrets += "MACHINE_LABEL=`"$env:SHELLPORT_LABEL`"" }

if ($secrets.Count -gt 0) {
    Add-Content $envFile ($secrets -join "`n")
}

Set-Location (Join-Path $InstallDir "app")

# Install server dependencies
Write-Info "Installing dependencies..."
npm install --production --silent 2>$null

# Start the web app
Write-Info "Starting ShellPort..."
$job = Start-Process node -ArgumentList "server.js" -PassThru -WindowStyle Hidden -WorkingDirectory (Join-Path $InstallDir "app")
Set-Content (Join-Path $InstallDir ".server_pid") $job.Id

Start-Sleep -Seconds 2
Start-Process "http://localhost:3000"

Write-Host ""
Write-Info "ShellPort is running at http://localhost:3000"
Write-Host ""
Write-Info "This is a managed station: Recycle and End Event are available"
Write-Info "in the dashboard after unlocking with the machine's OS-user password."
Write-Host ""

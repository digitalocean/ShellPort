# local-test.ps1 - ShellPort local testing setup (Windows)
# Run this from the shellport\ directory after unzipping.
# This replaces Install.ps1 for local testing (Install.ps1 downloads from GitHub
# Releases, which won't work until you push the repo and create a release).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Info { param([string]$Msg) Write-Host "[shellport] $Msg" }
function Write-Warn { param([string]$Msg) Write-Warning "[shellport] WARN: $Msg" }
function Stop-Fatal { param([string]$Msg) Write-Error "[shellport] ERROR: $Msg"; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  ShellPort - Local Test"
Write-Host ""

# Step 1: Prerequisites
Write-Info "Checking prerequisites..."
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Fatal "Docker not found. Install Docker Desktop first." }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Stop-Fatal "Docker is not running. Start Docker Desktop and wait for it to start." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-Fatal "Node.js not found. Install from https://nodejs.org first." }
Write-Info "Docker: running"
Write-Info "Node.js: $(node --version)"

# Step 2: Check for an IDE
$ideFound = $false
foreach ($exe in @("code", "cursor", "windsurf")) {
    if (Get-Command $exe -ErrorAction SilentlyContinue) { Write-Info "IDE: $exe"; $ideFound = $true; break }
}
if (-not $ideFound) { Write-Warn "No IDE found on PATH. The vscode.dev / github.dev web editors will still work." }

# Step 3: Install server dependencies
Write-Info "Installing server dependencies..."
Push-Location (Join-Path $ScriptDir "app")
npm install --production --silent 2>$null
Pop-Location

# Step 4: Kill any previous ShellPort server
$pidFile = Join-Path $ScriptDir ".server_pid"
if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Info "Stopped previous server (PID: $oldPid)"
}

# Step 5: Build .env from defaults + SHELLPORT_ env vars
$envFile = Join-Path $ScriptDir ".env"
$defaultsFile = Join-Path $ScriptDir ".env.defaults"
if (Test-Path $defaultsFile) {
    Copy-Item $defaultsFile $envFile -Force
} elseif (-not (Test-Path $envFile)) {
    New-Item $envFile -ItemType File -Force | Out-Null
}

$secrets = @()
if ($env:SHELLPORT_WEBHOOK)      { $secrets += "QUESTION_WEBHOOK=`"$env:SHELLPORT_WEBHOOK`"" }
if ($env:SHELLPORT_QUESTIONS)    { $secrets += "QUESTIONS_URL=`"$env:SHELLPORT_QUESTIONS`"" }
if ($env:SHELLPORT_QUESTION_ROW) { $secrets += "QUESTION_ROW=`"$env:SHELLPORT_QUESTION_ROW`"" }
if ($env:SHELLPORT_QUESTION_TAB) { $secrets += "QUESTION_TAB=`"$env:SHELLPORT_QUESTION_TAB`"" }
if ($env:SHELLPORT_PROJECT)      { $secrets += "PROJECT_NAME=`"$env:SHELLPORT_PROJECT`"" }
if ($secrets.Count -gt 0) { Add-Content $envFile ($secrets -join "`n") }

# Step 6: Start the server
Write-Info "Starting ShellPort server..."
$job = Start-Process node -ArgumentList "server.js" -PassThru -WindowStyle Hidden -WorkingDirectory (Join-Path $ScriptDir "app")
Set-Content $pidFile $job.Id

Start-Sleep -Seconds 2
if ($job.HasExited) { Stop-Fatal "Server failed to start. Check app\server.js for errors." }

# Step 7: Open browser
Start-Process "http://localhost:3000"

Write-Host ""
Write-Info "ShellPort is running at http://localhost:3000"
Write-Info "Server PID: $($job.Id)"
Write-Host ""
Write-Host "  The dashboard is open in your browser."
Write-Host "  First build takes 5-15 minutes. Watch the progress."
Write-Host ""
Write-Host "  When done testing, stop the server with:"
Write-Host "    Stop-Process -Id (Get-Content .server_pid)"
Write-Host ""

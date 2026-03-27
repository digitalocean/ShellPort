# Install.ps1 - ShellPort Installer (Windows)
# Basic:
#   irm https://do.co/shellport-setup-win | iex

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repo = "digitalocean/shellport"
$InstallDir = Join-Path $env:USERPROFILE "shellport"

function Write-Info  { param([string]$Msg) Write-Host "[shellport] $Msg" }
function Write-Warn  { param([string]$Msg) Write-Warning "[shellport] WARN: $Msg" }
function Stop-Fatal  { param([string]$Msg) Write-Error "[shellport] ERROR: $Msg"; exit 1 }

Write-Host ""
Write-Host "  ShellPort"
Write-Host "  Ephemeral coding interview workstation"
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
Write-Info "Version: $Version"

# Download and extract
$zipUrl = "https://github.com/$Repo/releases/download/$Version/shellport-$Version.zip"
$zipPath = Join-Path $env:TEMP "shellport-$Version.zip"

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
if ($env:SHELLPORT_QUESTIONS)     { $secrets += "QUESTIONS_URL=`"$env:SHELLPORT_QUESTIONS`"" }
if ($env:SHELLPORT_QUESTION_ROW)  { $secrets += "QUESTION_ROW=`"$env:SHELLPORT_QUESTION_ROW`"" }
if ($env:SHELLPORT_DO_TOKEN)      { $secrets += "DO_TOKEN=`"$env:SHELLPORT_DO_TOKEN`"" }
if ($env:SHELLPORT_SPACES_BUCKET) { $secrets += "SPACES_BUCKET=`"$env:SHELLPORT_SPACES_BUCKET`"" }
if ($env:SHELLPORT_SPACES_REGION) { $secrets += "SPACES_REGION=`"$env:SHELLPORT_SPACES_REGION`"" }
if ($env:SHELLPORT_PROJECT)       { $secrets += "PROJECT_NAME=`"$env:SHELLPORT_PROJECT`"" }

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
Write-Info "When finished, click 'End Interview' in the browser,"
Write-Info "or run: $InstallDir\Done.ps1"
Write-Host ""

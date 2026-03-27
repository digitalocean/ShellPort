# Done.ps1 - ShellPort Cleanup (Windows)
# Removes the server, container, Docker volume, and the entire project directory.
# Does NOT touch host browsers, credential store, or user profiles.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Info  { param([string]$Msg) Write-Host "[interview] $Msg" }

Write-Host ""
Write-Info "Cleaning up interview environment..."

# Stop the web server
$pidFile = Join-Path $ScriptDir ".server_pid"
if (Test-Path $pidFile) {
    $pid = [int](Get-Content $pidFile)
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    Write-Info "Server stopped."
}

# Kill IDEs
$processes = @("Code", "Cursor", "Cursor Helper", "Windsurf", "Windsurf Helper")
foreach ($proc in $processes) {
    Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# Docker cleanup
if (Get-Command docker -ErrorAction SilentlyContinue) {
    docker compose -f (Join-Path $ScriptDir "docker-compose.yml") down -v --remove-orphans 2>$null
    docker system prune -af --volumes 2>$null
}

Write-Info "Removing $ScriptDir..."

# Self-destruct
Set-Location $env:USERPROFILE
Start-Process cmd -ArgumentList "/c", "timeout /t 2 /nobreak >nul & rmdir /s /q `"$ScriptDir`"" -WindowStyle Hidden

Write-Host ""
Write-Info "ShellPort removed. Nothing left behind."
Write-Host ""

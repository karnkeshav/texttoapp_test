'use strict';

/**
 * Generates a start.ps1 script for full-stack applications.
 * This script is committed to the repo and allows local development.
 */

function generateStartScript(stack) {
  const { frontend, backend } = stack || {};

  // Only generate for full-stack apps
  if (!frontend || !backend || backend === 'none' || frontend === 'html') {
    return null;
  }

  const backendDir = 'backend';
  const frontendDir = 'frontend';
  const backendPort = getBackendPort(backend);
  const frontendPort = 5173; // Vite/React dev server default

  const backendInstall = getBackendInstallScript(backend, backendDir);
  const backendStart = getBackendStartScript(backend, backendDir);

  return `# Auto-generated start script for ${frontend.toUpperCase()} + ${backend.toUpperCase()} stack
# Run this script to start both servers locally

param(
  [switch]\$NoOpen
)

\\$ErrorActionPreference = "Continue"

Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "Starting ${frontend.toUpperCase()} + ${backend.toUpperCase()} Development Environment" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Cyan

function Test-Command([string]\$cmd) {
  return \$null -ne (Get-Command \$cmd -ErrorAction SilentlyContinue)
}

function Test-Port([int]\$port) {
  try {
    \$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, \$port)
    \$listener.Start()
    \$listener.Stop()
    return \$true
  } catch {
    return \$false
  }
}

function Get-FreePort([int]\$preferred) {
  \$p = \$preferred
  while (\$p -lt (\$preferred + 20)) {
    if (Test-Port \$p) { return \$p }
    \$p++
  }
  return \$preferred
}

Write-Host ""
Write-Host "[1/3] Installing backend dependencies..." -ForegroundColor Yellow

${backendInstall}

Write-Host ""
Write-Host "[2/3] Installing frontend dependencies..." -ForegroundColor Yellow

if (-not (Test-Command "node")) {
  Write-Host "ERROR: Node.js is not installed" -ForegroundColor Red
  Write-Host "Download from: https://nodejs.org" -ForegroundColor Gray
  exit 1
}

if (Test-Path "$frontendDir/package.json") {
  Write-Host "      Running 'npm install' in frontend..." -ForegroundColor Gray
  Push-Location $frontendDir
  & npm install
  if (\$LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed in frontend" -ForegroundColor Red
    exit 1
  }
  Pop-Location
}

Write-Host ""
Write-Host "[3/3] Starting servers..." -ForegroundColor Yellow

\$backPort = Get-FreePort ${backendPort}
\$frontPort = Get-FreePort ${frontendPort}

Write-Host "      Launching backend on port \$backPort..." -ForegroundColor Gray
\$env:PORT = "\$backPort"

${backendStart}

Start-Sleep -Seconds 3

Write-Host "      Launching frontend on port \$frontPort..." -ForegroundColor Gray
\$env:PORT = "\$frontPort"
\$env:BROWSER = "none"

Start-Process powershell -ArgumentList "-NoExit -Command 'cd $frontendDir; npm start'" -WindowStyle Normal

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "✅ Development environment started!" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "📱 Frontend:  http://localhost:\$frontPort" -ForegroundColor Cyan
Write-Host "⚙️  Backend:   http://localhost:\$backPort" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Ctrl+C in any window to stop the servers" -ForegroundColor Gray
Write-Host ""

if (-not \$NoOpen) {
  Start-Sleep -Seconds 2
  try {
    Start-Process "http://localhost:\$frontPort"
  } catch {
    Write-Host "Could not auto-open browser. Open manually: http://localhost:\$frontPort" -ForegroundColor Yellow
  }
}

# Keep this window open
while (\$true) {
  Start-Sleep -Seconds 60
}
`;
}

function getBackendPort(backend) {
  switch (backend) {
    case 'go': return 8080;
    case 'python': return 5000;
    case 'nodejs': return 4000;
    default: return 3000;
  }
}

function getBackendInstallScript(backend, backendDir) {
  switch (backend) {
    case 'go':
      return `if (-not (Test-Command "go")) {
  Write-Host "ERROR: Go is not installed" -ForegroundColor Red
  Write-Host "Download from: https://go.dev/dl" -ForegroundColor Gray
  exit 1
}

if (Test-Path "$backendDir/go.mod") {
  Write-Host "      Running 'go mod tidy'..." -ForegroundColor Gray
  Push-Location $backendDir
  & go mod tidy
  if (\\$LASTEXITCODE -ne 0) {
    Write-Host "ERROR: go mod tidy failed" -ForegroundColor Red
    exit 1
  }
  Pop-Location
}`;

    case 'python':
      return `\\$pyCmd = if (Test-Command "python3") { "python3" } elseif (Test-Command "python") { "python" } else { \\$null }
if (-not \\$pyCmd) {
  Write-Host "ERROR: Python is not installed" -ForegroundColor Red
  Write-Host "Download from: https://python.org" -ForegroundColor Gray
  exit 1
}

if (Test-Path "$backendDir/requirements.txt") {
  Write-Host "      Running 'pip install'..." -ForegroundColor Gray
  Push-Location $backendDir
  & \\$pyCmd -m pip install -r requirements.txt -q
  if (\\$LASTEXITCODE -ne 0) {
    Write-Host "ERROR: pip install failed" -ForegroundColor Red
    exit 1
  }
  Pop-Location
}`;

    case 'nodejs':
      return `if (-not (Test-Command "node")) {
  Write-Host "ERROR: Node.js is not installed" -ForegroundColor Red
  Write-Host "Download from: https://nodejs.org" -ForegroundColor Gray
  exit 1
}

if (Test-Path "$backendDir/package.json") {
  Write-Host "      Running 'npm install' in backend..." -ForegroundColor Gray
  Push-Location $backendDir
  & npm install
  if (\\$LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed in backend" -ForegroundColor Red
    exit 1
  }
  Pop-Location
}`;

    default: return '';
  }
}

function getBackendStartScript(backend, backendDir) {
  switch (backend) {
    case 'go':
      return `Start-Process powershell -ArgumentList "-NoExit -Command 'cd $backendDir; go run .'" -WindowStyle Normal`;

    case 'python':
      return `\\$pyCmd = if (Test-Command "python3") { "python3" } else { "python" }
\\$mainFile = if (Test-Path "$backendDir/main.py") { "main.py" } else { "app.py" }
Start-Process powershell -ArgumentList "-NoExit -Command 'cd $backendDir; & \\\"\\$pyCmd\\\" \\$mainFile'" -WindowStyle Normal`;

    case 'nodejs':
      return `Start-Process powershell -ArgumentList "-NoExit -Command 'cd $backendDir; npm start'" -WindowStyle Normal`;

    default: return '';
  }
}

module.exports = { generateStartScript };

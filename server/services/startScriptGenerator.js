'use strict';

/**
 * Generates a start.ps1 script for full-stack applications.
 * Backend files are at ROOT level (main.go, server.js, main.py)
 * Frontend files are at public/ directory
 */

function generateStartScript(stack) {
  const { frontend, backend } = stack || {};

  // Only generate for full-stack apps with both frontend AND backend
  if (!frontend || !backend || backend === 'none' || frontend === 'html') {
    return null;
  }

  const script = generateScriptForStack(backend, frontend);
  return script;
}

function generateScriptForStack(backend, frontend) {
  const backendPort = getBackendPort(backend);
  const backendInstallCmd = getBackendInstall(backend);
  const backendStartCmd = getBackendStart(backend);

  return `# Auto-generated start script for ${frontend}+${backend} full-stack app
# Backend files at ROOT, frontend files at public/

param(
  [switch]${'\$'}NoOpen
)

${'\$'}ErrorActionPreference = "Continue"

Write-Host "════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "Starting ${frontend.toUpperCase()}+${backend.toUpperCase()} Development" -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

function Test-Command {
  param([string]${'\$'}cmd)
  return ${'\$'}null -ne (Get-Command ${'\$'}cmd -ErrorAction SilentlyContinue)
}

function Test-Port {
  param([int]${'\$'}port)
  try {
    ${'\$'}listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, ${'\$'}port)
    ${'\$'}listener.Start()
    ${'\$'}listener.Stop()
    return ${'\$'}true
  } catch {
    return ${'\$'}false
  }
}

function Get-FreePort {
  param([int]${'\$'}preferred)
  ${'\$'}p = ${'\$'}preferred
  while (${'\$'}p -lt (${'\$'}preferred + 50)) {
    if (Test-Port ${'\$'}p) { return ${'\$'}p }
    ${'\$'}p++
  }
  return ${'\$'}preferred
}

# [1/3] Install backend dependencies
Write-Host "[1/3] Installing backend dependencies..." -ForegroundColor Yellow
${backendInstallCmd}

# [2/3] Install frontend dependencies if needed
Write-Host "[2/3] Checking frontend..." -ForegroundColor Yellow
if (Test-Path "public/package.json") {
  if (-not (Test-Command "node")) {
    Write-Host "ERROR: Node.js is required for frontend" -ForegroundColor Red
    Write-Host "Download from: https://nodejs.org" -ForegroundColor Gray
    exit 1
  }
  Write-Host "      Installing frontend dependencies..." -ForegroundColor Gray
  Push-Location public
  & npm install
  if (${'\$'}LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed" -ForegroundColor Red
    exit 1
  }
  Pop-Location
}

# [3/3] Start backend server
Write-Host "[3/3] Starting backend server..." -ForegroundColor Yellow
${'\$'}backendPort = Get-FreePort ${backendPort}
${'\$'}env:PORT = ${'\$'}backendPort

${backendStartCmd}

Start-Sleep -Seconds 3

# Verify backend is running
Write-Host "      Waiting for backend to respond..." -ForegroundColor Gray
${'\$'}maxWait = 30
${'\$'}waited = 0
while (${'\$'}waited -lt ${'\$'}maxWait) {
  try {
    ${'\$'}response = Invoke-WebRequest -Uri "http://localhost:${'\$'}backendPort" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue
    if (${'\$'}response.StatusCode -lt 500) {
      break
    }
  } catch {}
  Start-Sleep -Seconds 1
  ${'\$'}waited++
}

Write-Host ""
Write-Host "════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "✅ Server started successfully!" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "🌐 Frontend URL: http://localhost:${'\$'}backendPort" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Gray
Write-Host ""

if (-not ${'\$'}NoOpen) {
  Start-Sleep -Seconds 1
  try {
    Start-Process "http://localhost:${'\$'}backendPort"
  } catch {
    Write-Host "(Could not auto-open browser — open manually)" -ForegroundColor Yellow
  }
}

# Keep window open
while (${'\$'}true) {
  Start-Sleep -Seconds 60
}
`;
}

function getBackendPort(backend) {
  switch (backend.toLowerCase()) {
    case 'go': return 8080;
    case 'python': return 5000;
    case 'nodejs': return 3000;
    case 'ruby': return 3000;
    case 'php': return 8000;
    case 'rust': return 8000;
    default: return 3000;
  }
}

function getBackendInstall(backend) {
  backend = backend.toLowerCase();

  if (backend === 'go') {
    return `if (-not (Test-Command "go")) {
  Write-Host "ERROR: Go is not installed" -ForegroundColor Red
  Write-Host "Download from: https://go.dev/dl" -ForegroundColor Gray
  exit 1
}
if (Test-Path "go.mod") {
  Write-Host "      Running 'go mod tidy'..." -ForegroundColor Gray
  & go mod tidy
  if (${'\$'}LASTEXITCODE -ne 0) {
    Write-Host "ERROR: go mod tidy failed" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "ERROR: go.mod not found at root" -ForegroundColor Red
  exit 1
}`;
  }

  if (backend === 'python') {
    return `${'\$'}pyCmd = if (Test-Command "python3") { "python3" } elseif (Test-Command "python") { "python" } else { ${'\$'}null }
if (-not ${'\$'}pyCmd) {
  Write-Host "ERROR: Python is not installed" -ForegroundColor Red
  Write-Host "Download from: https://python.org" -ForegroundColor Gray
  exit 1
}
if (Test-Path "requirements.txt") {
  Write-Host "      Running 'pip install'..." -ForegroundColor Gray
  & ${'\$'}pyCmd -m pip install -r requirements.txt -q
  if (${'\$'}LASTEXITCODE -ne 0) {
    Write-Host "ERROR: pip install failed" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "      (No requirements.txt found)" -ForegroundColor Gray
}`;
  }

  if (backend === 'nodejs') {
    return `if (-not (Test-Command "node")) {
  Write-Host "ERROR: Node.js is not installed" -ForegroundColor Red
  Write-Host "Download from: https://nodejs.org" -ForegroundColor Gray
  exit 1
}
if (Test-Path "package.json") {
  Write-Host "      Running 'npm install'..." -ForegroundColor Gray
  & npm install
  if (${'\$'}LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "ERROR: package.json not found at root" -ForegroundColor Red
  exit 1
}`;
  }

  if (backend === 'ruby') {
    return `if (-not (Test-Command "ruby")) {
  Write-Host "ERROR: Ruby is not installed" -ForegroundColor Red
  Write-Host "Download from: https://rubyinstaller.org" -ForegroundColor Gray
  exit 1
}
if (Test-Path "Gemfile") {
  Write-Host "      Running 'bundle install'..." -ForegroundColor Gray
  & bundle install
  if (${'\$'}LASTEXITCODE -ne 0) {
    Write-Host "ERROR: bundle install failed" -ForegroundColor Red
    exit 1
  }
}`;
  }

  if (backend === 'php') {
    return `if (-not (Test-Command "php")) {
  Write-Host "ERROR: PHP is not installed" -ForegroundColor Red
  Write-Host "Download from: https://windows.php.net" -ForegroundColor Gray
  exit 1
}
if (Test-Path "composer.json") {
  Write-Host "      Running 'composer install'..." -ForegroundColor Gray
  & composer install
  if (${'\$'}LASTEXITCODE -ne 0) {
    Write-Host "ERROR: composer install failed" -ForegroundColor Red
    exit 1
  }
}`;
  }

  if (backend === 'rust') {
    return `if (-not (Test-Command "cargo")) {
  Write-Host "ERROR: Rust is not installed" -ForegroundColor Red
  Write-Host "Download from: https://rustup.rs" -ForegroundColor Gray
  exit 1
}
if (Test-Path "Cargo.toml") {
  Write-Host "      Building Rust project..." -ForegroundColor Gray
  & cargo build --release
  if (${'\$'}LASTEXITCODE -ne 0) {
    Write-Host "ERROR: cargo build failed" -ForegroundColor Red
    exit 1
  }
}`;
  }

  return 'Write-Host "      (Dependencies check skipped)" -ForegroundColor Gray';
}

function getBackendStart(backend) {
  backend = backend.toLowerCase();

  if (backend === 'go') {
    return `Start-Process -FilePath "powershell" -ArgumentList '-NoExit', '-Command', 'go run .' -WindowStyle Normal`;
  }

  if (backend === 'python') {
    return `${'\$'}mainFile = if (Test-Path "main.py") { "main.py" } elseif (Test-Path "app.py") { "app.py" } else { "main.py" }
${'\$'}pyCmd = if (Test-Command "python3") { "python3" } else { "python" }
Start-Process -FilePath "powershell" -ArgumentList '-NoExit', '-Command', "${'\$'}pyCmd ${'\$'}mainFile" -WindowStyle Normal`;
  }

  if (backend === 'nodejs') {
    return `${'\$'}startScript = if (Test-Path "package.json") {
  (Get-Content package.json | ConvertFrom-Json).scripts.start ?? "node server.js"
} else {
  "node server.js"
}
Start-Process -FilePath "powershell" -ArgumentList '-NoExit', '-Command', "npm start" -WindowStyle Normal`;
  }

  if (backend === 'ruby') {
    return `Start-Process -FilePath "powershell" -ArgumentList '-NoExit', '-Command', 'ruby app.rb' -WindowStyle Normal`;
  }

  if (backend === 'php') {
    return `Start-Process -FilePath "powershell" -ArgumentList '-NoExit', '-Command', 'php -S localhost:8000' -WindowStyle Normal`;
  }

  if (backend === 'rust') {
    return `Start-Process -FilePath "powershell" -ArgumentList '-NoExit', '-Command', './target/release/app' -WindowStyle Normal`;
  }

  return `Start-Process -FilePath "powershell" -ArgumentList '-NoExit', '-Command', 'echo "No start command defined"' -WindowStyle Normal`;
}

module.exports = { generateStartScript };

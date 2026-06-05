param(
  [string]$RepoUrl,
  [string]$TempDir,
  [string]$Frontend = "html",
  [string]$Backend  = "none"
)

$ErrorActionPreference = "Continue"

function Send-Progress([string]$msg) { Write-Output "PROGRESS:$msg"; [Console]::Out.Flush() }
function Send-Ready([string]$url)    { Write-Output "READY:$url";    [Console]::Out.Flush() }
function Send-Error([string]$msg)    { Write-Output "ERROR:$msg";    [Console]::Out.Flush() }

function Test-Command([string]$cmd) {
  return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Get-FreePort([int]$preferred) {
  $p = $preferred
  while ($p -lt ($preferred + 20)) {
    try {
      $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
      $listener.Start()
      $listener.Stop()
      return $p
    } catch {
      $p++
    }
  }
  return $preferred
}

function Wait-ForServer([string]$url, [int]$maxSeconds = 60) {
  $elapsed = 0
  while ($elapsed -lt $maxSeconds) {
    try {
      $r = Invoke-WebRequest -Uri $url -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
      if ($r -and $r.StatusCode -lt 500) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 500
    $elapsed += 0.5
  }
  return $false
}

# ── Main ──────────────────────────────────────────────────────────────────────

try {
  $frontendPort = 3000
  $backendPort  = switch ($Backend) {
    "go"     { 8080 }
    "python" { 5000 }
    "nodejs" { 4000 }
    default  { 0 }
  }

  # 1. Clone
  Send-Progress "Cloning repository..."
  if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue }
  & git clone --depth 1 $RepoUrl $TempDir 2>$null
  if ($LASTEXITCODE -ne 0) {
    Send-Error "Clone failed — check your GitHub token and repo access"
    exit 1
  }
  Set-Location $TempDir

  $frontDir = if (Test-Path "frontend") { Join-Path $TempDir "frontend" } else { $TempDir }
  $backDir  = if (Test-Path "backend")  { Join-Path $TempDir "backend"  } else { $TempDir }

  Send-Progress "Layout: frontend=$Frontend backend=$Backend"

  # 2. Backend dependencies
  switch ($Backend) {
    "go" {
      if (-not (Test-Command "go")) {
        Send-Error "Go is not installed"
        exit 1
      }
      Send-Progress "Preparing Go backend..."
      Push-Location $backDir
      & go mod tidy >$null 2>&1
      Pop-Location
    }
    "python" {
      $pyCmd = if (Test-Command "python3") { "python3" } elseif (Test-Command "python") { "python" } else { $null }
      if (-not $pyCmd) {
        Send-Error "Python is not installed"
        exit 1
      }
      if (Test-Path "$backDir/requirements.txt") {
        Send-Progress "Installing Python dependencies..."
        & $pyCmd -m pip install -r "$backDir/requirements.txt" -q >$null 2>&1
      }
    }
    "nodejs" {
      if (-not (Test-Command "node")) {
        Send-Error "Node.js is not installed"
        exit 1
      }
      if (Test-Path "$backDir/package.json") {
        Send-Progress "Installing Node.js backend dependencies..."
        Push-Location $backDir
        & npm install --silent >$null 2>&1
        if ($LASTEXITCODE -ne 0) {
          Send-Error "npm install failed in backend"
          exit 1
        }
        Pop-Location
      }
    }
  }

  # 3. Frontend dependencies
  if ($Frontend -ne "html") {
    if (-not (Test-Command "node")) {
      Send-Error "Node.js is not installed"
      exit 1
    }
    if (Test-Path "$frontDir/package.json") {
      Send-Progress "Installing frontend dependencies..."
      Push-Location $frontDir
      & npm install --silent >$null 2>&1
      if ($LASTEXITCODE -ne 0) {
        Send-Error "npm install failed in frontend"
        exit 1
      }
      Pop-Location
    }
  }

  # 4. Find free ports
  $actualFrontend = Get-FreePort $frontendPort
  $actualBackend  = if ($backendPort -gt 0) { Get-FreePort $backendPort } else { 0 }

  Send-Progress "Frontend port: $actualFrontend, Backend port: $actualBackend"

  # 5. Start backend
  if ($Backend -ne "none" -and $actualBackend -gt 0) {
    Send-Progress "Starting $Backend backend..."
    $env:PORT = "$actualBackend"

    switch ($Backend) {
      "go" {
        Start-Process -FilePath "go" -ArgumentList "run", "." `
          -WorkingDirectory $backDir -WindowStyle Hidden -NoNewWindow
      }
      "python" {
        $pyCmd = if (Test-Command "python3") { "python3" } else { "python" }
        $mainFile = if (Test-Path "$backDir/main.py") { "main.py" } else { "app.py" }
        Start-Process -FilePath $pyCmd -ArgumentList $mainFile `
          -WorkingDirectory $backDir -WindowStyle Hidden -NoNewWindow
      }
      "nodejs" {
        Start-Process -FilePath "npm" -ArgumentList "start" `
          -WorkingDirectory $backDir -WindowStyle Hidden -NoNewWindow
      }
    }

    Start-Sleep -Seconds 2
    Send-Progress "Checking backend health..."
    $ok = Wait-ForServer "http://localhost:$actualBackend" 30
    if (-not $ok) {
      Send-Error "Backend failed to respond on port $actualBackend"
      exit 1
    }
  }

  # 6. Start frontend
  if ($Frontend -ne "html") {
    Send-Progress "Starting frontend dev server..."
    $env:PORT = "$actualFrontend"
    $env:BROWSER = "none"

    Start-Process -FilePath "npm" -ArgumentList "start" `
      -WorkingDirectory $frontDir -WindowStyle Hidden -NoNewWindow

    Start-Sleep -Seconds 2
    Send-Progress "Checking frontend health..."
    $ok = Wait-ForServer "http://localhost:$actualFrontend" 60
    if (-not $ok) {
      Send-Error "Frontend failed to respond on port $actualFrontend"
      exit 1
    }
  }

  Send-Ready "http://localhost:$actualFrontend"

} catch {
  Send-Error "Setup failed: $($_.Exception.Message)"
  exit 1
}

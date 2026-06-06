'use strict';

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

// Use home directory instead of temp directory to avoid PowerShell execution policy blocks
const APPS_ROOT = path.join(os.homedir(), 'ready4launch-apps');

const runningApps = new Map();

function needsLocalRunner(files) {
  return files.some(f =>
    f.path === 'package.json' || f.path.endsWith('/package.json') ||
    f.path === 'go.mod' || f.path.endsWith('.go') ||
    f.path === 'requirements.txt' || f.path.endsWith('.py') ||
    f.path === 'Gemfile' || f.path === 'Cargo.toml'
  );
}

function stackNeedsLocalRunner(stack) {
  const { backend } = stack || {};
  if (!backend || backend === 'none' || backend === 'html') {
    return false;
  }
  return ['go', 'python', 'nodejs', 'ruby', 'php', 'rust'].includes(backend.toLowerCase());
}

async function waitForPort(port, maxWaitSeconds = 45) {
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const socket = new net.Socket();
      socket.setTimeout(1000);

      return new Promise((resolve, reject) => {
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });

        socket.once('timeout', () => {
          socket.destroy();
          reject(new Error('Timeout'));
        });

        socket.once('error', (err) => {
          reject(err);
        });

        socket.connect(port, 'localhost');
      }).catch((err) => {
        // Port not ready yet, continue polling
        return false;
      });
    } catch (err) {
      // Continue polling
    }

    // Wait 500ms before retrying
    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error(`Port ${port} did not respond after ${maxWaitSeconds} seconds`);
}

async function cloneAndRun(cloneUrl, repoName, stack) {
  // Create apps directory if it doesn't exist
  if (!fs.existsSync(APPS_ROOT)) {
    fs.mkdirSync(APPS_ROOT, { recursive: true });
  }

  const repoPath = path.join(APPS_ROOT, repoName);

  // Remove existing clone if it exists
  if (fs.existsSync(repoPath)) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }

  console.log(`[AppRunner] Cloning ${cloneUrl} to ${repoPath}…`);

  try {
    // Clone the repository
    execSync(`git clone ${cloneUrl} "${repoPath}"`, { stdio: 'pipe' });
  } catch (err) {
    console.error('[AppRunner] Clone failed:', err.message);
    throw new Error(`Failed to clone repository: ${err.message}`);
  }

  // Determine backend port
  const defaultPorts = {
    'go': 8080,
    'python': 5000,
    'nodejs': 3000,
    'ruby': 3000,
    'php': 8000,
    'rust': 8000
  };

  const { backend } = stack || {};
  let port = defaultPorts[backend?.toLowerCase()] || 3000;

  // Find a free port
  port = await findFreePort(port);

  console.log(`[AppRunner] Starting ${repoName} on port ${port}…`);

  try {
    if (process.platform === 'win32') {
      const ps1 = [
        `Set-Location -Path '${repoPath}'`,
        `${'$'}env:PORT = '${port}'`,
        `Write-Host "[AppRunner] Starting server on port ${port}..." -ForegroundColor Cyan`,
        `& .\\start.ps1 -NoOpen`
      ];

      const child = spawn('powershell.exe', [
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-Command', ps1.join('; ')
      ], {
        detached: true,
        stdio: 'ignore',
        shell: false
      });

      child.on('error', (err) => {
        console.error('[AppRunner] PowerShell spawn error:', err);
      });

      child.unref();
      runningApps.set(repoName, { port, process: child, repoPath });
    } else {
      const cmd = `cd '${repoPath}' && export PORT=${port} && bash start.ps1`;
      const child = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        console.error('[AppRunner] Terminal spawn error:', err);
      });
      child.unref();
      runningApps.set(repoName, { port, process: child, repoPath });
    }
  } catch (err) {
    console.error('[AppRunner] Critical error launching app:', err);
    throw err;
  }

  // Wait for server to be ready
  try {
    await waitForPort(port, 45);
  } catch (err) {
    console.warn(`[AppRunner] Server did not respond within timeout: ${err.message}`);
  }

  const localUrl = `http://localhost:${port}`;
  console.log(`[AppRunner] ${repoName} running at ${localUrl}`);
  return localUrl;
}

async function findFreePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => resolve(findFreePort(startPort + 1)));
  });
}

function stopApp(repoName) {
  const existing = runningApps.get(repoName);
  if (existing?.process) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${existing.process.pid} /T /F`, { stdio: 'ignore' });
      } else {
        existing.process.kill('SIGTERM');
      }
    } catch (_) {}
    runningApps.delete(repoName);
  }
}

module.exports = { cloneAndRun, needsLocalRunner, stackNeedsLocalRunner, stopApp };

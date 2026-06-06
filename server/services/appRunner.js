'use strict';

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

// Use home directory instead of temp directory
const APPS_ROOT = path.join(os.homedir(), 'ready4launch-apps');

const runningApps = new Map();

function needsLocalRunner(files) {
  return files.some(f =>
    f.path === 'package.json' || f.path.endsWith('/package.json') ||
    f.path === 'go.mod' || f.path.endsWith('.go') ||
    f.path === 'requirements.txt' || f.path.endsWith('.py')
  );
}

function isBackendApp(files) {
  const hasNode = files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
  const hasGo = files.some(f => f.path === 'go.mod' || f.path === 'main.go');
  const hasPython = files.some(f => ['requirements.txt', 'main.py', 'app.py', 'server.py'].includes(f.path));
  return hasNode || hasGo || hasPython;
}

function getRunInfo(files) {
  const hasNode = files.some(f => f.path === 'package.json');
  const hasGo = files.some(f => f.path === 'go.mod' || f.path === 'main.go');
  const hasPython = files.some(f => f.path === 'requirements.txt');

  if (hasNode) return { cmd: 'npm start', type: 'nodejs', defaultPort: 3000 };
  if (hasGo) return { cmd: 'go run .', type: 'go', defaultPort: 8080 };
  if (hasPython) return { cmd: 'python main.py', type: 'python', defaultPort: 5000 };
  return null;
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

function saveFiles(appDir, files) {
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  fs.mkdirSync(appDir, { recursive: true });

  for (const { path: filePath, content } of files) {
    const fullPath = path.join(appDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
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

// NOTE: This is NOT called from /deploy anymore
// Only called from /api/run-local after git clone
async function runApp(repoName, clonedRepoPath) {
  const appDir = path.join(APPS_ROOT, repoName);

  // Files already in clonedRepoPath, just set up and run
  const port = await findFreePort(3000);

  stopApp(repoName);

  console.log(`[AppRunner] Starting ${repoName} at ${appDir}:${port}…`);

  try {
    if (process.platform === 'win32') {
      const ps1 = [
        `Set-Location -Path '${appDir}'`,
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
      runningApps.set(repoName, { port, process: child });
    } else {
      const cmd = `cd '${appDir}' && export PORT=${port} && ./start.ps1`;
      const child = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        console.error('[AppRunner] Terminal spawn error:', err);
      });
      child.unref();
      runningApps.set(repoName, { port, process: child });
    }
  } catch (err) {
    console.error('[AppRunner] Critical error launching app:', err);
  }

  await new Promise(r => setTimeout(r, 2000));
  const localUrl = `http://localhost:${port}`;
  console.log(`[AppRunner] ${repoName} running at ${localUrl}`);
  return localUrl;
}

module.exports = { runApp, needsLocalRunner, isBackendApp, getRunInfo };

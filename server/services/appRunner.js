'use strict';
/**
 * appRunner.js — Save generated app files locally and auto-launch the server
 *
 * Called after a successful GitHub deploy when the generated app is a full-stack
 * (Node.js/Express) application. Saves all files to generated-apps/{repoName}/,
 * installs dependencies, and starts the server in a new terminal window.
 *
 * For static HTML/CSS/JS apps this module is not invoked — they're served via
 * GitHub Pages directly.
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const net  = require('net');

// ── Paths ────────────────────────────────────────────────────────
const APPS_ROOT = path.join(__dirname, '..', '..', 'generated-apps');

// ── Running app registry ─────────────────────────────────────────
// Maps repoName → { port, process }
const runningApps = new Map();

// ── Helpers ──────────────────────────────────────────────────────

/** Detect whether this is a Node.js app by looking for package.json */
function isNodeApp(files) {
  return files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
}

/** Parse the port from package.json start script or server.js, default 3000 */
function detectPort(files) {
  const serverFile = files.find(f => f.path === 'server.js' || f.path === 'index.js');
  if (serverFile) {
    const m = serverFile.content.match(/PORT\s*[=||\s]+\s*(\d{4,5})/);
    if (m) return parseInt(m[1], 10);
  }
  return 3000;
}

/** Find a free port starting from a given number */
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

/** Write all files to the local generated-apps directory */
function saveFiles(appDir, files) {
  // Clean slate: remove directory if exists, then recreate
  if (fs.existsSync(appDir)) {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
  fs.mkdirSync(appDir, { recursive: true });

  for (const { path: filePath, content } of files) {
    const fullPath = path.join(appDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
  console.log(`[AppRunner] Saved ${files.length} files to ${appDir}`);
}

/** Patch server.js to use a specific port (overrides process.env.PORT default) */
function patchPort(appDir, port) {
  const serverPath = path.join(appDir, 'server.js');
  if (!fs.existsSync(serverPath)) return;
  let content = fs.readFileSync(serverPath, 'utf8');
  // Replace PORT assignment to use our chosen port
  content = content.replace(
    /const\s+PORT\s*=\s*process\.env\.PORT\s*\|\|\s*\d+/,
    `const PORT = process.env.PORT || ${port}`
  );
  fs.writeFileSync(serverPath, content, 'utf8');
}

/**
 * Kill any previously running app for this repo.
 */
function stopApp(repoName) {
  const existing = runningApps.get(repoName);
  if (existing?.process) {
    try {
      // On Windows: kill the process tree
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${existing.process.pid} /T /F`, { stdio: 'ignore' });
      } else {
        existing.process.kill('SIGTERM');
      }
    } catch (_) {}
    runningApps.delete(repoName);
    console.log(`[AppRunner] Stopped previous instance of ${repoName}`);
  }
}

/**
 * Save files, install deps, and launch the Node.js app in a new terminal window.
 * Returns the localhost URL.
 *
 * @param {string} repoName
 * @param {Array<{path:string, content:string}>} files
 * @returns {Promise<string>} localUrl — e.g. "http://localhost:4001"
 */
async function runApp(repoName, files) {
  if (!isNodeApp(files)) return null; // static apps don't need local runner

  const appDir  = path.join(APPS_ROOT, repoName);
  const suggestedPort = detectPort(files);
  const port    = await findFreePort(suggestedPort === 3000 ? 4000 : suggestedPort);

  // Stop any previous run
  stopApp(repoName);

  // Write all files
  saveFiles(appDir, files);

  // Patch port so there's no conflict with the Ready4Launch server (3000)
  patchPort(appDir, port);

  console.log(`[AppRunner] Installing dependencies for ${repoName}…`);

  if (process.platform === 'win32') {
    // ── Windows: open a new PowerShell window ────────────────────
    const ps1 = [
      `Set-Location -Path '${appDir}'`,
      `Write-Host "[Ready4Launch] Installing dependencies..." -ForegroundColor Cyan`,
      `npm install --prefer-offline 2>&1 | Out-Null`,
      `Write-Host "[Ready4Launch] Starting ${repoName} on port ${port}..." -ForegroundColor Green`,
      `$env:PORT = '${port}'`,
      `node server.js`,
    ].join('; ');

    const child = spawn('powershell.exe', [
      '-NoExit',
      '-Command', ps1,
    ], {
      detached: true,
      stdio:    'ignore',
      shell:    false,
    });
    child.unref();
    runningApps.set(repoName, { port, process: child });

  } else {
    // ── Unix/Mac: open a new terminal tab ────────────────────────
    const cmd = `npm install --prefer-offline > /dev/null 2>&1 && PORT=${port} node server.js`;
    let child;

    if (process.platform === 'darwin') {
      child = spawn('open', ['-a', 'Terminal', appDir], { detached: true, stdio: 'ignore' });
    } else {
      // Linux: try common terminal emulators
      child = spawn('bash', ['-c', `cd '${appDir}' && ${cmd}`], {
        detached: true, stdio: 'ignore',
      });
    }
    child.unref();
    runningApps.set(repoName, { port, process: child });
  }

  // Wait a moment for the server to start
  await new Promise(r => setTimeout(r, 2000));

  const localUrl = `http://localhost:${port}`;
  console.log(`[AppRunner] ${repoName} should be running at ${localUrl}`);
  return localUrl;
}

module.exports = { runApp, isNodeApp };

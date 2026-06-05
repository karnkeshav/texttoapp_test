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

// ── Backend type detectors ────────────────────────────────────────

/** Returns true for any app that needs the local runner (Node, Go, or Python). */
function needsLocalRunner(files) {
  return files.some(f =>
    f.path === 'package.json' || f.path.endsWith('/package.json') ||
    f.path === 'go.mod'       || f.path.endsWith('.go')           ||
    f.path === 'requirements.txt' || f.path.endsWith('.py')
  );
}

/** Kept for internal use — narrower check used by getRunInfo priority. */
function isNodeApp(files) {
  return files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
}
function isGoApp(files) {
  return files.some(f => f.path === 'go.mod' || f.path === 'main.go');
}
function isPythonApp(files) {
  return files.some(f => ['requirements.txt', 'main.py', 'app.py', 'server.py'].includes(f.path));
}
function isRubyApp(files) {
  return files.some(f => f.path === 'Gemfile' || f.path === 'config.ru');
}
/** Returns true for ANY app that has a backend server (not purely static) */
function isBackendApp(files) {
  return isNodeApp(files) || isGoApp(files) || isPythonApp(files) || isRubyApp(files);
}
/** Returns { cmd, type, defaultPort } for the detected backend, or null */
function getRunInfo(files) {
  if (isNodeApp(files))   return { cmd: 'npm install && npm start',                               type: 'nodejs',  defaultPort: 3000 };
  if (isGoApp(files))     return { cmd: 'go run .',                                               type: 'go',      defaultPort: 8080 };
  if (isPythonApp(files)) return { cmd: 'pip install -r requirements.txt && python main.py',       type: 'python',  defaultPort: 8000 };
  if (isRubyApp(files))   return { cmd: 'bundle install && ruby app.rb',                          type: 'ruby',    defaultPort: 4567 };
  return null;
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
 * Save files, install deps, and launch the app in a new terminal window.
 * Robust version with error handling and Go+Node concurrent support.
 *
 * @param {string} repoName
 * @param {Array<{path:string, content:string}>} files
 * @returns {Promise<string>} localUrl — e.g. "http://localhost:4001"
 */
async function runApp(repoName, files) {
  if (!needsLocalRunner(files)) return null;

  const appDir         = path.join(APPS_ROOT, repoName);
  const suggestedPort  = detectPort(files);
  const port           = await findFreePort(suggestedPort === 3000 ? 4000 : suggestedPort);

  stopApp(repoName);
  saveFiles(appDir, files);
  patchPort(appDir, port);

  console.log(`[AppRunner] Installing dependencies for ${repoName}…`);

  try {
    if (process.platform === 'win32') {
      const hasNode = files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
      const hasGo   = files.some(f => f.path === 'go.mod' || f.path.endsWith('.go'));

      const ps1 = [
        `Set-Location -Path '${appDir}'`,
        `$env:PORT = '${port}'`
      ];

      if (hasNode) {
        ps1.push(`Write-Host "[Ready4Launch] Installing Node dependencies..." -ForegroundColor Cyan`);
        ps1.push(`npm install --prefer-offline 2>&1 | Out-Null`);
      }
      if (hasGo) {
        ps1.push(`Write-Host "[Ready4Launch] Tending Go modules..." -ForegroundColor Cyan`);
        ps1.push(`if (Test-Path go.mod) { go mod tidy 2>&1 | Out-Null }`);
      }

      ps1.push(`Write-Host "[Ready4Launch] Starting servers..." -ForegroundColor Green`);

      if (hasNode && hasGo) {
        ps1.push(`Start-Process -NoNewWindow npm -ArgumentList "start"`);
        ps1.push(`go run .`);
      } else if (hasGo) {
        ps1.push(`go run .`);
      } else {
        ps1.push(`npm start >$null 2>&1 || node server.js`);
      }

      const child = spawn('powershell.exe', ['-NoExit', '-Command', ps1.join('; ')], {
        detached: true, stdio: 'ignore', shell: false,
      });

      // PREVENT CRASH: Handle asynchronous spawn errors
      child.on('error', (err) => {
        console.error('[AppRunner] PowerShell spawn error:', err);
      });

      child.unref();
      runningApps.set(repoName, { port, process: child });

    } else {
      // ── Unix/Mac logic updated for Go + React ───────────────
      const hasNode = files.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
      const hasGo   = files.some(f => f.path === 'go.mod' || f.path.endsWith('.go'));

      let cmd = `cd '${appDir}' && export PORT=${port} && `;
      if (hasNode) cmd += `npm install --prefer-offline > /dev/null 2>&1 ; `;
      if (hasGo)   cmd += `(test -f go.mod && go mod tidy > /dev/null 2>&1) ; `;

      if (hasNode && hasGo) {
        cmd += `npm start & go run .`;
      } else if (hasGo) {
        cmd += `go run .`;
      } else {
        cmd += `npm start >/dev/null 2>&1 || node server.js`;
      }

      let child;
      if (process.platform === 'darwin') {
        // Write to a temporary script file to run in a new Terminal window safely
        const os = require('os');
        const tmpScript = path.join(os.tmpdir(), `r4l-${Date.now()}.sh`);
        fs.writeFileSync(tmpScript, `#!/bin/bash\n${cmd}`);
        fs.chmodSync(tmpScript, '755');
        child = spawn('open', ['-a', 'Terminal', tmpScript], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' });
      }

      // PREVENT CRASH: Handle asynchronous spawn errors
      child.on('error', (err) => {
        console.error('[AppRunner] Terminal spawn error:', err);
      });

      child.unref();
      runningApps.set(repoName, { port, process: child });
    }
  } catch (launchErr) {
    // Catch any synchronous errors during execution formulation
    console.error('[AppRunner] Critical error launching app:', launchErr);
  }

  // Wait a moment for the server to start
  await new Promise(r => setTimeout(r, 2000));

  const localUrl = `http://localhost:${port}`;
  console.log(`[AppRunner] ${repoName} should be running at ${localUrl}`);
  return localUrl;
}

module.exports = { runApp, needsLocalRunner, isBackendApp, getRunInfo };

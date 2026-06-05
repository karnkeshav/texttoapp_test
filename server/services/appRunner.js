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
 * Save files, install deps, and launch the Node.js app in a new terminal window.
 * Returns the localhost URL.
 *
 * @param {string} repoName
 * @param {Array<{path:string, content:string}>} files
 * @returns {Promise<string>} localUrl — e.g. "http://localhost:4001"
 */
async function runApp(repoName, files) {
  const runInfo = getRunInfo(files);
  if (!runInfo) return null; // purely static — no server needed

  const appDir = path.join(APPS_ROOT, repoName);
  const port   = await findFreePort(runInfo.defaultPort === 3000 ? 4000 : runInfo.defaultPort);

  stopApp(repoName);
  saveFiles(appDir, files);

  // For Node.js: patch the port in server.js (existing logic)
  if (runInfo.type === 'nodejs') patchPort(appDir, port);

  console.log(`[AppRunner] Launching ${runInfo.type} app: ${repoName} on port ${port}`);

  let child;
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

    child = spawn('powershell.exe', ['-NoExit', '-Command', ps1.join('; ')], {
      detached: true, stdio: 'ignore', shell: false,
    });

  } else if (process.platform === 'darwin') {
    // macOS: write a launch script and open Terminal
    const script = path.join(appDir, '_start.sh');
    fs.writeFileSync(script, `#!/bin/bash\ncd "${appDir}"\nPORT=${port} ${runInfo.cmd}\n`, 'utf8');
    fs.chmodSync(script, 0o755);
    child = spawn('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' });

  } else {
    // Linux: try common terminal emulators; headless fallback for Render
    const fullCmd = `cd "${appDir}" && PORT=${port} ${runInfo.cmd}`;
    const terminals = ['gnome-terminal', 'xterm', 'konsole', 'x-terminal-emulator'];
    let launched = false;
    for (const term of terminals) {
      try {
        execSync(`which ${term}`, { stdio: 'ignore' });
        if (term === 'gnome-terminal') {
          child = spawn(term, ['--', 'bash', '-c', `${fullCmd}; exec bash`],
            { detached: true, stdio: 'ignore' });
        } else {
          child = spawn(term, ['-e', `bash -c "${fullCmd}; exec bash"`],
            { detached: true, stdio: 'ignore' });
        }
        launched = true;
        break;
      } catch (_) {}
    }
    if (!launched) {
      child = spawn('bash', ['-c', `${fullCmd} &`], { detached: true, stdio: 'ignore' });
    }
  }

  if (child) child.unref();
  runningApps.set(repoName, { port, process: child });

  // Wait for server to start (longer for Go/Python which need compile/install)
  const warmup = runInfo.type === 'nodejs' ? 2500 : 4000;
  await new Promise(r => setTimeout(r, warmup));

  const localUrl = `http://localhost:${port}`;
  console.log(`[AppRunner] ${repoName} should be running at ${localUrl}`);
  return localUrl;
}

module.exports = { runApp, needsLocalRunner, isBackendApp, getRunInfo };

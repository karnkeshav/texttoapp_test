const express = require('express');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const router = express.Router();

const { generateStartScript } = require('../services/startScriptGenerator');
const {
  sanitizeStack,
  frontendDevServerScript,
  backendServerScript,
  STATIC_SERVER_FILENAME,
  STATIC_SERVER_SOURCE,
} = require('../services/localRunCommands');

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// Only safe filesystem-name characters — no path separators, no leading dot,
// nothing that a shell or path.join could interpret as traversal.
const SAFE_REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function sanitizeRepoName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return SAFE_REPO_NAME_RE.test(trimmed) ? trimmed : null;
}

// Resolves `relPath` against `baseDir` and rejects anything that would
// escape it (../, absolute paths, symlink-style tricks) — a malicious
// AI-authored or client-supplied file path must never write outside appDir.
function safeJoin(baseDir, relPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relPath);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return resolvedTarget;
}

// POST /api/run-local
// Input: { cloneUrl, repoName, stack, files } OR { owner, repo, stack, files }
// Output: SSE stream with progress events
router.post('/run-local', async (req, res) => {
  const files = Array.isArray(req.body.files) ? req.body.files : null;
  const cloneUrl = req.body.cloneUrl || (req.body.owner && req.body.repo ? `https://github.com/${req.body.owner}/${req.body.repo}.git` : null);
  const repoName = sanitizeRepoName(req.body.repoName || req.body.repo);
  const stack = req.body.stack || { frontend: 'html', backend: 'none' };

  if ((req.body.repoName || req.body.repo) && !repoName) {
    return res.status(400).json({ error: 'repoName contains invalid characters — only letters, numbers, dots, hyphens and underscores are allowed' });
  }

  const isGitHubCloneRequest = !!(req.body.cloneUrl || req.body.owner || req.body.repo);

  // If cloning from GitHub, enforce GitHub auth and owner/repo validation
  if (isGitHubCloneRequest) {
    if (!req.session?.githubToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!req.body.owner && !req.body.cloneUrl) {
      return res.status(400).json({ error: 'owner and repo (or cloneUrl) are required' });
    }
    if (!repoName) {
      return res.status(400).json({ error: 'repoName is required' });
    }
  } else {
    if (!repoName) {
      return res.status(400).json({ error: 'repoName is required' });
    }
    // AUTHORITATIVE GUARD (OPTION A): Require Ready4Launch verified session artifact for direct execution
    const sessionFiles = req.session?.generatedFiles;
    const isVerifiedArtifact = Array.isArray(sessionFiles) &&
      sessionFiles.length > 0 &&
      req.session?.verification?.passed === true;

    if (!isVerifiedArtifact || !Array.isArray(sessionFiles) || sessionFiles.length === 0) {
      return res.status(400).json({ error: 'Application cannot be run because no verified build artifact exists.' });
    }
  }

  const effectiveFiles = isGitHubCloneRequest ? null : req.session?.generatedFiles;

  // Reject static HTML + No Backend (GitHub Pages only)
  const fe = (stack.frontend || '').toLowerCase();
  const be = (stack.backend || '').toLowerCase();
  if (fe === 'html' && be === 'none') {
    return res.status(400).json({ error: 'Run Locally only works for apps with backends — html+none deploys to GitHub Pages' });
  }

  // Clean up any previously running PIDs in session before spawning new process
  if (req.session.runLocalPids && req.session.runLocalPids.length > 0) {
    for (const oldPid of req.session.runLocalPids) {
      try {
        if (process.platform === 'win32') {
          require('child_process').execSync(`taskkill /PID ${oldPid} /T /F`, { stdio: 'ignore' });
        } else {
          process.kill(oldPid, 'SIGTERM');
        }
      } catch (_) {}
    }
    req.session.runLocalPids = [];
  }

  // Set up SSE response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function sendEvent(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  const appDir = path.join(os.homedir(), 'ready4launch-apps', repoName || 'my-app');

  try {
    // Ensure directory exists
    if (!fs.existsSync(appDir)) {
      fs.mkdirSync(appDir, { recursive: true });
    }

    sendEvent('progress', { message: 'Starting up application server...' });

    if (files && files.length > 0) {
      // Write files directly to local disk — reject any path that would
      // escape appDir (e.g. "../../etc/passwd") instead of silently writing there.
      for (const file of files) {
        if (!file.path || typeof file.content !== 'string') continue;
        const filePath = safeJoin(appDir, file.path);
        if (!filePath) {
          sendEvent('error', { message: `Rejected unsafe file path: ${file.path}` });
          return res.end();
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content, 'utf-8');
      }

      sendEvent('progress', { message: 'Local files written. Starting server...' });
    } else if (cloneUrl) {
      // Clone the repo
      const urlWithToken = req.session?.githubToken && cloneUrl.includes('github.com')
        ? cloneUrl.replace('https://', `https://x-oauth-basic:${req.session.githubToken}@`)
        : cloneUrl;

      const cloneProcess = cp.spawn('git', ['clone', '--depth', '1', urlWithToken, appDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      });

      let cloneOutput = '';
      let cloneError = '';

      cloneProcess.stdout.on('data', (data) => {
        cloneOutput += data.toString();
      });

      cloneProcess.stderr.on('data', (data) => {
        cloneError += data.toString();
      });

      await new Promise((resolve, reject) => {
        cloneProcess.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Git clone failed: ${cloneError}`));
          }
        });
        cloneProcess.on('error', reject);
      });

      sendEvent('progress', { message: 'Repository cloned. Starting server...' });
    }

    // Sanitize once — every downstream command is selected by lookup on
    // these validated values, never built by interpolating the raw stack
    // fields into a shell string.
    const safeStack = sanitizeStack(stack);

    // Find a free port
    const port = await findFreePort(safeStack.backend === 'go' ? 8080 : 3000);

    // Save port to environment file
    sendEvent('progress', { message: `Using port ${port}...` });

    // Resolve what actually gets launched: a frontend's own dev server
    // (Angular/Svelte/Next/Nuxt), a backend server (Node/Python/Go/Ruby/
    // PHP/Rust/Java/C#), or — when there's no backend at all — a static
    // file server for a CDN-only React/Vue/HTML app.
    const plan = frontendDevServerScript(safeStack.frontend) || backendServerScript(safeStack.backend);
    const usingStaticFallback = !plan;

    // Execute start script
    let runnerProcess;
    const usePowerShell = process.platform === 'win32' || process.env.NODE_ENV === 'test';

    if (usingStaticFallback) {
      // No shell needed — spawning node with array args works identically
      // on every platform, so this bypasses the bash/PowerShell split (and
      // the fact that generateStartScript() has nothing to generate when
      // there's no backend at all).
      fs.writeFileSync(path.join(appDir, STATIC_SERVER_FILENAME), STATIC_SERVER_SOURCE, 'utf-8');
      runnerProcess = cp.spawn('node', [STATIC_SERVER_FILENAME], {
        cwd: appDir,
        env: { ...process.env, PORT: String(port) },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else if (usePowerShell) {
      // Ensure start.ps1 exists — only reached when `plan` is non-null, so
      // generateStartScript() always has a real frontend+backend to generate for.
      const startPs1Path = path.join(appDir, 'start.ps1');
      if (!fs.existsSync(startPs1Path)) {
        const scriptContent = generateStartScript(safeStack);
        if (scriptContent) {
          fs.writeFileSync(startPs1Path, scriptContent, 'utf-8');
        }
      }

      // cwd (below) already places us in appDir — no need to interpolate
      // the path into the script itself.
      const psCommand = `
        ${'$'}env:PORT = ${port}
        & .\\start.ps1 -NoOpen
      `;

      runnerProcess = cp.spawn('powershell.exe', [
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-Command', psCommand
      ], {
        cwd: appDir,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false
      });
    } else {
      // cwd (below) already places us in appDir — no need to interpolate
      // the path into the script itself. plan.install/plan.start are fixed
      // literal templates selected by sanitizeStack() + lookup above, never
      // raw stack values, so this interpolation is safe.
      //
      // No "echo READY" here on purpose — that used to fire unconditionally
      // right before the actual start command ran, so it could report ready
      // even when the app failed to come up. The HTTP poll below is the only
      // source of truth for readiness now; it confirms the port is actually
      // accepting connections.
      const bashCmd = `
        export PORT=${port}
        echo "PROGRESS: [1/3] Checking environment & installing dependencies..."
        ${plan.install}
        echo "PROGRESS: [2/3] Starting server on port ${port}..."
        ${plan.start}
      `;
      runnerProcess = cp.spawn('bash', ['-c', bashCmd], {
        cwd: appDir,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }

    let serverReady = false;
    let hasErrorEmitted = false;
    let stdoutBuffer = '';

    if (runnerProcess) {
      if (runnerProcess.stdout) {
        runnerProcess.stdout.on('data', (data) => {
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop();

          for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            if (line.startsWith('PROGRESS:')) {
              sendEvent('progress', { message: line.slice(9).trim() });
            } else if (line.startsWith('READY:')) {
              serverReady = true;
              sendEvent('ready', { url: line.slice(6).trim() });
              if (!res.writableEnded) res.end();
            } else if (line.startsWith('ERROR:')) {
              hasErrorEmitted = true;
              sendEvent('error', { message: line.slice(6).trim() });
              if (!res.writableEnded) res.end();
            } else {
              sendEvent('progress', { message: line });
            }
          }
        });
      }

      if (runnerProcess.stderr) {
        runnerProcess.stderr.on('data', (data) => {
          const msg = data.toString().trim();
          if (msg) sendEvent('progress', { message: msg });
        });
      }

      runnerProcess.on('close', (code) => {
        if (code !== 0 && !hasErrorEmitted && !serverReady) {
          hasErrorEmitted = true;
          sendEvent('error', { message: `Process ended unexpectedly with code ${code}` });
          if (!res.writableEnded) res.end();
        } else if (code === 0 && !serverReady && !hasErrorEmitted) {
          hasErrorEmitted = true;
          sendEvent('error', { message: 'Process ended unexpectedly' });
          if (!res.writableEnded) res.end();
        }
      });

      runnerProcess.on('error', (err) => {
        console.error('[RunLocal] Spawn error:', err);
        if (!hasErrorEmitted) {
          hasErrorEmitted = true;
          sendEvent('error', { message: `Failed to start server: ${err.message}` });
          if (!res.writableEnded) res.end();
        }
      });

      if (runnerProcess.unref) runnerProcess.unref();

      // Store PID for cleanup
      if (!req.session.runLocalPids) req.session.runLocalPids = [];
      req.session.runLocalPids.push(runnerProcess.pid);
    }

    // If server is not ready or errored yet, wait for HTTP response.
    // `npm install` on a fresh project routinely takes well over 5 seconds
    // (much longer on a cold cache or a slow filesystem), so this window
    // has to be generous — a short timeout here doesn't stop the app from
    // starting, it just abandons the SSE stream and reports failure while
    // installation is still quietly succeeding in the background.
    if (!serverReady && !hasErrorEmitted) {
      sendEvent('progress', { message: 'Waiting for server to start (this can take a minute on first install)...' });

      const maxWait = 180_000; // 3 minutes max for HTTP poll
      const startTime = Date.now();
      let lastHeartbeat = startTime;

      while (Date.now() - startTime < maxWait && !hasErrorEmitted && !serverReady) {
        try {
          const http = require('http');

          const req2 = http.request(
            {
              hostname: 'localhost',
              port: port,
              path: '/',
              timeout: 500
            },
            (res2) => {
              if (res2.statusCode < 500) {
                serverReady = true;
              }
            }
          );

          req2.on('error', () => {});
          req2.on('timeout', () => { req2.destroy(); });
          req2.end();

          if (serverReady) break;
        } catch (_) {}

        // Heartbeat every ~10s so the client knows install is still in progress,
        // not stuck.
        if (Date.now() - lastHeartbeat > 10_000) {
          lastHeartbeat = Date.now();
          const elapsedSec = Math.round((Date.now() - startTime) / 1000);
          sendEvent('progress', { message: `Still waiting for the server to respond… (${elapsedSec}s)` });
        }

        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (serverReady && !res.writableEnded) {
      sendEvent('ready', { url: `http://localhost:${port}` });
      res.end();
    } else if (!serverReady && !hasErrorEmitted && !res.writableEnded) {
      sendEvent('error', { message: 'Server did not respond within 3 minutes — it may still be installing in the background. Check the terminal or try opening the URL directly in a moment.' });
      res.end();
    }

  } catch (err) {
    console.error('[RunLocal] Error:', err.message);
    sendEvent('error', { message: err.message });
    res.end();
  }
});

// POST /api/run-local/stop
// Kills PIDs stored in session
router.post('/run-local/stop', requireAuth, (req, res) => {
  const pids = req.session.runLocalPids || [];
  let killed = 0;

  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      killed++;
    } catch (_) {}
  }

  req.session.runLocalPids = [];
  res.json({ stopped: killed });
});

async function findFreePort(preferred) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(preferred, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', async () => {
      resolve(await findFreePort(preferred + 1));
    });
  });
}

module.exports = router;

'use strict';

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// POST /api/run-local
// Input: { cloneUrl, repoName, stack }
// Output: SSE stream with progress events
router.post('/run-local', requireAuth, async (req, res) => {
  const { cloneUrl, repoName, stack } = req.body;

  if (!cloneUrl || !repoName) {
    return res.status(400).json({ error: 'cloneUrl and repoName are required' });
  }

  // Only allow full-stack apps
  if (!stack?.backend || stack.backend === 'none' || !stack.frontend || stack.frontend === 'html') {
    return res.status(400).json({ error: 'Run Locally only works for full-stack apps with backends' });
  }

  // Set up SSE response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function sendEvent(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  const appDir = path.join(os.homedir(), 'ready4launch-apps', repoName);

  try {
    // Ensure directory exists
    if (!fs.existsSync(path.dirname(appDir))) {
      fs.mkdirSync(path.dirname(appDir), { recursive: true });
    }

    sendEvent('progress', { message: 'Cloning repository...' });

    // Clone the repo
    // Add GitHub token to URL if needed
    const urlWithToken = cloneUrl.includes('github.com')
      ? cloneUrl.replace('https://', `https://x-oauth-basic:${req.session.githubToken}@`)
      : cloneUrl;

    const cloneProcess = spawn('git', ['clone', '--depth', '1', urlWithToken, appDir], {
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

    // Find a free port
    const port = await findFreePort(stack.backend === 'go' ? 8080 : 3000);

    // Save port to environment file
    sendEvent('progress', { message: `Using port ${port}...` });

    // Execute start.ps1 on Windows
    if (process.platform === 'win32') {
      const psCommand = `
        ${'$'}env:PORT = ${port}
        Set-Location -Path '${appDir}'
        & .\\start.ps1 -NoOpen
      `;

      const psProcess = spawn('powershell.exe', [
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-Command', psCommand
      ], {
        cwd: appDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });

      psProcess.on('error', (err) => {
        console.error('[RunLocal] PowerShell spawn error:', err);
        sendEvent('error', { message: `Failed to start server: ${err.message}` });
      });

      psProcess.unref();

      // Store PID for cleanup
      if (!req.session.runLocalPids) req.session.runLocalPids = [];
      req.session.runLocalPids.push(psProcess.pid);
    }

    // Wait for server to respond
    sendEvent('progress', { message: 'Waiting for server to start...' });

    const maxWait = 45000; // 45 seconds
    const startTime = Date.now();
    let serverReady = false;

    while (Date.now() - startTime < maxWait) {
      try {
        const http = require('http');

        const req2 = http.request(
          {
            hostname: 'localhost',
            port: port,
            path: '/',
            timeout: 1000
          },
          (res2) => {
            if (res2.statusCode < 500) {
              serverReady = true;
            }
          }
        );

        req2.on('error', () => {
          // Server not ready yet
        });

        req2.on('timeout', () => {
          req2.destroy();
        });

        req2.end();

        if (serverReady) break;
      } catch (_) {}

      await new Promise(r => setTimeout(r, 500));
    }

    if (!serverReady) {
      sendEvent('error', { message: 'Server failed to respond after 45 seconds' });
      return res.end();
    }

    const localUrl = `http://localhost:${port}`;
    sendEvent('ready', { url: localUrl });
    res.end();

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

const express      = require('express');
const childProcess = require('child_process'); // not destructured — lets tests spy on .spawn
const path         = require('path');
const os           = require('os');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function killPreviousProcesses(req) {
  const pids = req.session.runLocalPids || [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  }
  req.session.runLocalPids = [];
}

// POST /api/run-local — clone repo, install deps, start servers, stream progress via SSE
router.post('/run-local', requireAuth, (req, res) => {
  const { owner, repo, stack } = req.body;
  if (!owner || !repo) return res.status(400).json({ error: 'owner and repo are required' });

  const frontend = (stack?.frontend || 'html').toLowerCase();
  const backend  = (stack?.backend  || 'none').toLowerCase();

  if (frontend === 'html' && backend === 'none') {
    return res.status(400).json({ error: 'Static HTML apps use GitHub Pages — no local run needed.' });
  }

  killPreviousProcesses(req);

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const token      = req.session.githubToken;
  const repoUrl    = `https://${token}@github.com/${owner}/${repo}.git`;
  const tempDir    = path.join(os.tmpdir(), `r4l-${owner}-${repo}-${Date.now()}`);
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'run-local.ps1');

  send('progress', { message: 'Starting up…' });

  const ps = childProcess.spawn('powershell.exe', [
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File',     scriptPath,
    '-RepoUrl',  repoUrl,
    '-TempDir',  tempDir,
    '-Frontend', frontend,
    '-Backend',  backend,
  ], { windowsHide: true });

  req.session.runLocalPids = [ps.pid];
  if (typeof req.session.save === 'function') {
    req.session.save((err) => { if (err) console.warn('[RunLocal] session save:', err.message); });
  }

  let buf = '';

  ps.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith('READY:')) {
        send('ready', { url: t.slice(6).trim() });
        if (!res.writableEnded) res.end();
      } else if (t.startsWith('ERROR:')) {
        send('error', { message: t.slice(6).trim() });
        if (!res.writableEnded) res.end();
      } else if (t.startsWith('PROGRESS:')) {
        send('progress', { message: t.slice(9).trim() });
      }
    }
  });

  ps.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) send('progress', { message: msg });
  });

  ps.on('close', (code) => {
    if (!res.writableEnded) {
      send('error', { message: code !== 0 ? `Process exited with code ${code}` : 'Process ended unexpectedly.' });
      res.end();
    }
  });

  req.on('close', () => { try { ps.kill(); } catch (_) {} });
});

// POST /api/run-local/stop — kill previously started processes
router.post('/run-local/stop', requireAuth, (req, res) => {
  const pids = req.session.runLocalPids || [];
  let killed = 0;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); killed++; } catch (_) {}
  }
  req.session.runLocalPids = [];
  if (typeof req.session.save === 'function') req.session.save(() => {});
  res.json({ stopped: killed });
});

module.exports = router;

'use strict';

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const geminiPool = require('./geminiPool');
const codeQuality = require('./codeQuality');

const APPS_ROOT = path.join(os.homedir(), 'ready4launch-apps');
const runningApps = new Map();

// ── Atomic Generation Orchestrator ──────────────────────────────────────────

async function buildAppAtomic(requirements, apiKey, repoPath) {
  console.log(`[AtomicBuild] Starting generation for: ${repoPath}`);

  // 1. Generate Manifest
  const manifestPrompt = `
    Create a file structure manifest for this app: ${requirements}.
    Return ONLY a JSON object: { "files": [ { "path": "filename.ext", "purpose": "description" } ] }.
    Include config files, backend, frontend. Return pure JSON.
  `;

  const manifestResult = await geminiPool.pooledGenerate({
    contents: [{ role: 'user', parts: [{ text: manifestPrompt }] }],
    config: { temperature: 0.1, maxOutputTokens: 4096 },
    apiKey
  });

  const manifest = JSON.parse(manifestResult.replace(/```json|```/g, '').trim());
  console.log(`[AtomicBuild] Manifest created with ${manifest.files.length} files.`);

  // 2. Sequential Atomic Loop
  for (const file of manifest.files) {
    console.log(`[AtomicBuild] Generating: ${file.path}...`);
    
    // Generate File Content
    const content = await geminiPool.pooledGenerate({
      contents: [{ role: 'user', parts: [{ text: `Generate the content for ${file.path}. Context: ${requirements}` }] }],
      config: { temperature: 0.2, maxOutputTokens: 4096 },
      apiKey
    });

    // 3. Audit & Heal (The Quality Gate)
    const audit = await codeQuality.auditAndHeal(content, apiKey, 'gemini-3-flash-preview', requirements);
    
    if (!audit.healed && audit.issues.length > 0) {
      throw new Error(`Critical build failure in ${file.path}: ${audit.issues.join('; ')}`);
    }

    // 4. Commit to Disk
    const fullPath = path.join(repoPath, file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, audit.code);
    console.log(`[AtomicBuild] ✅ ${file.path} committed.`);
  }

  return true;
}

// ── Existing Runner Logic (Preserved) ────────────────────────────────────────

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
  if (!backend || backend === 'none' || backend === 'html') return false;
  return ['go', 'python', 'nodejs', 'ruby', 'php', 'rust'].includes(backend.toLowerCase());
}

function isBackendApp(files) {
  if (!files || !Array.isArray(files)) return false;
  const backendPatterns = ['package.json', 'go.mod', 'requirements.txt', 'main.py', 'Gemfile', 'Cargo.toml', 'composer.json'];
  return files.some(f => {
    const fileName = f.path?.split('/').pop() || f.path || '';
    return backendPatterns.includes(fileName) || fileName.endsWith('.go') || fileName.endsWith('.py') || fileName.endsWith('.rb') || fileName.endsWith('.rs') || fileName.endsWith('.php');
  });
}

async function waitForPort(port, maxWaitSeconds = 45) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitSeconds * 1000) {
    try {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        socket.connect(port, 'localhost');
      });
      socket.destroy();
      return true;
    } catch (e) { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error(`Port ${port} did not respond.`);
}

async function cloneAndRun(cloneUrl, repoName, stack) {
  if (!fs.existsSync(APPS_ROOT)) fs.mkdirSync(APPS_ROOT, { recursive: true });
  const repoPath = path.join(APPS_ROOT, repoName);
  if (fs.existsSync(repoPath)) fs.rmSync(repoPath, { recursive: true, force: true });

  console.log(`[AppRunner] Cloning ${cloneUrl}…`);
  execSync(`git clone ${cloneUrl} "${repoPath}"`, { stdio: 'pipe' });

  const { backend } = stack || {};
  let port = await findFreePort({ 'go': 8080, 'python': 5000, 'nodejs': 3000 }[backend?.toLowerCase()] || 3000);

  if (process.platform === 'win32') {
    const ps1 = [`Set-Location -Path '${repoPath}'`, `${'$'}env:PORT = '${port}'`, `& .\\start.ps1 -NoOpen`];
    const child = spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', ps1.join('; ')], { detached: true, stdio: 'ignore' });
    child.unref();
    runningApps.set(repoName, { port, process: child, repoPath });
  } else {
    const cmd = `cd '${repoPath}' && export PORT=${port} && bash start.ps1`;
    const child = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' });
    child.unref();
    runningApps.set(repoName, { port, process: child, repoPath });
  }

  await waitForPort(port, 45);
  return `http://localhost:${port}`;
}

async function findFreePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', () => resolve(findFreePort(startPort + 1)));
  });
}

function stopApp(repoName) {
  const existing = runningApps.get(repoName);
  if (existing?.process) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${existing.process.pid} /T /F`, { stdio: 'ignore' });
      else existing.process.kill('SIGTERM');
    } catch (_) {}
    runningApps.delete(repoName);
  }
}

module.exports = { buildAppAtomic, cloneAndRun, needsLocalRunner, stackNeedsLocalRunner, stopApp, isBackendApp };

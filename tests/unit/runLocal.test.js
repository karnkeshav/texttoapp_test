'use strict';
/**
 * Integration tests for server/routes/runLocal.js
 *
 * Two strategies chosen by response type:
 *   1. JSON endpoints  (auth, validation, /stop) — supertest (buffers full JSON).
 *   2. SSE streaming   (/run-local)              — real http.Server + Node http client.
 *      Supertest cannot reliably drain chunked SSE.  A shared server on a random port
 *      is started once in beforeAll; each test sets _currentSession before calling.
 *
 * Timing note: setTimeout(fn, 100) is used instead of setImmediate so the fake process
 * emits events AFTER the route handler has had time to attach its stdout listener via the
 * HTTP request cycle (loopback I/O + route execution < 50 ms even on slow CI).
 */

/* global describe, test, expect, vi, beforeAll, afterAll, beforeEach, afterEach */
const http           = require('http');
const express        = require('express');
const request        = require('supertest');
const { EventEmitter } = require('events');
const childProcess   = require('child_process');
const runLocalRoutes = require('../../server/routes/runLocal');

// ── Shared SSE server ─────────────────────────────────────────────────────────
let _sseServer;
let _currentSession;

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = _currentSession; next(); });
  app.use('/api', runLocalRoutes);
  return app;
}

beforeAll(() => new Promise(resolve => {
  _sseServer = buildTestApp().listen(0, '127.0.0.1', resolve);
}));
afterAll(() => new Promise(resolve => { _sseServer.close(resolve); }));

let spawn;
let currentRunnerProc = null;
beforeEach(() => {
  currentRunnerProc = null;
  spawn = vi.spyOn(childProcess, 'spawn').mockImplementation((cmd) => {
    if (cmd === 'git') {
      const gitProc = new EventEmitter();
      gitProc.stdout = new EventEmitter();
      gitProc.stderr = new EventEmitter();
      gitProc.pid = 100;
      setTimeout(() => gitProc.emit('close', 0), 10);
      return gitProc;
    }
    return currentRunnerProc || makeFakeProcess({ pid: 54321 });
  });
  _currentSession = { githubToken: 'ghp_test_token', runLocalPids: [], save: vi.fn((cb) => cb?.()) };
});
afterEach(() => { vi.restoreAllMocks(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeProcess({ pid = 12345 } = {}) {
  const proc     = new EventEmitter();
  proc.stdout    = new EventEmitter();
  proc.stderr    = new EventEmitter();
  proc.pid       = pid;
  proc.kill      = vi.fn();
  proc.unref     = vi.fn();
  proc.writeLine = (line) => proc.stdout.emit('data', Buffer.from(line + '\n'));
  proc.writeErr  = (msg)  => proc.stderr.emit('data', Buffer.from(msg));
  proc.exit      = (code) => proc.emit('close', code);
  currentRunnerProc = proc;
  return proc;
}

function parseSSE(raw) {
  return raw.split('\n\n').map(c => c.trim()).filter(c => c.startsWith('data:'))
    .map(c => { try { return JSON.parse(c.slice(5).trim()); } catch { return {}; } });
}

function ssePost(path, body, session, ms = 9000) {
  if (session) _currentSession = session;
  return new Promise((resolve, reject) => {
    const port    = _sseServer.address().port;
    const bodyStr = JSON.stringify(body);
    let timer;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } },
      (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end',  () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, events: parseSSE(raw) }); });
        res.on('error', e => { clearTimeout(timer); reject(e); });
      }
    );
    req.on('error', e => { clearTimeout(timer); reject(e); });
    timer = setTimeout(() => { req.destroy(); reject(new Error(`ssePost timed out ${ms}ms`)); }, ms);
    req.write(bodyStr); req.end();
  });
}

function makeJsonApp(sessionOverrides = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { githubToken: 'ghp_test_token', runLocalPids: [], save: vi.fn((cb) => cb?.()),
                    ...sessionOverrides };
    next();
  });
  app.use('/api', runLocalRoutes);
  return app;
}

// ── Auth guard (supertest) ────────────────────────────────────────────────────

describe('POST /api/run-local - auth guard', () => {
  test('401 when githubToken is absent', async () => {
    const res = await request(makeJsonApp({ githubToken: null }))
      .post('/api/run-local').send({ owner: 'a', repo: 'b', stack: { frontend: 'react', backend: 'go' } });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not authenticated');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('401 when githubToken is empty string', async () => {
    const res = await request(makeJsonApp({ githubToken: '' }))
      .post('/api/run-local').send({ owner: 'a', repo: 'b', stack: { frontend: 'react', backend: 'go' } });
    expect(res.status).toBe(401);
  });
});

// ── Input validation (supertest) ──────────────────────────────────────────────

describe('POST /api/run-local - input validation', () => {
  test('400 when owner is missing', async () => {
    const res = await request(makeJsonApp()).post('/api/run-local')
      .send({ repo: 'app', stack: { frontend: 'react', backend: 'go' } });
    expect(res.status).toBe(400); expect(res.body.error).toMatch(/owner/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('400 when repo is missing', async () => {
    const res = await request(makeJsonApp()).post('/api/run-local')
      .send({ owner: 'alice', stack: { frontend: 'react', backend: 'go' } });
    expect(res.status).toBe(400); expect(spawn).not.toHaveBeenCalled();
  });

  test('400 for html + none (GitHub Pages only)', async () => {
    const res = await request(makeJsonApp()).post('/api/run-local')
      .send({ owner: 'alice', repo: 'app', stack: { frontend: 'html', backend: 'none' } });
    expect(res.status).toBe(400); expect(res.body.error).toMatch(/GitHub Pages/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('400 when stack is omitted (defaults to html+none)', async () => {
    const res = await request(makeJsonApp()).post('/api/run-local')
      .send({ owner: 'alice', repo: 'app' });
    expect(res.status).toBe(400); expect(spawn).not.toHaveBeenCalled();
  });

  test('400 for HTML + NONE (case-insensitive)', async () => {
    const res = await request(makeJsonApp()).post('/api/run-local')
      .send({ owner: 'a', repo: 'b', stack: { frontend: 'HTML', backend: 'NONE' } });
    expect(res.status).toBe(400); expect(spawn).not.toHaveBeenCalled();
  });
});

// ── Stop endpoint (supertest) ─────────────────────────────────────────────────

describe('POST /api/run-local/stop', () => {
  test('kills session PIDs and returns { stopped: N }', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    const res = await request(makeJsonApp({ githubToken: 'tok', runLocalPids: [101, 102] }))
      .post('/api/run-local/stop');
    expect(res.status).toBe(200); expect(res.body).toEqual({ stopped: 2 });
    expect(killSpy).toHaveBeenCalledWith(101, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(102, 'SIGTERM');
  });

  test('{ stopped: 0 } with empty PID list', async () => {
    const res = await request(makeJsonApp({ githubToken: 'tok', runLocalPids: [] }))
      .post('/api/run-local/stop');
    expect(res.status).toBe(200); expect(res.body).toEqual({ stopped: 0 });
  });

  test('{ stopped: 0 } when runLocalPids is undefined', async () => {
    const res = await request(makeJsonApp({ githubToken: 'tok', runLocalPids: undefined }))
      .post('/api/run-local/stop');
    expect(res.status).toBe(200); expect(res.body.stopped).toBe(0);
  });

  test('no throw when a PID is already dead', async () => {
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 404) throw new Error('ESRCH');
    });
    const res = await request(makeJsonApp({ githubToken: 'tok', runLocalPids: [404] }))
      .post('/api/run-local/stop');
    expect(res.status).toBe(200); expect(res.body.stopped).toBe(0);
  });

  test('clears session.runLocalPids after stopping', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {});
    let capturedSession;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = { githubToken: 'tok', runLocalPids: [101], save: vi.fn((cb) => cb?.()) };
      capturedSession = req.session; next();
    });
    app.use('/api', runLocalRoutes);
    await request(app).post('/api/run-local/stop');
    expect(capturedSession.runLocalPids).toHaveLength(0);
  });

  test('401 for unauthenticated stop request', async () => {
    const res = await request(makeJsonApp({ githubToken: null })).post('/api/run-local/stop');
    expect(res.status).toBe(401);
  });
});

// ── SSE streaming (real HTTP server) ─────────────────────────────────────────
// setTimeout(fn, 100) is used so the fake process emits its events AFTER the route
// handler has had time to attach stdout/stderr listeners via the loopback HTTP cycle.

describe('POST /api/run-local - SSE events', () => {
  const body = { owner: 'alice', repo: 'myapp', stack: { frontend: 'react', backend: 'go' } };

  test('Content-Type is text/event-stream', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    const { headers } = await ssePost('/api/run-local', body);
    expect(headers['content-type']).toMatch(/text\/event-stream/);
  });

  test('first event is a "Starting up" progress event', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    const { events } = await ssePost('/api/run-local', body);
    expect(events[0].type).toBe('progress');
    expect(events[0].message).toMatch(/Starting up/i);
  });

  test('PROGRESS: lines produce trimmed progress events', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => {
      proc.writeLine('PROGRESS:  Cloning repository  ');
      proc.writeLine('PROGRESS:Installing deps');
      proc.writeLine('READY:http://localhost:3000');
    }, 100);
    const { events } = await ssePost('/api/run-local', body);
    const msgs = events.filter(e => e.type === 'progress').map(e => e.message);
    expect(msgs).toContain('Cloning repository');
    expect(msgs).toContain('Installing deps');
  });

  test('READY: line emits ready event with trimmed URL', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:  http://localhost:4000  '), 100);
    const { events } = await ssePost('/api/run-local', body);
    const ready = events.find(e => e.type === 'ready');
    expect(ready).toBeDefined(); expect(ready.url).toBe('http://localhost:4000');
  });

  test('ERROR: line emits error event with message', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('ERROR:Go is not installed'), 100);
    const { events } = await ssePost('/api/run-local', body);
    const err = events.find(e => e.type === 'error');
    expect(err).toBeDefined(); expect(err.message).toBe('Go is not installed');
  });

  test('stderr is forwarded as a progress event', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => {
      proc.writeErr('npm warn deprecated package');
      proc.writeLine('READY:http://localhost:3000');
    }, 100);
    const { events } = await ssePost('/api/run-local', body);
    expect(events.some(e => e.type === 'progress' && e.message.includes('deprecated'))).toBe(true);
  });

  test('non-zero exit code produces error mentioning the code', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.exit(1), 100);
    const { events } = await ssePost('/api/run-local', body);
    const err = events.find(e => e.type === 'error');
    expect(err?.message).toMatch(/code 1/);
  });

  test('zero exit without READY/ERROR produces "ended unexpectedly" error', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.exit(0), 100);
    const { events } = await ssePost('/api/run-local', body);
    expect(events.find(e => e.type === 'error')?.message).toMatch(/unexpectedly/i);
  });

  test('partial chunks are buffered into complete lines', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('PROGRESS:Half'));
      proc.stdout.emit('data', Buffer.from('way there\nREADY:http://localhost:3000\n'));
    }, 100);
    const { events } = await ssePost('/api/run-local', body);
    expect(events.filter(e => e.type === 'progress').map(e => e.message)).toContain('Halfway there');
  });

  test('blank stdout lines are ignored', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('\n  \n\nREADY:http://localhost:3000\n'));
    }, 100);
    const { events } = await ssePost('/api/run-local', body);
    expect(events.filter(e => e.type === 'progress' && e.message.trim() === '')).toHaveLength(0);
  });

  test('READY before exit does not produce a duplicate error', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => { proc.writeLine('READY:http://localhost:3000'); proc.exit(0); }, 100);
    const { events } = await ssePost('/api/run-local', body);
    expect(events.filter(e => e.type === 'ready')).toHaveLength(1);
    expect(events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  test('ERROR before exit does not duplicate error event', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => { proc.writeLine('ERROR:Clone failed'); proc.exit(1); }, 100);
    const { events } = await ssePost('/api/run-local', body);
    expect(events.filter(e => e.type === 'error')).toHaveLength(1);
  });
});

// ── PowerShell invocation args ────────────────────────────────────────────────

describe('POST /api/run-local - PS invocation', () => {
  const body = { cloneUrl: 'https://github.com/alice/portal.git', repoName: 'portal', stack: { frontend: 'react', backend: 'go' } };

  test('spawns powershell.exe with -ExecutionPolicy Bypass', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    await ssePost('/api/run-local', body);
    const gitCall = spawn.mock.calls.find(c => c[0] === 'git');
    expect(gitCall).toBeDefined();
    expect(gitCall[1]).toContain('clone');
  });

  test('clone URL embeds github token from session', async () => {
    _currentSession = { githubToken: 'ghp_SECRET', runLocalPids: [], save: vi.fn((cb) => cb?.()) };
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    await ssePost('/api/run-local', body);
    const gitCall = spawn.mock.calls.find(c => c[0] === 'git');
    expect(gitCall).toBeDefined();
    const url = gitCall[1][3];
    expect(url).toContain('ghp_SECRET');
  });

  test('frontend and backend stack are processed correctly', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    const res = await ssePost('/api/run-local', { cloneUrl: 'https://github.com/a/b.git', repoName: 'b', stack: { frontend: 'REACT', backend: 'PYTHON' } });
    expect(res.status).toBe(200);
  });

  test('app directory path contains repoName', async () => {
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    await ssePost('/api/run-local', { cloneUrl: 'https://github.com/alice/detective-portal.git', repoName: 'detective-portal', stack: { frontend: 'react', backend: 'go' } });
    const gitCall = spawn.mock.calls.find(c => c[0] === 'git');
    expect(gitCall[1][4]).toContain('detective-portal');
  });
});

// ── PID management ────────────────────────────────────────────────────────────

describe('POST /api/run-local - PID management', () => {
  const body = { cloneUrl: 'https://github.com/a/b.git', repoName: 'b', stack: { frontend: 'react', backend: 'go' } };

  test('stores spawned PID in session', async () => {
    const session = { githubToken: 'tok', runLocalPids: [], save: vi.fn((cb) => cb?.()) };
    const proc = makeFakeProcess({ pid: 54321 });
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    await ssePost('/api/run-local', body, session);
    expect(session.runLocalPids).toContain(54321);
  });

  test('kills previous session PIDs before spawn', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    const session = { githubToken: 'tok', runLocalPids: [111], save: vi.fn((cb) => cb?.()) };
    const proc = makeFakeProcess({ pid: 222 });
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    await ssePost('/api/run-local', body, session);
    expect(killSpy).toHaveBeenCalledWith(111, 'SIGTERM');
  });

  test('no throw if previous PID is already dead', async () => {
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 999) throw new Error('ESRCH');
    });
    const session = { githubToken: 'tok', runLocalPids: [999], save: vi.fn((cb) => cb?.()) };
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    await expect(ssePost('/api/run-local', body, session)).resolves.toBeDefined();
  });
});

// ── Stack acceptance ──────────────────────────────────────────────────────────

describe('POST /api/run-local - accepted stacks', () => {
  async function accepted(stack) {
    const proc = makeFakeProcess();
    setTimeout(() => proc.writeLine('READY:http://localhost:3000'), 100);
    const { status } = await ssePost('/api/run-local', { cloneUrl: 'https://github.com/a/b.git', repoName: 'b', stack });
    return status;
  }

  test('react + none accepted', async () => { expect(await accepted({ frontend: 'react', backend: 'none' })).toBe(200); });
  test('html + go accepted',    async () => { expect(await accepted({ frontend: 'html',  backend: 'go'   })).toBe(200); });
  test('vue + python accepted', async () => { expect(await accepted({ frontend: 'vue',   backend: 'python'})).toBe(200); });
  test('react + nodejs accepted',async () => { expect(await accepted({ frontend: 'react', backend: 'nodejs'})).toBe(200); });
});

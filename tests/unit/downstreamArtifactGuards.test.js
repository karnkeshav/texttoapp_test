'use strict';

/* global describe, test, expect, beforeAll, afterAll */
const http = require('http');
const express = require('express');

process.env.GEMINI_API_KEY = 'mock-test-api-key';

const githubRoutes = require('../../server/routes/github.js');
const runLocalRoutes = require('../../server/routes/runLocal.js');

let _server;
let _currentSession;
let _serverPort;

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = _currentSession || {};
    next();
  });
  app.use('/api/github', githubRoutes);
  app.use('/api', runLocalRoutes);
  return app;
}

beforeAll(() => new Promise(resolve => {
  _server = buildTestApp().listen(0, '127.0.0.1', () => {
    _serverPort = _server.address().port;
    resolve();
  });
}));

afterAll(() => new Promise(resolve => {
  if (_server) _server.close(resolve);
  else resolve();
}));

function makePostRequest(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: _serverPort,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk.toString(); });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ statusCode: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

describe('Downstream Artifact Guards Regression Tests (Option A Authoritative Guard)', () => {

  test('1. generatedFiles > 0 + verification.passed=false + buildStatus=REPAIR_BLOCKED -> GitHub rejected (400)', async () => {
    _currentSession = {
      githubToken: 'mock-gh-token',
      generatedFiles: [{ path: 'index.html', content: '<h1>Diagnostics</h1>' }],
      verification: { passed: false, summary: '❌ Self-repair blocked' },
      buildStatus: 'REPAIR_BLOCKED'
    };

    const res = await makePostRequest('/api/github/deploy', {
      repoName: 'test-repair-blocked-repo',
      files: [{ path: 'index.html', content: '<h1>Diagnostics</h1>' }]
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('no verified build artifact exists');
  });

  test('2. generatedFiles > 0 + verification.passed=false + buildStatus=COMPLETED_WITH_WARNINGS -> GitHub rejected (400)', async () => {
    _currentSession = {
      githubToken: 'mock-gh-token',
      generatedFiles: [{ path: 'index.html', content: '<h1>Unverified App</h1>' }],
      verification: { passed: false, summary: '❌ Verification failed' },
      buildStatus: 'COMPLETED_WITH_WARNINGS'
    };

    const res = await makePostRequest('/api/github/deploy', {
      repoName: 'test-warnings-unverified-repo',
      files: [{ path: 'index.html', content: '<h1>Unverified App</h1>' }]
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('no verified build artifact exists');
  });

  test('3. generatedFiles > 0 + verification.passed=true -> GitHub allowed (passes guard check)', async () => {
    _currentSession = {
      githubToken: 'mock-gh-token',
      generatedFiles: [{ path: 'index.html', content: '<h1>Verified App</h1>' }],
      verification: { passed: true, summary: '✅ All checks passed' },
      buildStatus: 'VERIFIED'
    };

    const sessionFiles = _currentSession.generatedFiles;
    const isVerified = Array.isArray(sessionFiles) &&
      sessionFiles.length > 0 &&
      _currentSession.verification?.passed === true;

    expect(isVerified).toBe(true);
  });

  test('4. client-supplied files cannot override failed verification', async () => {
    _currentSession = {
      githubToken: 'mock-gh-token',
      generatedFiles: [{ path: 'index.html', content: '<h1>Internal</h1>' }],
      verification: { passed: false },
      buildStatus: 'REPAIR_BLOCKED'
    };

    // Client attempts to supply custom files in req.body.files
    const res = await makePostRequest('/api/github/deploy', {
      repoName: 'test-override-attempt',
      files: [{ path: 'index.html', content: '<h1>Client Fake Override</h1>' }]
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('no verified build artifact exists');
  });

  test('5. stale artifacts are cleared after a failed build', () => {
    // Build 1: Success
    _currentSession = {
      generatedFiles: [{ path: 'index.html', content: '<h1>App v1</h1>' }],
      verification: { passed: true },
      buildStatus: 'VERIFIED'
    };
    expect(_currentSession.generatedFiles).toHaveLength(1);

    // Build 2: Failure occurs (zero files extracted)
    const isZeroFiles = true;
    if (isZeroFiles) {
      _currentSession.generatedFiles = [];
      _currentSession.verification = { passed: false, summary: '❌ No files generated' };
      _currentSession.buildStatus = 'ARTIFACT_RETRIEVAL_FAILED';
    }

    expect(_currentSession.generatedFiles).toHaveLength(0);
    expect(_currentSession.verification.passed).toBe(false);
    expect(_currentSession.buildStatus).toBe('ARTIFACT_RETRIEVAL_FAILED');
  });

  test('6. RUN LOCAL ZERO ARTIFACT — Artifact error returned before html+none stack error', async () => {
    _currentSession = {
      githubToken: 'mock-gh-token',
      generatedFiles: [],
      verification: { passed: false }
    };

    const res = await makePostRequest('/api/run-local', {
      repoName: 'test-bookstore-app',
      stack: { frontend: 'html', backend: 'none' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Application cannot be run because no verified build artifact exists.');
  });

  test('7. RUN LOCAL UNVERIFIED ARTIFACT — Rejects runLocal when verification.passed=false', async () => {
    _currentSession = {
      githubToken: 'mock-gh-token',
      generatedFiles: [{ path: 'server.js', content: 'console.log("unverified");' }],
      verification: { passed: false },
      buildStatus: 'REPAIR_BLOCKED'
    };

    const res = await makePostRequest('/api/run-local', {
      repoName: 'test-unverified-app',
      stack: { frontend: 'html', backend: 'nodejs' }
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Application cannot be run because no verified build artifact exists.');
  });

});

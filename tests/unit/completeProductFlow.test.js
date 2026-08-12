'use strict';

/* global describe, test, expect, beforeAll, afterAll */
const http = require('http');
const express = require('express');

// Mock GEMINI_API_KEY before requiring chat route
process.env.GEMINI_API_KEY = 'mock-test-api-key';

const chatRoutes = require('../../server/routes/chat.js');

let _sseServer;
let _currentSession;
let _serverPort;

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = _currentSession;
    next();
  });
  app.use('/api', chatRoutes);
  return app;
}

beforeAll(() => new Promise(resolve => {
  _sseServer = buildTestApp().listen(0, '127.0.0.1', () => {
    _serverPort = _sseServer.address().port;
    resolve();
  });
}));

afterAll(() => new Promise(resolve => {
  if (_sseServer) _sseServer.close(resolve);
  else resolve();
}));

function postChatSSE(body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: _serverPort,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk.toString(); });
      res.on('end', () => {
        const events = raw.split('\n\n')
          .filter(block => block.trim().startsWith('data:'))
          .map(block => {
            try {
              return JSON.parse(block.replace(/^data:\s*/, '').trim());
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean);
        resolve({ statusCode: res.statusCode, events, raw });
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

describe('Complete Product Workflow Transition Regression Test', () => {
  test('Complete Product selection transitions directly to complete_questioning and returns Question 1 without stack_selection screen', async () => {
    _currentSession = {
      chatPhase: 'mode',
      chatHistory: [{ role: 'user', content: 'Build me an app' }],
      originalRequest: 'Build me an app'
    };

    const res = await postChatSSE({ message: 'Complete Product' });
    expect(res.statusCode).toBe(200);

    // 1. Session state assertions
    expect(_currentSession.buildMode).toBe('complete');
    expect(_currentSession.chatPhase).toBe('complete_questioning');
    expect(_currentSession.questionIndex).toBe(0);

    // 2. Event assertions
    const doneEvent = res.events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.text).toContain('Question 1 of 5');
    expect(doneEvent.showStackSelector).toBeUndefined();
  });

  test('Prototype selection transitions to prototype_style without stack selector', async () => {
    _currentSession = {
      chatPhase: 'mode',
      chatHistory: [{ role: 'user', content: 'Build me a simple app' }],
      originalRequest: 'Build me a simple app'
    };

    const res = await postChatSSE({ message: 'Prototype' });
    expect(res.statusCode).toBe(200);

    // 1. Session state assertions
    expect(_currentSession.buildMode).toBe('prototype');
    expect(_currentSession.chatPhase).toBe('prototype_style');

    // 2. Event assertions
    const doneEvent = res.events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.showStackSelector).toBeUndefined();
  });
});

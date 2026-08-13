'use strict';

/* global describe, test, expect, beforeAll, afterAll */
const http = require('http');
const express = require('express');

process.env.GEMINI_API_KEY = 'mock-test-api-key';

const chatRoutes = require('../../server/routes/chat.js');
const { generateDiscoveryPreview, generateContextualQuestion } = require('../../server/services/planPhase.js');

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

describe('Complete Product Semantic Discovery Workflow Tests', () => {

  test('TEST 1: Bookstore prompt shows discovery preview with estimates, acknowledges bookstore context, and asks contextual Q1', async () => {
    _currentSession = {
      chatPhase: 'mode',
      chatHistory: [{ role: 'user', content: 'Create an app for a bookstore.' }],
      originalRequest: 'Create an app for a bookstore.',
      planNotes: 'Domain: bookstore application'
    };

    const res = await postChatSSE({ message: 'Complete Product' });
    expect(res.statusCode).toBe(200);

    const doneEvent = res.events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();

    const text = doneEvent.text;

    // 1. Discovery Preview assertions
    expect(text.toLowerCase()).toContain('bookstore');
    expect(text).toMatch(/5 (focused )?questions/i);
    expect(text).toMatch(/estimated discovery time/i);
    expect(text).toMatch(/estimated build time/i);
    expect(text).toContain('5–8 minutes');
    expect(text).toContain('5–15 minutes');

    // 2. Contextual Q1 assertions
    expect(text).toContain('Question 1 of 5');
    expect(text.toLowerCase()).not.toContain('what are you building?');
    expect(doneEvent.showStackSelector).toBeUndefined();
  });

  test('TEST 2: Answer acknowledging availability context moves to next area without asking user to repeat core goal', async () => {
    _currentSession = {
      chatPhase: 'complete_questioning',
      questionIndex: 0,
      gatheredAnswers: [],
      chatHistory: [],
      originalRequest: 'Create an app for a bookstore.',
      planNotes: 'Domain: bookstore application'
    };

    const res = await postChatSSE({ message: 'They should know the books available in the store.' });
    expect(res.statusCode).toBe(200);

    const doneEvent = res.events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();

    expect(_currentSession.gatheredAnswers.length).toBe(1);
    expect(_currentSession.questionIndex).toBe(1);
    expect(doneEvent.text).toContain('Question 2 of 5');
    expect(doneEvent.text.toLowerCase()).not.toContain('what are you building?');
  });

  test('TEST 3: Rich initial prompt recognizes facts and avoids redundant questions', async () => {
    const richPrompt = 'I want a bookstore app where customers search books by author and title, see stock availability, and staff update inventory.';
    _currentSession = {
      chatPhase: 'mode',
      chatHistory: [{ role: 'user', content: richPrompt }],
      originalRequest: richPrompt,
      planNotes: 'Domain: bookstore app with customer search (author/title), stock availability, and staff inventory updates'
    };

    const res = await postChatSSE({ message: 'Complete Product' });
    expect(res.statusCode).toBe(200);

    const doneEvent = res.events.find(e => e.type === 'done');
    expect(doneEvent.text.toLowerCase()).toContain('bookstore');
    expect(doneEvent.text.toLowerCase()).not.toContain('what is your app name');
  });

  test('TEST 4: Adaptive follow-up logic generates targeted question', async () => {
    const q = await generateContextualQuestion({
      originalRequest: 'Create an app for a bookstore.',
      planNotes: 'Domain: bookstore application',
      gatheredAnswers: [{ q: 'Question 1', a: 'Browse books' }],
      areaIndex: 1,
      isFollowUp: true,
      apiKey: 'mock-test-api-key'
    });

    expect(q).toContain('Follow-up');
    expect(q.toLowerCase()).toContain('users');
  });

  test('TEST 5: "I don\'t know" is accepted as a valid answer and discovery continues', async () => {
    _currentSession = {
      chatPhase: 'complete_questioning',
      questionIndex: 1,
      gatheredAnswers: [{ q: 'Q1', a: 'Browse books' }],
      chatHistory: [],
      originalRequest: 'Create an app for a bookstore.',
      planNotes: 'Domain: bookstore application'
    };

    const res = await postChatSSE({ message: "I don't know" });
    expect(res.statusCode).toBe(200);

    expect(_currentSession.gatheredAnswers.length).toBe(2);
    expect(_currentSession.gatheredAnswers[1].a.toLowerCase()).toContain("i don't know");
    expect(_currentSession.questionIndex).toBe(2);
  });

  test('TEST 6: Prototype behavior remains 100% unchanged', async () => {
    _currentSession = {
      chatPhase: 'mode',
      chatHistory: [{ role: 'user', content: 'Build me a simple app' }],
      originalRequest: 'Build me a simple app'
    };

    const res = await postChatSSE({ message: 'Prototype' });
    expect(res.statusCode).toBe(200);

    expect(_currentSession.buildMode).toBe('prototype');
    expect(_currentSession.chatPhase).toBe('prototype_style');

    const doneEvent = res.events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent.showStackSelector).toBeUndefined();
  });

  test('TEST 7: Complete questioning after Q5 triggers spec compilation and transitions to building phase', async () => {
    _currentSession = {
      chatPhase: 'complete_questioning',
      questionIndex: 4,
      gatheredAnswers: [
        { q: 'Q1', a: 'Browse books' },
        { q: 'Q2', a: 'General public' },
        { q: 'Q3', a: 'Save favorites' },
        { q: 'Q4', a: 'Search and CSV export' }
      ],
      chatHistory: [],
      originalRequest: 'Create an app for a bookstore.',
      planNotes: 'Domain: bookstore application'
    };

    const res = await postChatSSE({ message: 'Dark mode minimal design' });
    expect(res.statusCode).toBe(200);

    expect(_currentSession.gatheredAnswers.length).toBe(5);
    expect(_currentSession.chatPhase).toBe('building');
    expect(_currentSession.compiledSpec).toBeDefined();
  });

  test('TEST 8: Question 5 explicitly asks contextual UI/UX & Experience questions', async () => {
    const q5 = await generateContextualQuestion({
      originalRequest: 'Create an app for a bookstore.',
      planNotes: 'Domain: bookstore application',
      gatheredAnswers: [
        { q: 'Q1', a: 'Browse books' },
        { q: 'Q2', a: 'Customers & staff' },
        { q: 'Q3', a: 'Book inventory' },
        { q: 'Q4', a: 'Search & filter' }
      ],
      areaIndex: 4,
      apiKey: 'mock-test-api-key'
    });

    expect(q5).toContain('Question 5 of 5');
    expect(q5.toLowerCase()).toMatch(/experience|ui\/ux|design|look and feel/);
  });

  test('TEST 9: UI/UX choices from Q5 are recorded in gatheredAnswers and compiledSpec', async () => {
    _currentSession = {
      chatPhase: 'complete_questioning',
      questionIndex: 4,
      gatheredAnswers: [
        { q: 'Q1', a: 'Browse books' },
        { q: 'Q2', a: 'Customers & staff' },
        { q: 'Q3', a: 'Book inventory' },
        { q: 'Q4', a: 'Search & filter' }
      ],
      chatHistory: [],
      originalRequest: 'Create an app for a bookstore.',
      planNotes: 'Domain: bookstore application'
    };

    const uiuxAnswer = 'I want a clean modern bookstore catalogue with a dark theme, large covers, and mobile-friendly bottom navigation.';
    const res = await postChatSSE({ message: uiuxAnswer });
    expect(res.statusCode).toBe(200);

    expect(_currentSession.gatheredAnswers.length).toBe(5);
    expect(_currentSession.gatheredAnswers[4].a).toBe(uiuxAnswer);
    expect(_currentSession.compiledSpec).toBeDefined();
  });

});

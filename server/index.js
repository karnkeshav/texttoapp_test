require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes   = require('./routes/auth');
const chatRoutes   = require('./routes/chat');
const githubRoutes = require('./routes/github');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API / Auth Routes ─────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/api', chatRoutes);
app.use('/api/github', githubRoutes);

// ── Telemetry receiver — in-memory deduplication cache ───────────
// Prevents identical runtime errors from being processed multiple times.
// State resets on Render container restart — intentionally stateless.
const activeErrorCache = new Map();

app.post('/api/telemetry/report', (req, res) => {
  const { appPath, errorMsg, source, line } = req.body || {};
  if (!errorMsg) return res.status(204).end();

  const signature = `${appPath}:${errorMsg}:${line}`;

  if (activeErrorCache.has(signature)) {
    // Exact same error already logged — discard to protect quota
    return res.json({ status: 'ignored_duplicate' });
  }

  // Cap cache size to protect server memory on free-tier containers
  if (activeErrorCache.size >= 500) activeErrorCache.clear();
  activeErrorCache.set(signature, Date.now());

  console.warn('[Telemetry]', { appPath, errorMsg, source, line });
  res.json({ status: 'logged' });
});

// ── Diagnostic endpoint ───────────────────────────────────────────
// Reflects the actual stack: API-key auth, Antigravity primary + Gemini fallback.
app.get('/api/diagnose', async (req, res) => {
  const { GoogleGenAI } = require('@google/genai');
  const apiKey = process.env.GEMINI_API_KEY;

  const result = {
    github_logged_in:       !!req.session.githubToken,
    github_user:            req.session.user?.login || null,
    gemini_api_configured:  !!apiKey,
    gemini_model:           process.env.GEMINI_MODEL  || 'gemini-2.5-flash',
    plan_model:             process.env.PLAN_MODEL    || 'gemini-2.5-flash',
    antigravity_agent:      process.env.ANTIGRAVITY_AGENT_ID || null,
    backend_origin:         process.env.BACKEND_ORIGIN || null,
    gemini_live_test:       null,
    antigravity_live_test:  null,
  };

  if (apiKey) {
    // ── Gemini SDK live ping ──────────────────────────────────────
    try {
      const ai  = new GoogleGenAI({ apiKey });
      const res = await ai.models.generateContent({
        model: result.gemini_model,
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
        config: {
          maxOutputTokens: 10,
          thinkingConfig: { thinkingBudget: 0 }, // disable thinking — required for .text on 2.5+ models
        },
      });
      const resText = res.text ?? res.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      result.gemini_live_test = { ok: true, response: resText.trim().slice(0, 40) };
    } catch (err) {
      result.gemini_live_test = { ok: false, error: err.message };
    }

    // ── Antigravity API ping (key-auth, non-streaming) ────────────
    try {
      const axios    = require('axios');
      const agentId  = process.env.ANTIGRAVITY_AGENT_ID || 'antigravity-preview-05-2026';
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`;
      const r = await axios.post(
        endpoint,
        { agent: agentId, input: 'Reply with the single word OK.', environment: { type: 'remote_sandbox' }, stream: false },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20_000 }
      );
      result.antigravity_live_test = { ok: true, status: r.status, data: JSON.stringify(r.data).slice(0, 120) };
    } catch (err) {
      result.antigravity_live_test = { ok: false, status: err.response?.status, error: err.response?.data || err.message };
    }
  }

  res.json(result);
});

// ── Page routes ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  if (!req.session.githubToken) return res.redirect('/?error=not_authenticated');
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 AppBuilder running at http://localhost:${PORT}\n`);
});

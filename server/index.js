require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
// AUTH DISABLED — uncomment to re-enable Firestore session persistence
// const { FirestoreSessionStore } = require('./services/firestoreSessionStore');

const authRoutes    = require('./routes/auth');
const chatRoutes    = require('./routes/chat');
const githubRoutes  = require('./routes/github');
const convertRoutes = require('./routes/convert');
const userRoutes    = require('./routes/user');
const supportRoutes = require('./routes/support');
const quotaRoutes   = require('./routes/quota');
const androidRoutes   = require('./routes/android');
const runLocalRoutes  = require('./routes/runLocal');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Trust Render's HTTPS proxy ────────────────────────────────────
// Render terminates SSL at the proxy layer and forwards as HTTP internally.
// Without this, Express thinks requests are HTTP → secure cookies are never
// sent → sessions vanish after the GitHub OAuth redirect.
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    // AUTH DISABLED — Firestore session store commented out; using default MemoryStore
    // store: new FirestoreSessionStore(),
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',                   // allows cookie to survive the GitHub → Render redirect
      maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days
    },
  })
);

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API / Auth Routes ─────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/api', chatRoutes);
app.use('/api', convertRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/user', userRoutes);
app.use('/api/support', supportRoutes);
app.use('/api', quotaRoutes);
app.use('/api', androidRoutes);
app.use('/api', runLocalRoutes);

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
// Reflects the actual stack: API-key auth, Antigravity primary + Gemini pool fallback.
app.get('/api/diagnose', async (req, res) => {
  const { pooledGenerate, poolStatus } = require('./services/geminiPool');
  const apiKey = process.env.GEMINI_API_KEY;

  const result = {
    github_logged_in:       !!req.session.githubToken,
    github_user:            req.session.user?.login || null,
    gemini_api_configured:  !!apiKey,
    antigravity_agent:      process.env.ANTIGRAVITY_AGENT_ID || null,
    backend_origin:         process.env.BACKEND_ORIGIN || null,
    gemini_pool:            poolStatus(),
    groq_pool:       process.env.GROQ_API_KEY      ? require('./services/groqPool').groqPoolStatus()           : 'not configured',
    cerebras_pool:   process.env.CEREBRAS_API_KEY  ? require('./services/cerebrasPool').cerebrasPoolStatus()   : 'not configured',
    sambanova_pool:  process.env.SAMBANOVA_API_KEY ? require('./services/sambanovaPool').sambanovaPoolStatus()  : 'not configured',
    gemini_live_test:       null,
    antigravity_live_test:  null,
  };

  if (apiKey) {
    // ── Gemini pool live ping ─────────────────────────────────────
    try {
      const text = await pooledGenerate({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
        config:   { maxOutputTokens: 10 },
        apiKey,
      });
      result.gemini_live_test = { ok: true, response: text.trim().slice(0, 40) };
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

// AUTH DISABLED — /app is open to all (no session required)
// Original auth guard commented out:
// app.get('/app', (req, res) => {
//   const authed =
//     !!req.session?.googleUser?.uid ||
//     !!(req.session?.githubToken && req.session?.user?.login);
//   if (!authed) return res.redirect('/');
//   res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
// });
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// /profile — member area (served as static HTML; JS fetches /api/user/profile)
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'profile.html'));
});

// /support — help & ticket submission page
app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'support.html'));
});

// /github-guide — step-by-step guide to connecting GitHub
app.get('/github-guide', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'github-guide.html'));
});

// ── Debug session endpoint (test protocol only) ───────────────────
app.get('/api/debug/session', (req, res) => {
  res.json({
    chatPhase:        req.session.chatPhase        || null,
    buildMode:        req.session.buildMode        || null,
    editMode:         req.session.editMode         || null,
    selectedStack:    req.session.selectedStack    || null,
    detectedStack:    req.session.detectedStack    || null,
    originalEditRepo: req.session.originalEditRepo || null,
    historyLength:    req.session.chatHistory?.length ?? 0,
  });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Ready4Launch running at http://localhost:${PORT}\n`);
});

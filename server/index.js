require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes       = require('./routes/auth');
const googleAuthRoutes = require('./routes/googleAuth');
const chatRoutes       = require('./routes/chat');
const githubRoutes     = require('./routes/github');

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
app.use('/auth', googleAuthRoutes);
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

// ── Diagnostic endpoint (dev only) ───────────────────────────────
app.get('/api/diagnose', async (req, res) => {
  const { OAuth2Client } = require('google-auth-library');
  const axios = require('axios');

  const result = {
    github_logged_in:  !!req.session.githubToken,
    google_connected:  !!req.session.googleTokens,
    google_token_keys: req.session.googleTokens ? Object.keys(req.session.googleTokens) : [],
    granted_scope: req.session.googleTokens?.scope || null,
    antigravity_endpoint: process.env.ANTIGRAVITY_API_ENDPOINT,
    agent_id: process.env.ANTIGRAVITY_AGENT_ID,
    access_token_test: null,
    api_test: null,
  };

  if (req.session.googleTokens) {
    try {
      const client = new OAuth2Client(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_CALLBACK_URL
      );
      client.setCredentials(req.session.googleTokens);
      const { token } = await client.getAccessToken();
      result.access_token_test = token ? `OK (starts: ${token.slice(0,10)}...)` : 'NULL';

      // Test the actual Antigravity API
      try {
        const r = await axios.post(
          process.env.ANTIGRAVITY_API_ENDPOINT,
          { agent: process.env.ANTIGRAVITY_AGENT_ID, input: 'Say hi.', environment: { type: 'remote_sandbox' }, stream: false },
          { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
        );
        result.api_test = { status: r.status, data: JSON.stringify(r.data).slice(0, 300) };
      } catch (apiErr) {
        result.api_test = { status: apiErr.response?.status, error: apiErr.response?.data || apiErr.message };
      }
    } catch (tokenErr) {
      result.access_token_test = `ERROR: ${tokenErr.message}`;
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

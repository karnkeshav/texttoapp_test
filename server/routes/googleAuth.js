/**
 * Google OAuth2 — gives us the Bearer token Antigravity needs.
 * Stores access + refresh tokens in the session; auto-refreshes on expiry.
 */
const express = require('express');
const { OAuth2Client } = require('google-auth-library');

const router = express.Router();

function makeClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
  );
}

// ── Step 1: redirect to Google ────────────────────────────────────
router.get('/google', (req, res) => {
  const client = makeClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',   // gets a refresh token so we never expire
    prompt: 'consent',        // forces refresh token on every login
    scope: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/generative-language.peruserquota',
      'email',
      'profile',
    ],
  });
  res.redirect(url);
});

// ── Step 2: Google redirects back here ───────────────────────────
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/app?error=google_denied');

  try {
    const client = makeClient();
    const { tokens } = await client.getToken(code);
    // Store both tokens — access token for now, refresh token forever
    req.session.googleTokens = tokens;
    res.redirect('/app');
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.redirect('/app?error=google_oauth_failed');
  }
});

// ── Status check ─────────────────────────────────────────────────
router.get('/google/status', (req, res) => {
  res.json({ connected: !!req.session.googleTokens });
});

// ── Disconnect ───────────────────────────────────────────────────
router.get('/google/disconnect', (req, res) => {
  delete req.session.googleTokens;
  res.redirect('/app');
});

module.exports = router;

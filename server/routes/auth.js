'use strict';
const express = require('express');
const axios   = require('axios');
const { getUser } = require('../services/githubService');
// AUTH DISABLED — Firestore calls commented out
// const { upsertUser, linkGitHub } = require('../services/firestoreService');

const router = express.Router();

// ── Helper ────────────────────────────────────────────────────────
function isAuthenticated(req) {
  return !!(req.session.googleUser || req.session.githubToken);
}

// AUTH DISABLED — Google OAuth commented out for future re-enable
// ══════════════════════════════════════════════════════════════════
// GOOGLE OAUTH  (primary — creates the secure workspace)
// ══════════════════════════════════════════════════════════════════

// router.get('/google', (req, res) => {
//   const params = new URLSearchParams({
//     client_id:    process.env.GOOGLE_CLIENT_ID,
//     redirect_uri: process.env.GOOGLE_CALLBACK_URL,
//     response_type: 'code',
//     scope:        'openid email profile',
//     access_type:  'online',
//     state:        Math.random().toString(36).slice(2),
//     prompt:       'select_account',
//   });
//   res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
// });

// router.get('/google/callback', async (req, res) => {
//   const { code, error } = req.query;
//   if (error || !code) return res.redirect('/?error=google_cancelled');
//
//   try {
//     const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
//       client_id:     process.env.GOOGLE_CLIENT_ID,
//       client_secret: process.env.GOOGLE_CLIENT_SECRET,
//       code,
//       redirect_uri:  process.env.GOOGLE_CALLBACK_URL,
//       grant_type:    'authorization_code',
//     });
//
//     const { access_token } = tokenRes.data;
//     if (!access_token) return res.redirect('/?error=google_token_failed');
//
//     const profileRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
//       headers: { Authorization: `Bearer ${access_token}` },
//     });
//     const { sub: uid, email, name, picture } = profileRes.data;
//
//     if (!uid || !email) return res.redirect('/?error=google_profile_failed');
//
//     // Persist to Firestore (non-blocking)
//     upsertUser({ uid, email, name, picture, provider: 'google' }).catch(() => {});
//
//     req.session.googleUser = { uid, email, name, picture };
//     req.session.user = {
//       login:    email,
//       name:     name || email,
//       avatarUrl: picture || null,
//       provider: 'google',
//       uid,
//     };
//
//     console.log(`[Auth] Google login: ${email}`);
//     res.redirect('/app');
//   } catch (err) {
//     console.error('[Auth] Google callback error:', err.message);
//     res.redirect('/?error=google_oauth_error');
//   }
// });

// ══════════════════════════════════════════════════════════════════
// GITHUB OAUTH  (needed for Deploy to GitHub Pages)
// ══════════════════════════════════════════════════════════════════

router.get('/github', (req, res) => {
  const params = new URLSearchParams({
    client_id:    process.env.GITHUB_CLIENT_ID,
    redirect_uri: process.env.GITHUB_CALLBACK_URL,
    scope:        'repo user',
    state:        Math.random().toString(36).slice(2),
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

router.get('/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id:     process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri:  process.env.GITHUB_CALLBACK_URL,
      },
      { headers: { Accept: 'application/json' } }
    );

    const { access_token, error } = tokenRes.data;
    if (error || !access_token) return res.redirect('/?error=oauth_failed');

    req.session.githubToken = access_token;
    const githubUser = await getUser(access_token);
    req.session.githubUser = githubUser;

    req.session.user = {
      login:    githubUser.login,
      name:     githubUser.name || githubUser.login,
      avatarUrl: githubUser.avatarUrl || null,
      provider: 'github',
    };
    // FIREBASE DISABLED — Firestore persistence skipped
    // upsertUser({ uid: `gh_${githubUser.login}`, ... }).catch(() => {});
    // linkGitHub(...).catch(() => {});

    console.log(`[Auth] GitHub connected: ${githubUser.login}`);
    res.redirect('/app');
  } catch (err) {
    console.error('[Auth] GitHub callback error:', err.message);
    res.redirect('/?error=oauth_error');
  }
});

// ══════════════════════════════════════════════════════════════════
// SHARED
// ══════════════════════════════════════════════════════════════════

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// GOOGLE AUTH DISABLED — app is open to all; GitHub auth is live for deployment
// Original check commented out:
// router.get('/status', (req, res) => {
//   if (!isAuthenticated(req)) {
//     return res.json({ authenticated: false });
//   }
//   res.json({
//     authenticated: true,
//     user:      req.session.user,
//     hasGoogle: !!req.session.googleUser,
//     hasGitHub: !!req.session.githubToken,
//   });
// });
router.get('/status', (req, res) => {
  res.json({
    authenticated: true,
    user:      req.session.user || { login: 'guest', name: 'Guest', avatarUrl: null, provider: 'guest' },
    hasGoogle: false,
    hasGitHub: !!req.session.githubToken,
  });
});

// ── Test-only bypass ──────────────────────────────────────────────
if (process.env.NODE_ENV === 'test') {
  router.get('/test-login', (req, res) => {
    req.session.githubToken = 'test-token';
    req.session.user = { login: 'testuser', name: 'Test User', avatarUrl: null, provider: 'github' };
    res.json({ ok: true, user: 'testuser' });
  });
}

module.exports = router;

const express = require('express');
const axios = require('axios');
const { getUser } = require('../services/githubService');

const router = express.Router();

// Step 1 — redirect to GitHub
router.get('/github', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: process.env.GITHUB_CALLBACK_URL,
    scope: 'repo user',
    state: Math.random().toString(36).slice(2),
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// Step 2 — GitHub redirects back here
router.get('/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: process.env.GITHUB_CALLBACK_URL,
      },
      { headers: { Accept: 'application/json' } }
    );

    const { access_token, error } = tokenRes.data;
    if (error || !access_token) return res.redirect('/?error=oauth_failed');

    req.session.githubToken = access_token;
    const user = await getUser(access_token);
    req.session.user = user;

    res.redirect('/app');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=oauth_error');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/status', (req, res) => {
  if (req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

module.exports = router;

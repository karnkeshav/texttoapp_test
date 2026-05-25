const express = require('express');
const { listRepos, pushFiles, enablePages } = require('../services/githubService');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

router.get('/repos', requireAuth, async (req, res) => {
  try {
    const repos = await listRepos(req.session.githubToken);
    res.json(repos);
  } catch (err) {
    console.error('List repos error:', err.message);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

router.post('/push', requireAuth, async (req, res) => {
  const { owner, repo, files } = req.body;
  if (!owner || !repo || !files?.length) {
    return res.status(400).json({ error: 'owner, repo, and files are required' });
  }

  try {
    const repoUrl = await pushFiles(req.session.githubToken, owner, repo, files);
    const pagesUrl = await enablePages(req.session.githubToken, owner, repo);
    res.json({ success: true, repoUrl, pagesUrl });
  } catch (err) {
    console.error('Push error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

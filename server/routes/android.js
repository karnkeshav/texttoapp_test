'use strict';
const express = require('express');
const fs      = require('fs');
const { buildAndroidProject } = require('../services/androidBuilder');

const router = express.Router();

// In-memory store of completed builds: buildId → { type, filePath, fileName }
const builds = new Map();

// ── POST /api/android/build ───────────────────────────────────────
// Body: { repoName, appName, pagesUrl }
// Generates Android WebView project and returns download URL.
router.post('/android/build', async (req, res) => {
  const { repoName, appName, pagesUrl } = req.body || {};
  if (!repoName || !pagesUrl) {
    return res.status(400).json({ error: 'repoName and pagesUrl are required' });
  }

  console.log(`[Android] Building project for ${repoName} → ${pagesUrl}`);

  try {
    const result  = await buildAndroidProject(repoName, appName || repoName, pagesUrl);
    const buildId = `${repoName}-${Date.now()}`;
    builds.set(buildId, result);

    // Clean up after 1 hour
    setTimeout(() => builds.delete(buildId), 60 * 60 * 1000);

    res.json({
      success:     true,
      buildId,
      type:        result.type,          // 'apk' | 'zip'
      fileName:    result.fileName,
      downloadUrl: `/api/android/download/${buildId}`,
    });
  } catch (err) {
    console.error('[Android] Build error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/android/download/:buildId ───────────────────────────
router.get('/android/download/:buildId', (req, res) => {
  const build = builds.get(req.params.buildId);
  if (!build || !fs.existsSync(build.filePath)) {
    return res.status(404).json({ error: 'Build not found or expired' });
  }

  const mime = build.type === 'apk'
    ? 'application/vnd.android.package-archive'
    : 'application/zip';

  res.setHeader('Content-Disposition', `attachment; filename="${build.fileName}"`);
  res.setHeader('Content-Type', mime);
  res.sendFile(build.filePath);
});

module.exports = router;

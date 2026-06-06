const express = require('express');
const { listRepos, createRepo, pushFiles, enablePages } = require('../services/githubService');
const { auditAndHeal } = require('../services/codeQuality');
const { needsLocalRunner, isBackendApp } = require('../services/appRunner');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

const CDN_PINS = [
  [/https?:\/\/cdn\.tailwindcss\.com(?!\/[\d])[^\s"']*/g, 'https://cdn.tailwindcss.com/3.4.0/tailwind.min.css'],
  [/https?:\/\/unpkg\.com\/lucide@latest[^\s"']*/g, 'https://unpkg.com/lucide@0.378.0/dist/umd/lucide.min.js'],
];

function pinCDNVersions(html) {
  let result = html;
  for (const [pattern, pinned] of CDN_PINS) {
    result = result.replace(pattern, pinned);
  }
  return result;
}

function injectTelemetry(html, backendOrigin) {
  if (!backendOrigin) return html;
  const snippet = `<script>
    window.onerror = function(msg, src, line, col, err) {
      try {
        fetch('${backendOrigin}/api/telemetry/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appPath: window.location.pathname, errorMsg: msg, source: src, line: line, stackTrace: err ? err.stack : '' })
        });
      } catch (_) {}
      return true;
    };
  </script>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', snippet + '\n</head>');
  }
  return snippet + '\n' + html;
}

function processFiles(files, backendOrigin) {
  return files.map((file) => {
    if (!file.path.endsWith('.html')) return file;
    let content = pinCDNVersions(file.content);
    content = injectTelemetry(content, backendOrigin);
    return { ...file, content };
  });
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

router.post('/deploy', requireAuth, async (req, res) => {
  const { repoName, files, description, stack } = req.body;
  if (!repoName || !files?.length) {
    return res.status(400).json({ error: 'repoName and files are required' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

    // Audit HTML files
    const auditedFiles = await Promise.all(files.map(async (file) => {
      if (!file.path.endsWith('.html')) return file;
      try {
        const { code, healed, attempts } = await auditAndHeal(file.content, apiKey, model);
        if (healed) console.log(`[CodeAudit] Healed ${file.path} in ${attempts} attempt(s)`);
        return { ...file, content: code };
      } catch (auditErr) {
        if (auditErr.code === 'CODE_AUDIT_FAILED') {
          console.warn(`[CodeAudit] ${file.path} — proceeding with original`);
          return file;
        }
        throw auditErr;
      }
    }));

    // Create repo
    const { name, owner } = await createRepo(req.session.githubToken, repoName, description);

    // Process files
    const processed = processFiles(auditedFiles, process.env.BACKEND_ORIGIN);

    // Push to GitHub
    const repoUrl = await pushFiles(
      req.session.githubToken, owner, name, processed,
      'Initial app — built with Ready4Launch'
    );

    // Determine if this is a backend app
    const sessionStack = stack || req.session.selectedStack || req.session.detectedStack;
    const isBackend = isBackendApp(auditedFiles) ||
                      (sessionStack?.backend && sessionStack.backend !== 'none');

    let pagesUrl = null;
    if (!isBackend) {
      pagesUrl = await enablePages(req.session.githubToken, owner, name);
    }

    // IMPORTANT: Do NOT call runApp() here — files are in-memory, not in GitHub repo yet
    // /api/run-local will clone the GitHub repo and run start.ps1

    const cloneUrl = repoUrl.replace(/\.git$/, '.git');

    res.json({
      success: true,
      repoUrl,
      cloneUrl,
      pagesUrl,
      isBackend,
      stack: sessionStack,
      repoName: name,
      owner: owner
    });
  } catch (err) {
    if (!res.headersSent) {
      console.error('Deploy error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;

const express = require('express');
const { listRepos, createRepo, pushFiles, enablePages, getFileContent } = require('../services/githubService');
const { auditAndHeal } = require('../services/codeQuality');
const { runApp, needsLocalRunner, isBackendApp, getRunInfo } = require('../services/appRunner');
const { getRunCommand } = require('../services/stackAdvisor');
const { generateStartScript } = require('../services/startScriptGenerator');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── CDN version pinning ───────────────────────────────────────────
// Replaces any unversioned or versionless CDN URLs with pinned stable versions
// so generated apps don't break when CDN defaults change.
const CDN_PINS = [
  // Tailwind (any cdn.tailwindcss.com without pinned version)
  [/https?:\/\/cdn\.tailwindcss\.com(?!\/[\d])[^\s"']*/g,
   'https://cdn.tailwindcss.com/3.4.0/tailwind.min.css'],

  // Tailwind Play CDN script (latest) → pinned
  [/https?:\/\/cdn\.tailwindcss\.com\/[\d.]+\/tailwind\.min\.css/g,
   'https://cdn.tailwindcss.com/3.4.0/tailwind.min.css'],

  // Lucide icons (unpinned)
  [/https?:\/\/unpkg\.com\/lucide@latest[^\s"']*/g,
   'https://unpkg.com/lucide@0.378.0/dist/umd/lucide.min.js'],

  // Alpine.js (unpinned)
  [/https?:\/\/unpkg\.com\/alpinejs@[\d.x]*[^\s"']*/g,
   'https://unpkg.com/alpinejs@3.13.10/dist/cdn.min.js'],

  // Animate.css (unpinned)
  [/https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/animate\.css\/[\d.]+\/animate\.min\.css/g,
   'https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css'],
];

function pinCDNVersions(html) {
  let result = html;
  for (const [pattern, pinned] of CDN_PINS) {
    result = result.replace(pattern, pinned);
  }
  return result;
}

// ── Runtime telemetry injection ───────────────────────────────────
// Injects a silent window.onerror handler into every deployed HTML file.
// Errors are posted to /api/telemetry/report on the Ready4Launch backend.
// Skipped entirely when BACKEND_ORIGIN is not configured (avoids injecting
// a broken URL into user-facing apps).
function injectTelemetry(html, backendOrigin) {
  if (!backendOrigin) return html; // no origin configured — skip injection

  const snippet = `
  <!-- Ready4Launch runtime monitor -->
  <script>
    window.onerror = function(msg, src, line, col, err) {
      try {
        fetch('${backendOrigin}/api/telemetry/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appPath: window.location.pathname,
            errorMsg: msg,
            source: src,
            line: line,
            stackTrace: err ? err.stack : ''
          })
        });
      } catch (_) {}
      return true; // suppress visual error overlay
    };
  </script>`;

  // Insert just before </head> — falls back to prepending if no </head> found
  if (html.includes('</head>')) {
    return html.replace('</head>', snippet + '\n</head>');
  }
  return snippet + '\n' + html;
}

// ── Apply all pre-deploy transformations to file list ─────────────
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

// Fetch a single file from a repo (used by edit mode to load current code)
router.get('/repo-content', requireAuth, async (req, res) => {
  const { owner, repo, path = 'index.html' } = req.query;
  if (!owner || !repo) return res.status(400).json({ error: 'owner and repo are required' });
  try {
    const content = await getFileContent(req.session.githubToken, owner, repo, path);
    if (content === null) return res.status(404).json({ error: `${path} not found in ${owner}/${repo}` });
    res.json({ content });
  } catch (err) {
    console.error('Repo content error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/push', requireAuth, async (req, res) => {
  const { owner, repo, files, branch = 'main' } = req.body;
  if (!owner || !repo || !files?.length) {
    return res.status(400).json({ error: 'owner, repo, and files are required' });
  }

  try {
    const processed = processFiles(files, process.env.BACKEND_ORIGIN);
    const repoUrl   = await pushFiles(req.session.githubToken, owner, repo, processed, 'Update app via Ready4Launch', branch);
    const pagesUrl  = await enablePages(req.session.githubToken, owner, repo, branch);
    res.json({ success: true, repoUrl, pagesUrl });
  } catch (err) {
    console.error('Push error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create new repo → process files → push → enable Pages — all in one shot
router.post('/deploy', requireAuth, async (req, res) => {
  const { repoName, files, description, stack } = req.body;
  if (!repoName || !files?.length) {
    return res.status(400).json({ error: 'repoName and files are required' });
  }

  try {
    const apiKey  = process.env.GEMINI_API_KEY;
    const model   = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

    // 1. Run mechanical audit + auto-heal loop on HTML files before touching GitHub
    // Use a flag instead of returning from inside Promise.all — returning from an async
    // callback only exits the callback, not the route handler, so headers would be sent
    // twice if we called res.json() inside the map.
    const auditedFiles = await Promise.all(files.map(async (file) => {
      if (!file.path.endsWith('.html')) return file;
      try {
        const { code, healed, attempts } = await auditAndHeal(file.content, apiKey, model);
        if (healed) console.log(`[CodeAudit] Healed ${file.path} in ${attempts} attempt(s)`);
        return { ...file, content: code };
      } catch (auditErr) {
        if (auditErr.code === 'CODE_AUDIT_FAILED') {
          // Non-fatal: the mechanical audit found issues it couldn't fully repair,
          // but the AI already ran a semantic quality pass during generation.
          // Deploy the original file rather than blocking the user entirely.
          console.warn(
            `[CodeAudit] ${file.path} — proceeding with original after failed repair:`,
            auditErr.issues?.slice(0, 3).join(' | ')
          );
          return file;
        }
        throw auditErr;
      }
    }));

    // 1.5. Generate and inject start.ps1 for full-stack apps
    let filesToDeploy = auditedFiles;
    // Use stack from request body (passed from frontend), fall back to session stack
    const deployStack = stack || req.session.selectedStack || req.session.detectedStack || null;
    if (deployStack?.backend && deployStack.backend !== 'none' && deployStack.frontend && deployStack.frontend !== 'html') {
      const startScript = generateStartScript(deployStack);
      if (startScript) {
        filesToDeploy = [...auditedFiles, { path: 'start.ps1', content: startScript }];
        console.log(`[Deploy] Generated start.ps1 for ${deployStack.frontend}+${deployStack.backend} stack`);
      }
    }

    // 2. Create the public repo (auto-renames if name is taken)
    const { name, owner } = await createRepo(req.session.githubToken, repoName, description);

    // 3. Apply CDN pinning + telemetry injection before committing
    const processed = processFiles(filesToDeploy, process.env.BACKEND_ORIGIN);

    // 4. Atomic push — all files in one commit (prevents partial deploy state)
    const repoUrl = await pushFiles(
      req.session.githubToken, owner, name, processed,
      'Initial app — built with Ready4Launch'
    );

    // 5. Determine backend status from BOTH file content AND session stack.
    //    The AI often generates only HTML+CDN for a React+Go app, so file detection
    //    alone can miss the backend — session.selectedStack is the authoritative source.
    const sessionStack = req.session.selectedStack || req.session.detectedStack || null;
    const BACKEND_TYPES = ['nodejs', 'go', 'python', 'ruby', 'php', 'rust'];
    const stackHasBackend = sessionStack?.backend &&
      BACKEND_TYPES.includes(sessionStack.backend);
    const isBackend = isBackendApp(auditedFiles) || !!stackHasBackend;

    // Enable GitHub Pages ONLY for purely static apps (no backend server)
    let pagesUrl = null;
    if (!isBackend) {
      pagesUrl = await enablePages(req.session.githubToken, owner, name);
    }

    // 6. For ANY backend app — resolve run command and attempt auto-launch
    let localUrl   = null;
    let runCommand = null;
    if (isBackend) {
      // File-based detection first; fall back to stack-based run command
      const runInfo  = getRunInfo(auditedFiles);
      runCommand     = runInfo?.cmd || (sessionStack ? getRunCommand(sessionStack) : null);
      try {
        localUrl = await runApp(name, auditedFiles);
        console.log(`[Deploy] App launched at ${localUrl}`);
      } catch (runErr) {
        console.warn('[AppRunner] Failed to auto-launch:', runErr.message);
        // Non-fatal — frontend will show Run Locally button instead
      }
    }

    res.json({
      success:    true,
      repoUrl,
      pagesUrl,
      localUrl,
      runCommand,   // e.g. "go run ." — shown as fallback copy-paste command
      isBackend,    // frontend uses this to show the right success card
      stack:        deployStack || sessionStack,   // lets frontend populate runLocally() correctly
      repoName:     name,
    });
  } catch (err) {
    if (!res.headersSent) {
      console.error('Deploy error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

module.exports = router;

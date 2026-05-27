'use strict';
/**
 * cloudflareService.js
 *
 * Deploys static files to Cloudflare Pages via the Direct Upload API (v2).
 * Each call creates (or reuses) a project, uploads all files content-addressed,
 * and creates a new deployment.
 *
 * Required env vars:
 *   CLOUDFLARE_ACCOUNT_ID  — found in the Cloudflare dashboard → right sidebar
 *   CLOUDFLARE_API_TOKEN   — create at dash.cloudflare.com/profile/api-tokens
 *                            with "Cloudflare Pages: Edit" permission
 */

const axios    = require('axios');
const FormData = require('form-data');
const crypto   = require('crypto');

const CF_API = 'https://api.cloudflare.com/client/v4';

// ── Helpers ───────────────────────────────────────────────────────

function sanitizeName(raw) {
  return (raw || 'r4l-site')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/^-+|-+$/g, '') // re-trim after slice in case slice cut mid-word
    || 'r4l-site';
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function guessMime(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css'))  return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js'))   return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.svg'))  return 'image/svg+xml';
  if (filePath.endsWith('.png'))  return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.ico'))  return 'image/x-icon';
  return 'application/octet-stream';
}

function cfHeaders(extra = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  return { Authorization: `Bearer ${token}`, ...extra };
}

function accountPath(subPath) {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  return `${CF_API}/accounts/${id}${subPath}`;
}

/** Log CF error details for diagnosing API failures */
function logCfError(context, err) {
  const status = err.response?.status;
  const body   = err.response?.data;
  const errors = body?.errors;
  console.error(`[CF] ${context} — HTTP ${status ?? 'network'}: ${err.message}`);
  if (errors?.length) {
    errors.forEach(e => console.error(`  CF error ${e.code}: ${e.message}`));
  } else if (body) {
    console.error('  CF response body:', JSON.stringify(body).slice(0, 400));
  }
}

// ── Core functions ────────────────────────────────────────────────

/**
 * Creates the Pages project if it doesn't exist yet.
 * Returns the project name (may differ if name was taken).
 */
async function ensureProject(projectName) {
  const url = accountPath('/pages/projects');
  try {
    await axios.post(
      url,
      { name: projectName, production_branch: 'main' },
      { headers: cfHeaders({ 'Content-Type': 'application/json' }) }
    );
    console.log(`[CF] Created project: ${projectName}`);
  } catch (err) {
    const status = err.response?.status;
    // 409 = project already exists — that's fine, continue.
    // Any other error (incl. 400 "invalid name", 401 auth) must propagate.
    if (status === 409) {
      console.log(`[CF] Project '${projectName}' already exists — reusing`);
      return projectName;
    }
    logCfError(`ensureProject(${projectName})`, err);
    const cfMsg = err.response?.data?.errors?.[0]?.message || err.message;
    throw new Error(`Cloud project setup failed (${status}): ${cfMsg}`);
  }
  return projectName;
}

/**
 * Deploy an array of { path, content } objects to Cloudflare Pages.
 *
 * @param {Array<{path: string, content: string|Buffer}>} files
 * @param {string} [projectNameHint]  - preferred project name (sanitised internally)
 * @returns {{ url: string, projectName: string, deploymentId: string }}
 */
async function deployToCloudflare(files, projectNameHint) {
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      'Live Deploy is not configured on this server. ' +
      'Contact support or choose "Host on GitHub" instead.'
    );
  }

  const projectName = sanitizeName(projectNameHint || `r4l-${Date.now().toString(36)}`);
  await ensureProject(projectName);

  // Build content-addressed manifest
  // CF Pages v2: manifest maps "/path" → sha256hex; each file part is named by its hash
  const manifest   = {};
  const hashToFile = new Map(); // deduplicate identical files

  for (const file of files) {
    const buf  = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, 'utf8');
    const hash = sha256hex(buf);
    const fp   = file.path.startsWith('/') ? file.path : `/${file.path}`;
    manifest[fp] = hash;
    if (!hashToFile.has(hash)) {
      hashToFile.set(hash, { buf, path: file.path });
    }
  }

  // Build multipart form.
  // CF Pages Direct Upload v2 requires:
  //   - manifest  → no filename, contentType: application/json
  //   - each file → MUST include filename in Content-Disposition so CF knows
  //                 how to classify and serve it (omitting filename causes blank pages)
  const form = new FormData();
  form.append('manifest', Buffer.from(JSON.stringify(manifest)), {
    contentType: 'application/json',
  });
  for (const [hash, { buf, path: fp }] of hashToFile) {
    const basename = fp.replace(/^\//, ''); // strip leading slash for filename
    form.append(hash, buf, {
      filename:    basename,
      contentType: guessMime(fp),
    });
  }

  const deployUrl = accountPath(`/pages/projects/${projectName}/deployments`);
  let res;
  try {
    res = await axios.post(deployUrl, form, {
      headers: {
        ...cfHeaders(),
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength:    Infinity,
      timeout:          120_000,
    });
  } catch (err) {
    logCfError(`deploy(${projectName})`, err);
    const cfMsg = err.response?.data?.errors?.[0]?.message || err.message;
    throw new Error(`Deployment failed (${err.response?.status ?? 'network'}): ${cfMsg}`);
  }

  // Validate the response — CF can return 200 but with success:false or a failed stage
  if (res.data?.success === false) {
    const cfMsg = res.data?.errors?.[0]?.message || 'Unknown error';
    console.error('[CF] Deployment API reported failure:', JSON.stringify(res.data).slice(0, 400));
    throw new Error(`Deployment rejected by server: ${cfMsg}`);
  }

  const deployment  = res.data?.result || {};
  const deployId    = deployment.id || null;
  let   stageStatus = deployment.latest_stage?.status;

  if (stageStatus === 'failure') {
    throw new Error(`Deployment failed during "${deployment.latest_stage?.name}" stage. Check Cloudflare dashboard.`);
  }

  // If the deployment is still queued / idle, poll until it goes live (up to 90 s).
  // Direct Upload normally activates within 10–30 s; 'idle' means CF queued it.
  if (stageStatus !== 'success' && deployId) {
    console.log(`[CF] Stage "${stageStatus}" — polling until ready (max 90 s)…`);
    stageStatus = await _waitForDeployment(projectName, deployId);
  }

  // Always use the canonical project URL — deployment.url is an internal
  // hash-prefixed preview URL (e.g. de308211.project.pages.dev) that Chrome
  // refuses to navigate to and that doesn't represent the live site.
  const liveUrl = `https://${projectName}.pages.dev`;

  // Verify the URL is actually serving content — CF edge propagation can lag
  // even after the deployment pipeline reports "success".
  await _verifyUrlLive(liveUrl);

  console.log(`[CF] Deployed → ${liveUrl}  (id: ${deployId}, stage: ${stageStatus})`);
  return {
    url:          liveUrl,
    projectName,
    deploymentId: deployId,
  };
}

/**
 * Ping the live URL until it responds with a 2xx status.
 * This guards against CF edge-propagation lag that can cause HTTP 500
 * for a short window after the deployment pipeline reports "success".
 * Gives up silently after maxWaitMs — the URL will be live momentarily.
 */
async function _verifyUrlLive(url, maxWaitMs = 60_000) {
  const POLL_MS = 5_000;
  const start   = Date.now();

  // Brief initial pause — let the edge start serving before first check
  await new Promise(r => setTimeout(r, 4_000));

  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await axios.get(url, {
        timeout:        10_000,
        validateStatus: null,   // never throw on HTTP error codes
        maxRedirects:   5,
      });
      if (r.status >= 200 && r.status < 400) {
        console.log(`[CF] URL live ✅ ${url} (HTTP ${r.status})`);
        return;
      }
      console.log(`[CF] URL returned HTTP ${r.status} — waiting for edge…`);
    } catch (err) {
      console.log(`[CF] URL ping error: ${err.message} — retrying…`);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  console.warn(`[CF] URL not verified as live after ${maxWaitMs / 1000}s — returning anyway`);
}

/**
 * Poll a deployment until its latest_stage.status is 'success' or 'failure'.
 * Returns the final status string.
 * Gives up (and returns 'timeout') after maxWaitMs — the canonical URL will
 * still work once CF finishes, usually within a few minutes.
 */
async function _waitForDeployment(projectName, deploymentId, maxWaitMs = 90_000) {
  const POLL_MS = 5_000; // check every 5 seconds
  const start   = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, POLL_MS));

    try {
      const pollUrl = accountPath(`/pages/projects/${projectName}/deployments/${deploymentId}`);
      const pollRes = await axios.get(pollUrl, { headers: cfHeaders(), timeout: 12_000 });
      const dep     = pollRes.data?.result || {};
      const stage   = dep.latest_stage?.status;
      const name    = dep.latest_stage?.name;
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[CF] Poll +${elapsed}s: stage=${stage} (${name})`);

      if (stage === 'success') return 'success';
      if (stage === 'failure') {
        throw new Error(`Deployment failed at stage "${name}". Check Cloudflare dashboard.`);
      }
      // still queued / active / idle → keep polling
    } catch (err) {
      if (err.message?.includes('failed at stage')) throw err; // propagate failure
      console.warn('[CF] Poll error (will retry):', err.message);
    }
  }

  console.warn(`[CF] Deployment ${deploymentId} still processing after ${maxWaitMs / 1000}s — returning URL anyway (site will be live shortly)`);
  return 'timeout';
}

module.exports = { deployToCloudflare };

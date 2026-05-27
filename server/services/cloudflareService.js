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
  const stageStatus = deployment.latest_stage?.status;

  if (stageStatus && stageStatus !== 'success') {
    console.error(`[CF] Deployment stage status: ${stageStatus}`, JSON.stringify(deployment.latest_stage));
    if (stageStatus === 'failure') {
      throw new Error(`Deployment failed during "${deployment.latest_stage?.name}" stage. Check Cloudflare dashboard.`);
    }
    // 'active' / 'queued' — still processing (shouldn't happen for direct upload, but log it)
    console.warn(`[CF] Deployment stage "${stageStatus}" — may still be processing`);
  }

  // Always use the canonical project URL — deployment.url is an internal
  // hash-prefixed preview URL (e.g. de308211.project.pages.dev) that Chrome
  // refuses to navigate to and that doesn't represent the live site.
  const liveUrl = `https://${projectName}.pages.dev`;

  console.log(`[CF] Deployed → ${liveUrl}  (id: ${deployment.id}, stage: ${stageStatus ?? 'unknown'}, rawUrl: ${deployment.url})`);
  return {
    url:          liveUrl,
    projectName,
    deploymentId: deployment.id || null,
  };
}

module.exports = { deployToCloudflare };

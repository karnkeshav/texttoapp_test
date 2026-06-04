'use strict';
/**
 * support.js — POST /api/support/ticket
 *
 * Full auto-heal pipeline:
 *
 *   1. Accept ticket → save to Firestore → return ticketId immediately
 *   2. Background triage (Gemini):
 *      a. Classify: account_issue | bug | feature_request | usage_question
 *      b. If account_issue + user signed in → apply fix (reset quota / extend plan) → email user
 *      c. If bug → count identical bugSignatures in Firestore
 *         • Count >= 3  → audit source files → if confirmed → generate fix → create GitHub PR
 *         • Count 1-2   → create GitHub issue for tracking
 *   3. Email owner: triage summary + action taken
 *
 * Required Render env vars:
 *   GMAIL_USER, GMAIL_APP_PASSWORD   — Gmail SMTP for outbound email
 *   GITHUB_TOKEN                     — GitHub PAT with `repo` scope on karnkeshav/texttoapp_test
 *   GEMINI_API_KEY                   — already used by the rest of the app
 *
 * GITHUB_TOKEN setup (one-time):
 *   1. github.com → Settings → Developer settings → Personal access tokens → Fine-grained
 *   2. Repository access: karnkeshav/texttoapp_test
 *   3. Permissions: Contents = read+write, Pull requests = read+write, Issues = read+write
 *   4. Copy the token → add to Render env vars as GITHUB_TOKEN
 */

const express    = require('express');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');

const { pooledGenerate }  = require('../services/geminiPool');
const { readSourceFile, createFixPR, createIssue } = require('../services/githubService');
const {
  saveTicket, updateTicketTriage, countSimilarBugs,
  resetUserQuota, extendUserPlan,
} = require('../services/firestoreService');

const router = express.Router();

const OWNER_EMAIL = 'keshav.karn@gmail.com';

// Max file size we'll attempt to auto-fix (larger files go to Issue instead of PR)
const MAX_AUTOFIX_BYTES = 80_000; // ~80 KB

const CATEGORIES = [
  'App Building', 'Document Conversion', 'Image Analysis',
  'Chat & Reasoning', 'Account & Billing', 'Technical Error', 'Other',
];

// All source files the AI auditor may examine
const SOURCE_FILES = [
  'server/routes/chat.js',
  'server/routes/auth.js',
  'server/routes/github.js',
  'server/routes/convert.js',
  'server/routes/user.js',
  'server/services/antigravity.js',
  'server/services/firestoreService.js',
  'server/services/fileConvert.js',
  'server/services/codeQuality.js',
  'server/middleware/packageGate.js',
  'server/index.js',
  'public/js/app.js',
];

// ── Lazy email transporter ─────────────────────────────────────────
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  _transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  return _transporter;
}

async function sendMail(opts) {
  const t = getTransporter();
  if (!t) { console.warn('[Support] GMAIL not configured — email not sent'); return; }
  try { await t.sendMail(opts); }
  catch (e) { console.error('[Support] Email send error:', e.message); }
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── AI prompts ────────────────────────────────────────────────────

function triagePrompt(ticket) {
  return `You are a support engineer for Ready4Launch — an AI-powered web app builder
(Node.js/Express backend, Vanilla JS frontend, Firestore, GitHub Pages deployment).

Support ticket:
Category: ${ticket.category}
Subject: ${ticket.subject}
Description: ${ticket.description}

Classify this ticket. Respond with ONLY valid JSON (no markdown, no explanation):
{
  "type": "account_issue" | "bug" | "feature_request" | "usage_question",
  "severity": "critical" | "high" | "medium" | "low",
  "summary": "one clear sentence",
  "bugSignature": null | "3-5-word-slug for deduplication e.g. deploy-button-missing-after-build",
  "relevantFiles": null | ["up to 2 paths from the allowed list"],
  "accountFix": null | { "action": "reset_quota" | "extend_plan_7d", "reason": "why" },
  "suggestedAction": "what to do to resolve this"
}

Allowed relevantFiles paths:
${SOURCE_FILES.map(f => '  ' + f).join('\n')}

Classification rules:
- account_issue: quota eaten, plan expired early, access denied, missing data → set accountFix if clearly fixable
- bug: reproducible error, broken feature, wrong behaviour → set bugSignature (slug format)
- feature_request: new capability wanted → suggestedAction only
- usage_question: how-to confusion → suggestedAction with the answer`;
}

function auditPrompt(bugSummary, userDescription, files) {
  const fileBlocks = files.map(f =>
    `=== ${f.path} ===\n${f.content.slice(0, 6000)}`  // cap per-file at 6K chars
  ).join('\n\n');

  return `You are auditing production source code for a reported bug.

Bug summary: "${bugSummary}"
User description: "${userDescription}"

SOURCE CODE:
${fileBlocks}

TASK: Does the code above contain the reported bug?
Respond with ONLY valid JSON (no markdown):
{
  "confirmed": true | false,
  "bugDescription": "exact description of what in the code causes the bug (or empty string if not confirmed)",
  "affectedFiles": ["file paths that need changing"],
  "fixDescription": "what specifically needs to change to fix it (or empty string if not confirmed)",
  "reason": "brief explanation of your decision"
}`;
}

function fixPrompt(bugDescription, fixDescription, filePath, fileContent) {
  return `You are fixing a confirmed bug in a production Node.js/Express web app.

Bug: ${bugDescription}
What to change: ${fixDescription}

FILE: ${filePath}

CURRENT CONTENT:
${fileContent}

Fix ONLY the confirmed bug. Do not refactor or change anything else.
Return the COMPLETE corrected file — no markdown fences, no explanation, just the fixed code.`;
}

// ── Helpers ───────────────────────────────────────────────────────

function parseJSON(raw) {
  // Strip markdown fences if the model wraps in ```json
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

async function callGemini(prompt, maxTokens = 1024) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  return pooledGenerate({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config:   { temperature: 0.1, maxOutputTokens: maxTokens },
    apiKey,
    tier: 'build',
  });
}

// ── Main triage pipeline (runs in background) ─────────────────────

async function runTriageAsync({ ticketId, uid, ticket, apiKey }) {
  const result = {
    type:              null,
    severity:          null,
    summary:           null,
    accountFix:        null,
    accountFixApplied: false,
    bugSignature:      null,
    similarCount:      0,
    auditConfirmed:    false,
    prUrl:             null,
    issueUrl:          null,
    ownerEmailSent:    false,
  };

  // ── Step 1: AI triage ──────────────────────────────────────────
  let triage;
  try {
    const raw = await callGemini(triagePrompt(ticket));
    triage    = parseJSON(raw);
    result.type          = triage.type         || 'usage_question';
    result.severity      = triage.severity     || 'low';
    result.summary       = triage.summary      || ticket.subject;
    result.bugSignature  = triage.bugSignature  || null;
    result.accountFix    = triage.accountFix    || null;
    result.relevantFiles = triage.relevantFiles || [];
    result.suggestedAction = triage.suggestedAction || '';
    console.log(`[Support] Triage[${ticketId}]: type=${result.type} severity=${result.severity}`);
  } catch (err) {
    console.error('[Support] Triage failed:', err.message);
    result.summary = ticket.subject;
    result.type    = 'usage_question';
  }

  // ── Step 2: Account-level fix (specific to this user only) ────
  if (result.type === 'account_issue' && result.accountFix && uid) {
    try {
      const { action, reason } = result.accountFix;
      if (action === 'reset_quota') {
        await resetUserQuota(uid);
        result.accountFixApplied = true;
        console.log(`[Support] Quota reset applied for uid:${uid}`);
      } else if (action === 'extend_plan_7d') {
        await extendUserPlan(uid, 7);
        result.accountFixApplied = true;
        console.log(`[Support] Plan extended 7d for uid:${uid}`);
      }
      // Email the affected user
      if (result.accountFixApplied && ticket.email) {
        const actionLabel = action === 'reset_quota'
          ? "reset your daily prompt quota (you're back to full allowance for today)"
          : "extended your plan by 7 days";
        await sendMail({
          from:    `"Ready4Launch Support" <${process.env.GMAIL_USER}>`,
          to:      ticket.email,
          subject: `[Ready4Launch] Your account has been updated — Ticket #${ticketId}`,
          html: `
<h2 style="color:#6366f1;">Ready4Launch — Account Update</h2>
<p>Hi ${esc(ticket.name || 'there')},</p>
<p>We received your support ticket <strong>#${ticketId}</strong> and have automatically applied a fix to your account.</p>
<p><strong>What we did:</strong> We've ${actionLabel}.</p>
<p><em>Reason detected by our system: ${esc(reason)}</em></p>
<p>You can now <a href="https://r4l.app/app">continue using Ready4Launch</a>. If you're still having issues, please reply to this email.</p>
<p style="color:#999;font-size:12px;">Ticket ID: ${ticketId}</p>`,
        });
      }
    } catch (err) {
      console.error('[Support] Account fix error:', err.message);
    }
  }

  // ── Step 3: Bug dedup + auto-fix pipeline ────────────────────
  if (result.type === 'bug' && result.bugSignature) {
    try {
      result.similarCount = await countSimilarBugs(result.bugSignature);
      console.log(`[Support] Bug "${result.bugSignature}" — ${result.similarCount} similar report(s)`);

      if (result.similarCount >= 3) {
        // Enough reports to justify automated investigation
        result.prUrl = await runAutoFixPipeline({
          ticketId, ticket,
          triage: result,
          apiKey,
        });
      } else if (result.similarCount === 2) {
        // 2nd duplicate — create tracking issue so it's visible
        result.issueUrl = await createTrackingIssue({ ticketId, ticket, triage: result });
      }
    } catch (err) {
      console.error('[Support] Bug pipeline error:', err.message);
    }
  }

  // ── Step 4: Persist triage to Firestore ───────────────────────
  await updateTicketTriage(ticketId, result);

  // ── Step 5: Email owner a triage summary ─────────────────────
  try {
    const actionTaken = result.accountFixApplied
      ? `✅ Account fix applied (${result.accountFix?.action})`
      : result.prUrl
      ? `🔧 Auto-fix PR created: ${result.prUrl}`
      : result.issueUrl
      ? `📋 Tracking issue created: ${result.issueUrl}`
      : result.similarCount >= 3
      ? `⚠️ Auto-fix attempted but GITHUB_TOKEN may not be set`
      : `📩 Ticket triaged — no automated action taken`;

    await sendMail({
      from:    `"Ready4Launch Support" <${process.env.GMAIL_USER}>`,
      to:      OWNER_EMAIL,
      replyTo: ticket.email || undefined,
      subject: `[R4L ${result.severity?.toUpperCase() || 'INFO'}] ${result.type}: ${result.summary?.slice(0,80)}`,
      html: `
<h2 style="color:#6366f1;">Ready4Launch — Support Ticket #${ticketId}</h2>
<table style="border-collapse:collapse;font-size:14px;font-family:Arial,sans-serif;">
  <tr><td style="padding:5px 12px 5px 0;color:#666;white-space:nowrap;"><b>Ticket ID</b></td><td>${esc(ticketId)}</td></tr>
  <tr><td style="padding:5px 12px 5px 0;color:#666;"><b>User</b></td><td>${esc(ticket.name)} &lt;${esc(ticket.email)}&gt;</td></tr>
  <tr><td style="padding:5px 12px 5px 0;color:#666;"><b>Category</b></td><td>${esc(ticket.category)}</td></tr>
  <tr><td style="padding:5px 12px 5px 0;color:#666;"><b>AI Type</b></td><td>${esc(result.type)}</td></tr>
  <tr><td style="padding:5px 12px 5px 0;color:#666;"><b>Severity</b></td><td>${esc(result.severity)}</td></tr>
  <tr><td style="padding:5px 12px 5px 0;color:#666;"><b>AI Summary</b></td><td>${esc(result.summary)}</td></tr>
  ${result.bugSignature ? `<tr><td style="padding:5px 12px 5px 0;color:#666;"><b>Bug Signature</b></td><td>${esc(result.bugSignature)} (${result.similarCount} report(s))</td></tr>` : ''}
  <tr><td style="padding:5px 12px 5px 0;color:#666;"><b>Suggested Action</b></td><td>${esc(result.suggestedAction)}</td></tr>
  <tr><td style="padding:5px 12px 5px 0;color:#666;"><b>Action Taken</b></td><td>${actionTaken}</td></tr>
</table>
<h3 style="margin-top:20px;">User's Description</h3>
<div style="background:#f8f8f8;border-left:4px solid #6366f1;padding:12px 16px;white-space:pre-wrap;font-size:14px;">${esc(ticket.description)}</div>`,
    });
    result.ownerEmailSent = true;
  } catch (err) {
    console.error('[Support] Owner email error:', err.message);
  }
}

// ── Auto-fix pipeline ─────────────────────────────────────────────

async function runAutoFixPipeline({ ticketId, ticket, triage, apiKey }) {
  console.log(`[Support] Starting auto-fix pipeline for bug "${triage.bugSignature}"`);

  // ── 1. Read relevant source files ─────────────────────────────
  const filesToRead = (triage.relevantFiles || [])
    .filter(f => SOURCE_FILES.includes(f))
    .slice(0, 2); // audit max 2 files per run to protect quota

  if (!filesToRead.length) {
    console.log('[Support] No relevant files identified — skipping auto-fix');
    return null;
  }

  const fileData = (
    await Promise.all(filesToRead.map(f => readSourceFile(f)))
  ).filter(Boolean);

  if (!fileData.length) {
    console.warn('[Support] Could not read source files (GITHUB_TOKEN may not be set)');
    return await createTrackingIssue({ ticketId, ticket, triage });
  }

  // ── 2. AI audit: confirm the bug exists ───────────────────────
  let audit;
  try {
    const raw = await callGemini(
      auditPrompt(triage.summary, ticket.description, fileData),
      2048
    );
    audit = parseJSON(raw);
    console.log(`[Support] Audit result: confirmed=${audit.confirmed} files=${JSON.stringify(audit.affectedFiles)}`);
  } catch (err) {
    console.error('[Support] Audit failed:', err.message);
    return await createTrackingIssue({ ticketId, ticket, triage });
  }

  if (!audit.confirmed) {
    console.log(`[Support] Audit: bug not confirmed in source — reason: ${audit.reason}`);
    // Still create an issue so the owner knows about the false positive
    return await createTrackingIssue({ ticketId, ticket, triage, auditNote: audit.reason });
  }

  // ── 3. Generate fixes for affected files ─────────────────────
  const affectedFiles = (audit.affectedFiles || [])
    .filter(f => SOURCE_FILES.includes(f));

  if (!affectedFiles.length) {
    console.warn('[Support] Audit confirmed bug but listed no affected files');
    return await createTrackingIssue({ ticketId, ticket, triage, auditNote: audit.bugDescription });
  }

  const fixedFiles = [];
  for (const filePath of affectedFiles) {
    const original = fileData.find(f => f.path === filePath);
    if (!original) continue;

    // Skip very large files — too risky to auto-rewrite
    if (original.sizeBytes > MAX_AUTOFIX_BYTES) {
      console.log(`[Support] ${filePath} is ${original.sizeBytes} bytes — too large for auto-fix, will track as issue`);
      continue;
    }

    try {
      console.log(`[Support] Generating fix for ${filePath}…`);
      const fixedContent = await callGemini(
        fixPrompt(audit.bugDescription, audit.fixDescription, filePath, original.content),
        16384 // allow up to 16K tokens for file rewrite
      );
      if (fixedContent && fixedContent.length > 100) {
        fixedFiles.push({ path: filePath, content: fixedContent });
        console.log(`[Support] Fix generated for ${filePath} (${fixedContent.length} chars)`);
      }
    } catch (err) {
      console.error(`[Support] Fix generation failed for ${filePath}:`, err.message);
    }
  }

  if (!fixedFiles.length) {
    console.warn('[Support] No fixes generated — falling back to issue');
    return await createTrackingIssue({ ticketId, ticket, triage, auditNote: audit.bugDescription });
  }

  // ── 4. Create branch + PR ─────────────────────────────────────
  try {
    const branchName = `auto-fix/${triage.bugSignature}-${Date.now().toString(36)}`;
    const prTitle    = `[Auto-fix] ${triage.summary}`;
    const prBody     = buildPRBody({ ticketId, triage, audit, similarCount: triage.similarCount });

    const prUrl = await createFixPR({ branchName, files: fixedFiles, prTitle, prBody });
    console.log(`[Support] PR created: ${prUrl}`);
    return prUrl;

  } catch (err) {
    console.error('[Support] PR creation failed:', err.message);
    // Fall back to issue
    return await createTrackingIssue({ ticketId, ticket, triage, auditNote: audit.bugDescription });
  }
}

// ── Create a tracking issue (when fix can't be auto-generated) ───

async function createTrackingIssue({ ticketId, ticket, triage, auditNote }) {
  try {
    const title = `[Bug] ${triage.summary}`;
    const body  = [
      `## Bug Report — ${triage.similarCount} user(s) affected`,
      '',
      `**AI Summary:** ${triage.summary}`,
      auditNote ? `**Audit Note:** ${auditNote}` : '',
      '',
      `**Category:** ${ticket.category}`,
      `**Severity:** ${triage.severity}`,
      `**Bug Signature:** \`${triage.bugSignature}\``,
      '',
      `### User Description`,
      '```',
      ticket.description,
      '```',
      '',
      `**Relevant Files:** ${(triage.relevantFiles || []).join(', ') || 'unknown'}`,
      '',
      `**Suggested Fix:** ${triage.suggestedAction}`,
      '',
      `---`,
      `*Ticket ID: ${ticketId} — auto-raised by Ready4Launch support pipeline*`,
    ].filter(l => l !== undefined).join('\n');

    const issueUrl = await createIssue({
      title,
      body,
      labels: ['bug', 'user-reported'],
    });
    console.log(`[Support] Tracking issue created: ${issueUrl}`);
    return issueUrl;
  } catch (err) {
    console.error('[Support] Issue creation failed:', err.message);
    return null;
  }
}

function buildPRBody({ ticketId, triage, audit, similarCount }) {
  return [
    `## Auto-fix: ${triage.summary}`,
    '',
    `> **${similarCount} users** reported this bug (signature: \`${triage.bugSignature}\`)`,
    '',
    `### Bug confirmed by AI Auditor`,
    audit.bugDescription,
    '',
    `### Fix applied`,
    audit.fixDescription,
    '',
    `### Review checklist`,
    '- [ ] The fix addresses the root cause',
    '- [ ] No unintended side effects in changed code',
    '- [ ] Merging this will trigger a Render auto-deploy',
    '',
    `**Severity:** ${triage.severity}  `,
    `**Category:** original ticket category`,
    '',
    `---`,
    `*Auto-generated by Ready4Launch support pipeline — Ticket #${ticketId}*`,
    `*After review, merge this PR and Render will deploy the fix automatically.*`,
  ].join('\n');
}

// ── POST /api/support/ticket ──────────────────────────────────────

router.post('/ticket', async (req, res) => {
  const { name, email, category, subject, description } = req.body || {};

  if (!subject?.trim() || !description?.trim()) {
    return res.status(400).json({ error: 'Subject and description are required.' });
  }

  // Derive uid from session (if the user is logged in)
  const session = req.session || {};
  const uid = session.googleUser?.uid
    || (session.githubToken && session.user?.login ? `gh_${session.user.login}` : null)
    || null;

  const cat      = CATEGORIES.includes(category) ? category : 'Other';
  const ticketId = `T-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const ticket = {
    name:        (name        || '').trim(),
    email:       (email       || '').trim(),
    category:    cat,
    subject:     subject.trim(),
    description: description.trim(),
  };

  console.log(`[Support] Ticket ${ticketId} — uid:${uid || 'guest'} category:"${cat}" subject:"${subject.slice(0,60)}"`);

  // ── Persist ticket immediately ─────────────────────────────────
  await saveTicket({ ticketId, uid, ...ticket });

  // ── Respond to the user right away ────────────────────────────
  res.json({ success: true, ticketId });

  // ── Run triage in background (non-blocking) ───────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    runTriageAsync({ ticketId, uid, ticket, apiKey }).catch(err =>
      console.error('[Support] Unhandled triage error:', err.message)
    );
  } else {
    // No Gemini — still send a plain email so the owner is notified
    sendMail({
      from:    `"Ready4Launch Support" <${process.env.GMAIL_USER}>`,
      to:      OWNER_EMAIL,
      replyTo: ticket.email || undefined,
      subject: `[R4L Support] ${cat}: ${subject.trim().slice(0, 100)}`,
      html: `
<h2 style="color:#6366f1;">Ready4Launch — Support Ticket #${ticketId}</h2>
<p><b>From:</b> ${esc(ticket.name)} &lt;${esc(ticket.email)}&gt;</p>
<p><b>Category:</b> ${esc(cat)}</p>
<p><b>Subject:</b> ${esc(subject)}</p>
<h3>Description</h3>
<div style="background:#f8f8f8;border-left:4px solid #6366f1;padding:12px;white-space:pre-wrap;">${esc(description)}</div>
<p style="color:#999;font-size:12px;">Ticket ID: ${ticketId}</p>`,
    }).catch(() => {});
  }
});

// ── GET /api/support/categories ───────────────────────────────────
router.get('/categories', (_req, res) => res.json(CATEGORIES));

module.exports = router;

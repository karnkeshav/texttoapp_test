'use strict';
/**
 * packageGate.js
 *
 * Called synchronously BEFORE SSE headers are flushed so we can still
 * return a plain JSON error (402 / 403 / 429) that the client handles.
 *
 * Usage (in a route handler, before res.flushHeaders()):
 *
 *   const gate = await checkGate(req, section);
 *   if (!gate.ok) return res.status(gate.status).json(gate);
 */

const {
  getPackageStatus,
  checkAndIncrementUsage,
  recordSession,
  OWNER_EMAILS,
} = require('../services/firestoreService');

/**
 * Derive a stable uid from the session regardless of auth provider.
 */
function uidFromSession(session) {
  if (session?.googleUser?.uid) return session.googleUser.uid;
  if (session?.githubToken && session?.user?.login) return `gh_${session.user.login}`;
  return null;
}

/**
 * Light-weight intent pre-classifier — mirrors the regex in chat.js
 * but only needs to produce a section label (build / vision / convert / chat).
 */
function quickSection(message, isImage, isEdit) {
  if (isImage) return 'vision';
  if (isEdit)  return 'build';
  if (/\b(convert|export|turn|transform)\b.{0,40}\b(word|docx?|excel|xlsx?|csv|ppt|powerpoint|json|pdf)\b/i.test(message)) return 'convert';
  if (/\b(build|create|make|generate|develop|design|i want|give me|i need)\b.{0,50}\b(app|website|site|page|tool|dashboard|tracker|game|quiz|platform|shop|store)\b/i.test(message)) return 'build';
  return 'chat';
}

/**
 * Main gate function.
 *
 * @param {object} req        - Express request
 * @param {string} section    - pre-classified section from caller
 * @param {boolean} newConv   - true when this is the first message of a new conversation
 * @returns {{ ok, status, error, message, ... }}
 */
async function checkGate(req, section, newConv) {
  const uid = uidFromSession(req.session);

  // AUTH + PACKAGE GATE DISABLED — all requests pass through without auth or payment
  // Firebase/Firestore checks are also bypassed so no 402/403/429 can be returned.
  // Re-enable by removing this early return and restoring the blocks below.
  return { ok: true, uid: uid || 'guest' };

  // ── AUTH DISABLED — commented out ────────────────────────────────
  // ── 1. Must be authenticated ─────────────────────────────────────
  // if (!uid) {
  //   return { ok: false, status: 401, error: 'not_authenticated',
  //            message: 'Please sign in to use Ready4Launch.' };
  // }

  // ── 1b. Owner accounts — bypass all restrictions ─────────────────
  // const userEmail = req.session?.googleUser?.email || req.session?.user?.email || null;
  // if (userEmail && OWNER_EMAILS.has(userEmail)) {
  //   if (section && newConv) {
  //     checkAndIncrementUsage(uid, section, 'professional').catch(() => {});
  //   }
  //   return { ok: true, uid, owner: true };
  // }

  // ── 2. Read package ──────────────────────────────────────────────
  // const status = await getPackageStatus(uid);
  // if (status === null) return { ok: true };   // Firestore not configured → open access

  // ── 3. Must have a package ───────────────────────────────────────
  // if (!status.package) {
  //   return { ok: false, status: 402, error: 'no_package',
  //            message: 'Choose a plan to start building with Ready4Launch.' };
  // }

  // ── 4. Package must not be expired ──────────────────────────────
  // if (status.expired) {
  //   return {
  //     ok: false, status: 403, error: 'package_expired',
  //     package: status.package,
  //     expiresAt: status.packageExpiresAt?.toISOString?.() || null,
  //     message: status.package === 'demo'
  //       ? 'Your demo has expired. Buy a package to continue.'
  //       : 'Your subscription has expired. Please renew to continue.',
  //   };
  // }

  // ── 5. Usage tracking + per-section daily limit ─────────────────
  // if (newConv && section) {
  //   const usage = await checkAndIncrementUsage(uid, section, status.package);
  //   if (status.package === 'demo' && !usage.allowed) {
  //     return {
  //       ok: false, status: 429, error: 'daily_limit_reached', section,
  //       count: usage.count, limit: usage.limit,
  //       message: `You've used all ${usage.limit} ${section} prompts for today. Come back tomorrow!`,
  //     };
  //   }
  // }

  // return { ok: true, uid, package: status.package, section };
}

module.exports = { checkGate, uidFromSession, quickSection };

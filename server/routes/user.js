'use strict';
/**
 * user.js — member profile + package purchase
 *
 * Routes:
 *   GET  /api/user/profile   — full profile (package, usage, history)
 *   POST /api/user/package   — activate a package (mock purchase for now)
 */

const express = require('express');
const { getUserProfile, setPackage, PACKAGES } = require('../services/firestoreService');
const { uidFromSession } = require('../middleware/packageGate');

const router = express.Router();

// AUTH DISABLED — auth check commented out; all requests pass as guest
// function requireAnyAuth(req, res, next) {
//   const uid = uidFromSession(req.session);
//   if (!uid) return res.status(401).json({ error: 'Sign in required' });
//   req.uid = uid;
//   next();
// }
function requireAnyAuth(req, res, next) {
  req.uid = uidFromSession(req.session) || 'guest';
  next();
}

// ── GET /api/user/profile ──────────────────────────────────────────
router.get('/profile', requireAnyAuth, async (req, res) => {
  try {
    const profile = await getUserProfile(req.uid);
    if (profile) return res.json(profile);

    // Firestore not configured or user doc not yet created — return a
    // session-based stub so the profile page renders instead of showing
    // a "Sign in" error loop.
    const sess       = req.session;
    const googleUser = sess.googleUser;
    const githubUser = sess.githubUser;
    const sessionUser = sess.user || {};

    return res.json({
      uid:              req.uid,
      email:            googleUser?.email || githubUser?.email || sessionUser.login || null,
      name:             sessionUser.name  || googleUser?.name  || githubUser?.name  || null,
      picture:          sessionUser.avatarUrl || googleUser?.picture || null,
      provider:         sessionUser.provider  || 'unknown',
      githubLogin:      githubUser?.login || sessionUser.githubLogin || null,
      createdAt:        null,
      lastLogin:        null,
      package:          null,
      packageName:      null,
      packageBoughtAt:  null,
      packageExpiresAt: null,
      packageExpired:   false,
      limit:            null,
      unlimited:        false,
      todayUsage:       { build: 0, chat: 0, convert: 0, vision: 0 },
      sessions:         [],
      _firestoreUnavailable: true,  // lets frontend show a soft notice
    });
  } catch (err) {
    console.error('[User] profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/user/packages ─────────────────────────────────────────
// Returns the package catalogue so the frontend can render pricing cards.
router.get('/packages', (req, res) => {
  const catalogue = [
    {
      id:          'test_drive',
      name:        '5 Day Test Drive',
      tagline:     'Explore the full platform for 5 days',
      price:       '₹1,999',
      priceSub:    '5-day access',
      features:    [
        '2 builds per day',
        '2 chat sessions per day',
        '2 document conversions per day',
        '2 image analyses per day',
        'Deploy to GitHub Pages',
        'Full activity history',
      ],
      highlight:   false,
      cta:         'Start Test Drive',
    },
    {
      id:          'standard',
      name:        'Standard Builder',
      tagline:     'For individuals & growing teams',
      price:       '₹4,999',
      priceSub:    'lifetime access',
      features:    [
        '20 builds per day',
        '20 chat sessions per day',
        '20 document conversions per day',
        '20 image analyses per day',
        'Deploy to GitHub Pages',
        'Full activity history',
        'Priority support',
      ],
      highlight:   true,
      cta:         'Get Standard Builder',
    },
    {
      id:          'professional',
      name:        'Professional Builder',
      tagline:     'Unlimited power for serious creators',
      price:       '₹5,099',
      priceSub:    'setup fee, then ₹99/month',
      features:    [
        'Unlimited builds',
        'Unlimited chat sessions',
        'Unlimited document conversions',
        'Unlimited image analyses',
        'Deploy to GitHub Pages',
        'Full activity history',
        'Priority AI access',
        'Dedicated support',
      ],
      highlight:   false,
      cta:         'Get Professional Builder',
    },
  ];
  res.json(catalogue);
});

// ── POST /api/user/package ─────────────────────────────────────────
// In production this would validate a payment receipt first.
// For now it immediately activates the chosen package.
router.post('/package', requireAnyAuth, async (req, res) => {
  const { packageType } = req.body;

  if (!PACKAGES[packageType]) {
    return res.status(400).json({ error: `Unknown package: ${packageType}` });
  }

  try {
    await setPackage(req.uid, packageType);

    const pkg      = PACKAGES[packageType];
    const expiry   = new Date();
    expiry.setDate(expiry.getDate() + pkg.daysValid);

    res.json({
      success:     true,
      package:     packageType,
      packageName: pkg.name,
      expiresAt:   expiry.toISOString(),
      message:     `${pkg.name} activated! ${pkg.daysValid}-day access starts now.`,
    });
  } catch (err) {
    console.error('[User] setPackage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

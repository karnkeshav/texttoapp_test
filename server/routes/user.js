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

function requireAnyAuth(req, res, next) {
  const uid = uidFromSession(req.session);
  if (!uid) return res.status(401).json({ error: 'Sign in required' });
  req.uid = uid;
  next();
}

// ── GET /api/user/profile ──────────────────────────────────────────
router.get('/profile', requireAnyAuth, async (req, res) => {
  try {
    const profile = await getUserProfile(req.uid);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profile);
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
        'Instant publish (live link)',
        'GitHub Pages deploy',
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
        'Instant publish (live link)',
        'GitHub Pages deploy',
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
        'Instant publish (live link)',
        'GitHub Pages deploy',
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

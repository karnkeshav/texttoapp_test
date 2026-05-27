'use strict';
/**
 * firestoreService.js — Firebase Admin + Firestore user management
 *
 * Initialised lazily on first call so the server still starts if
 * FIREBASE_* env vars are missing (e.g. local dev without Firestore).
 *
 * Collections:
 *   /users/{uid}                — user profile + package info
 *   /users/{uid}/usage/{date}   — daily prompt counters per section
 *   /users/{uid}/sessions       — activity history (last 50)
 *
 * Package types:
 *   demo    — free trial, 2 prompts/section/day, expires 5 days after purchase
 *   starter — paid, 20 prompts/section/day, 30 days
 *   pro     — paid, unlimited, 30 days
 */

// ── Owner / admin accounts — full unrestricted access ────────────
// These email addresses bypass the package gate entirely.
const OWNER_EMAILS = new Set([
  'keshav.karn@gmail.com',
  'keshav1karn@gmail.com',
  'ready4urexam@gmail.com',
]);

// ── Package definitions ───────────────────────────────────────────
const PACKAGES = {
  test_drive: {
    name:                    '5 Day Test Drive',
    daysValid:               5,
    promptsPerSectionPerDay: 2,
    unlimited:               false,
    priceINR:                1999,
    priceLabel:              '₹1,999',
    priceSub:                '5-day access',
  },
  standard: {
    name:                    'Standard Builder',
    daysValid:               30,
    promptsPerSectionPerDay: 20,
    unlimited:               false,
    priceINR:                4999,
    priceLabel:              '₹4,999',
    priceSub:                'per month',
  },
  professional: {
    name:                    'Professional Builder',
    daysValid:               30,
    promptsPerSectionPerDay: null,
    unlimited:               true,
    priceINR:                5099,
    priceLabel:              '₹5,099 + ₹99/mo',
    priceSub:                'setup fee, then ₹99/month',
  },
};

let _admin = null;
let _db    = null;

function getAdmin() {
  if (_admin) return _admin;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    console.warn('[Firestore] FIREBASE_* env vars not set — user persistence disabled');
    return null;
  }

  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId:   FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          // Render stores multiline values with literal \n — replace them
          privateKey:  FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    _admin = admin;
    _db    = admin.firestore();
    console.log('[Firestore] Connected to project:', FIREBASE_PROJECT_ID);
    return admin;
  } catch (err) {
    console.error('[Firestore] Init error:', err.message);
    return null;
  }
}

/**
 * Upsert a user record. Safe to call on every login.
 * Creates the document on first login, updates lastLogin + name/picture on subsequent logins.
 */
async function upsertUser({ uid, email, name, picture, provider = 'google', githubLogin }) {
  const admin = getAdmin();
  if (!admin || !_db) return; // Firestore not configured — silently skip

  try {
    const ref = _db.collection('users').doc(uid);
    const now = admin.firestore.FieldValue.serverTimestamp();

    const snap = await ref.get();
    if (snap.exists) {
      const update = { lastLogin: now, name, picture };
      if (githubLogin) update.githubLogin = githubLogin;
      await ref.update(update);
    } else {
      const data = { uid, email, name, picture, provider, createdAt: now, lastLogin: now };
      if (githubLogin) data.githubLogin = githubLogin;
      await ref.set(data);
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.error('[Firestore] upsertUser error:', err.message);
  }
}

/**
 * Attach a GitHub login to an existing Google-authed user.
 */
async function linkGitHub(uid, githubLogin) {
  const admin = getAdmin();
  if (!admin || !_db) return;
  try {
    await _db.collection('users').doc(uid).update({
      githubLogin,
      githubLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[Firestore] linkGitHub error:', err.message);
  }
}

// ── Package management ────────────────────────────────────────────

/**
 * Set (or upgrade) a user's package. Calculates expiry automatically.
 */
async function setPackage(uid, packageType) {
  const admin = getAdmin();
  if (!admin || !_db) return;

  const pkg = PACKAGES[packageType];
  if (!pkg) throw new Error(`Unknown package: ${packageType}`);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + pkg.daysValid);

  await _db.collection('users').doc(uid).update({
    package:           packageType,
    packageBoughtAt:   admin.firestore.FieldValue.serverTimestamp(),
    packageExpiresAt:  admin.firestore.Timestamp.fromDate(expiresAt),
  });
}

/**
 * Read a user's package status.
 * Returns null when Firestore is not configured.
 * Returns { package, packageBoughtAt, packageExpiresAt, expired } otherwise.
 */
async function getPackageStatus(uid) {
  const admin = getAdmin();
  if (!admin || !_db) return null; // Firestore not configured — open access

  try {
    const snap = await _db.collection('users').doc(uid).get();
    if (!snap.exists) return { package: null };

    const d = snap.data();
    const expiresAt = d.packageExpiresAt?.toDate() || null;
    const expired   = expiresAt ? new Date() > expiresAt : false;

    return {
      package:          d.package   || null,
      packageBoughtAt:  d.packageBoughtAt?.toDate()  || null,
      packageExpiresAt: expiresAt,
      expired,
    };
  } catch (err) {
    console.error('[Firestore] getPackageStatus error:', err.message);
    return null;
  }
}

/**
 * Check whether the user can send a prompt in `section` today.
 * Increments the counter only when allowed.
 *
 * Returns { allowed, count, limit }
 *   allowed — whether the prompt is permitted
 *   count   — NEW count after increment (or current count when blocked)
 *   limit   — null = unlimited, number = per-section-per-day cap
 */
async function checkAndIncrementUsage(uid, section, packageType) {
  const admin = getAdmin();
  if (!admin || !_db) return { allowed: true, count: 0, limit: null };

  const pkg   = PACKAGES[packageType];
  const limit = pkg?.unlimited ? null : (pkg?.promptsPerSectionPerDay ?? null);

  const today   = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const usageRef = _db.collection('users').doc(uid).collection('usage').doc(today);

  try {
    // Use a transaction so read + write is atomic
    return await _db.runTransaction(async (tx) => {
      const snap    = await tx.get(usageRef);
      const current = snap.exists ? (snap.data()[section] || 0) : 0;

      if (limit !== null && current >= limit) {
        return { allowed: false, count: current, limit };
      }

      tx.set(
        usageRef,
        {
          [section]: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { allowed: true, count: current + 1, limit };
    });
  } catch (err) {
    console.error('[Firestore] checkAndIncrementUsage error:', err.message);
    return { allowed: true, count: 0, limit: null }; // fail-open
  }
}

/**
 * Append an activity entry to the user's session history (last 50 kept).
 */
async function recordSession(uid, { type, summary }) {
  const admin = getAdmin();
  if (!admin || !_db) return;
  try {
    await _db.collection('users').doc(uid).collection('sessions').add({
      type,
      summary: (summary || '').slice(0, 120),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[Firestore] recordSession error:', err.message);
  }
}

/**
 * Return a user's full profile: info + package + today's usage + recent sessions.
 */
async function getUserProfile(uid) {
  const admin = getAdmin();
  if (!admin || !_db) return null;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const [userSnap, usageSnap, sessionsSnap] = await Promise.all([
      _db.collection('users').doc(uid).get(),
      _db.collection('users').doc(uid).collection('usage').doc(today).get(),
      _db.collection('users').doc(uid).collection('sessions')
         .orderBy('createdAt', 'desc').limit(50).get(),
    ]);

    if (!userSnap.exists) return null;
    const d = userSnap.data();

    const expiresAt = d.packageExpiresAt?.toDate() || null;
    const pkg       = d.package || null;
    const pkgDef    = pkg ? PACKAGES[pkg] : null;

    const todayUsage = usageSnap.exists ? usageSnap.data() : {};
    const sessions   = sessionsSnap.docs.map(doc => {
      const s = doc.data();
      return {
        id:        doc.id,
        type:      s.type,
        summary:   s.summary,
        createdAt: s.createdAt?.toDate()?.toISOString() || null,
      };
    });

    return {
      uid:              d.uid,
      email:            d.email,
      name:             d.name,
      picture:          d.picture,
      provider:         d.provider,
      githubLogin:      d.githubLogin || null,
      createdAt:        d.createdAt?.toDate()?.toISOString() || null,
      lastLogin:        d.lastLogin?.toDate()?.toISOString() || null,
      package:          pkg,
      packageName:      pkgDef?.name || null,
      packageBoughtAt:  d.packageBoughtAt?.toDate()?.toISOString() || null,
      packageExpiresAt: expiresAt?.toISOString() || null,
      packageExpired:   expiresAt ? new Date() > expiresAt : false,
      limit:            pkgDef?.promptsPerSectionPerDay ?? null,
      unlimited:        pkgDef?.unlimited ?? false,
      todayUsage:       { build: 0, chat: 0, convert: 0, vision: 0, ...todayUsage },
      sessions,
    };
  } catch (err) {
    console.error('[Firestore] getUserProfile error:', err.message);
    return null;
  }
}

module.exports = {
  upsertUser, linkGitHub,
  setPackage, getPackageStatus, checkAndIncrementUsage, recordSession, getUserProfile,
  PACKAGES, OWNER_EMAILS,
};

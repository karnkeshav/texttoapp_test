'use strict';
/**
 * firestoreSessionStore.js
 *
 * express-session-compatible store with two tiers:
 *
 *   1. Firestore  — used when FIREBASE_* env vars are set (production on Render).
 *                   Sessions survive server restarts because they live in Firestore.
 *
 *   2. Memory Map — used when Firestore is not configured (local dev, CI tests).
 *                   Identical behaviour to express-session's built-in MemoryStore.
 *
 * The class extends expressSession.Store (not EventEmitter) so that the internal
 * createSession / generate / regenerate methods are available — express-session
 * requires them when inflating a session from storage.
 *
 * No new npm dependencies — uses firebase-admin already in package.json.
 */

const expressSession = require('express-session');
const { getDb }      = require('./firestoreService');

class FirestoreSessionStore extends expressSession.Store {
  constructor() {
    super();
    // In-memory fallback used when Firestore is not configured.
    // Also used as a write-through cache on Firestore errors so sessions
    // are never silently dropped.
    this._mem = new Map(); // sid → { sess: plainObject, expiresAt: number (ms epoch) }
  }

  // ── Internal helpers ───────────────────────────────────────────────

  _coll() {
    const db = getDb();
    return db ? db.collection('sessions') : null;
  }

  _serialize(sess) {
    // Firestore (and the memory fallback) need a plain object.
    // express-session passes a Session instance (custom prototype) — strip it.
    return JSON.parse(JSON.stringify(sess));
  }

  // ── Required by express-session ────────────────────────────────────

  get(sid, cb) {
    const coll = this._coll();

    // ── Memory path (no Firestore) ──────────────────────────────────
    if (!coll) {
      const entry = this._mem.get(sid);
      if (!entry) return cb(null, null);
      if (Date.now() > entry.expiresAt) {
        this._mem.delete(sid);
        return cb(null, null);
      }
      return cb(null, entry.sess);
    }

    // ── Firestore path ──────────────────────────────────────────────
    coll.doc(sid).get()
      .then(snap => {
        if (!snap.exists) return cb(null, null);

        const { sess, expiresAt } = snap.data();

        // Lazy TTL — delete expired doc on first read after expiry
        if (expiresAt && expiresAt.toDate() < new Date()) {
          snap.ref.delete().catch(() => {});
          return cb(null, null);
        }

        cb(null, sess);
      })
      .catch(err => {
        console.warn('[SessionStore] Firestore get error — trying memory:', err.message);
        // Fall back to memory on transient Firestore errors
        const entry = this._mem.get(sid);
        cb(null, (entry && Date.now() <= entry.expiresAt) ? entry.sess : null);
      });
  }

  set(sid, sess, cb) {
    // Strip custom Session prototype → plain serialisable object
    let plainSess;
    try {
      plainSess = this._serialize(sess);
    } catch (err) {
      console.warn('[SessionStore] serialisation failed — session not persisted:', err.message);
      return cb(null); // fail-open; request still works, just won't persist
    }

    const maxAge    = sess?.cookie?.maxAge ?? 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + maxAge);

    // Always keep memory copy as safety net (used by get() on Firestore errors)
    this._mem.set(sid, { sess: plainSess, expiresAt: expiresAt.getTime() });

    const coll = this._coll();

    // ── Memory-only path ────────────────────────────────────────────
    if (!coll) return cb(null);

    // ── Firestore path ──────────────────────────────────────────────
    coll.doc(sid).set({ sess: plainSess, expiresAt, updatedAt: new Date() })
      .then(() => cb(null))
      .catch(err => {
        // Memory copy already written above — session still works this process lifetime
        console.warn('[SessionStore] Firestore set error (memory fallback active):', err.message);
        cb(null);
      });
  }

  destroy(sid, cb) {
    this._mem.delete(sid);

    const coll = this._coll();
    if (!coll) return cb(null);

    coll.doc(sid).delete()
      .then(() => cb(null))
      .catch(err => {
        console.warn('[SessionStore] Firestore destroy error:', err.message);
        cb(null);
      });
  }

  // ── Optional — improves session TTL renewal ────────────────────────
  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = { FirestoreSessionStore };

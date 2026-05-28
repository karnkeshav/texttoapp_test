'use strict';
/**
 * firestoreSessionStore.js
 *
 * A minimal express-session-compatible store backed by Firestore.
 * Survives server restarts — sessions live in /sessions/{sid} in Firestore.
 *
 * Drop-in replacement for MemoryStore when Firestore is configured.
 * Falls back transparently (all operations are no-ops) if Firestore is not set up.
 *
 * TTL: sessions expire when their cookie.maxAge elapses (same as MemoryStore).
 * Cleanup: expired docs are checked on read and deleted lazily.
 *
 * No new npm dependencies — uses firebase-admin already in package.json.
 */

const { EventEmitter } = require('events');
const { getDb }        = require('./firestoreService');

class FirestoreSessionStore extends EventEmitter {
  constructor() {
    super();
    // _coll is resolved lazily on first use
  }

  _coll() {
    const db = getDb();
    return db ? db.collection('sessions') : null;
  }

  // ── Required by express-session ────────────────────────────────
  get(sid, cb) {
    const coll = this._coll();
    if (!coll) return cb(null, null); // Firestore not ready → treat as no session

    coll.doc(sid).get()
      .then(snap => {
        if (!snap.exists) return cb(null, null);

        const { sess, expiresAt } = snap.data();

        // Lazy TTL check — delete expired docs on first read after expiry
        if (expiresAt && expiresAt.toDate() < new Date()) {
          snap.ref.delete().catch(() => {});
          return cb(null, null);
        }

        cb(null, sess);
      })
      .catch(err => {
        console.warn('[SessionStore] get error (falling back):', err.message);
        cb(null, null); // fail-open — don't break the request
      });
  }

  set(sid, sess, cb) {
    const coll = this._coll();
    if (!coll) return cb(null); // Firestore not ready — silently skip

    const maxAge    = sess?.cookie?.maxAge ?? 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + maxAge);

    // Firestore rejects objects with custom prototypes (e.g. express-session's Session class).
    // JSON round-trip strips the prototype and produces a plain serialisable object.
    let plainSess;
    try {
      plainSess = JSON.parse(JSON.stringify(sess));
    } catch (err) {
      console.warn('[SessionStore] session serialisation failed — skipping persist:', err.message);
      return cb(null); // fail-open
    }

    coll.doc(sid).set({ sess: plainSess, expiresAt, updatedAt: new Date() })
      .then(() => cb(null))
      .catch(err => {
        console.warn('[SessionStore] set error (session may not persist):', err.message);
        cb(null); // fail-open
      });
  }

  destroy(sid, cb) {
    const coll = this._coll();
    if (!coll) return cb(null);

    coll.doc(sid).delete()
      .then(() => cb(null))
      .catch(err => {
        console.warn('[SessionStore] destroy error:', err.message);
        cb(null);
      });
  }

  // ── Optional (improves express-session behaviour) ──────────────
  touch(sid, sess, cb) {
    // Reset TTL on active sessions to keep them alive
    this.set(sid, sess, cb);
  }
}

module.exports = { FirestoreSessionStore };

'use strict';
/**
 * quotaTracker.js — In-memory AI provider usage tracker
 *
 * Tracks request + token counts per provider:model pair.
 * Counts reset automatically at midnight UTC (= 5:30 AM IST).
 * NOTE: counts also reset on server restart — this is fine for Render,
 * where server restarts are rare and quota is a daily window anyway.
 *
 * Usage:
 *   const { trackRequest } = require('./quotaTracker');
 *   trackRequest('groq', 'llama-3.3-70b-versatile');
 */

// ── Module-level state ────────────────────────────────────────────
/** @type {Map<string, {requests: number, tokens: number}>} */
const usageCounts    = new Map(); // key: 'provider:model'
let   lastReset      = new Date();
let   resetScheduled = false;

// ── Known free-tier quotas ────────────────────────────────────────
const QUOTAS = {
  gemini: {
    'gemini-2.5-flash':         { requestsPerDay: 1500,  tokensPerMin: null },
    'gemini-2.5-flash-lite':    { requestsPerDay: 1500,  tokensPerMin: null },
    'gemini-3.5-flash':         { requestsPerDay: 1500,  tokensPerMin: null },
    'gemini-3-flash-preview':   { requestsPerDay: 1500,  tokensPerMin: null },
    'gemini-flash-latest':      { requestsPerDay: 1500,  tokensPerMin: null },
    'gemini-flash-lite-latest': { requestsPerDay: 1500,  tokensPerMin: null },
    'gemini-3.1-flash-lite':    { requestsPerDay: 1500,  tokensPerMin: null },
    'gemma-4-31b-it':           { requestsPerDay: 1500,  tokensPerMin: null },
    'gemma-4-26b-a4b-it':       { requestsPerDay: 1500,  tokensPerMin: null },
  },
  groq: {
    'llama-3.3-70b-versatile':          { requestsPerDay: 1000,  tokensPerMin: 6000  },
    'llama-4-scout':                    { requestsPerDay: 1000,  tokensPerMin: 6000  },
    'deepseek-r1-distill-llama-70b':    { requestsPerDay: 1000,  tokensPerMin: 6000  },
    'qwen-qwq-32b':                     { requestsPerDay: 1000,  tokensPerMin: 6000  },
    'llama-3.1-8b-instant':             { requestsPerDay: 14400, tokensPerMin: 20000 },
    'gemma2-9b-it':                     { requestsPerDay: 14400, tokensPerMin: 15000 },
    'mixtral-8x7b-32768':               { requestsPerDay: 14400, tokensPerMin: 5000  },
  },
  cerebras: {
    // Token-based quota — no per-request limit
    'llama3.3-70b':           { requestsPerDay: null, tokensPerDay: 1_000_000 },
    'llama-4-scout-17b-16e':  { requestsPerDay: null, tokensPerDay: 1_000_000 },
    'llama3.1-8b':            { requestsPerDay: null, tokensPerDay: 1_000_000 },
  },
  sambanova: {
    // RPD estimated as RPM × 48 (conservative — 30 min active per hour)
    'Meta-Llama-3.3-70B-Instruct':  { requestsPerDay: 1440, tokensPerMin: null },
    'Qwen2.5-72B-Instruct':         { requestsPerDay: 1440, tokensPerMin: null },
    'Meta-Llama-3.1-405B-Instruct': { requestsPerDay: 480,  tokensPerMin: null },
    'Meta-Llama-3.2-3B-Instruct':   { requestsPerDay: 1440, tokensPerMin: null },
    'Qwen2.5-7B-Instruct':          { requestsPerDay: 1440, tokensPerMin: null },
  },
};

// ── Track a single request ────────────────────────────────────────
/**
 * Increment usage counter for a provider:model pair.
 * @param {string} provider  - 'gemini' | 'groq' | 'cerebras' | 'sambanova'
 * @param {string} model     - exact model name
 * @param {number} [tokensUsed=0] - tokens consumed (optional)
 */
function trackRequest(provider, model, tokensUsed = 0) {
  const key = `${provider}:${model}`;
  if (!usageCounts.has(key)) {
    usageCounts.set(key, { requests: 0, tokens: 0 });
  }
  const entry = usageCounts.get(key);
  entry.requests += 1;
  entry.tokens   += tokensUsed;

  // Ensure the daily reset chain is running
  if (!resetScheduled) scheduleReset();
}

// ── Daily reset scheduler ─────────────────────────────────────────
function scheduleReset() {
  resetScheduled = true;

  // Time until next midnight UTC
  const now       = new Date();
  const nextReset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1, // next day
    0, 0, 0, 0,
  ));
  const msUntilReset = nextReset.getTime() - Date.now();

  setTimeout(() => {
    resetCounts();
  }, msUntilReset);
}

function resetCounts() {
  usageCounts.clear();
  lastReset      = new Date();
  resetScheduled = false;
  console.log('[QuotaTracker] Daily counts reset at midnight UTC');
  // Chain to the next day
  scheduleReset();
}

// ── Reset info ────────────────────────────────────────────────────
function getResetInfo() {
  const now = new Date();

  // Next midnight UTC
  const nextMidnightUTC = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));

  // Convert to IST (UTC+5:30)
  const istOffsetMs    = 5.5 * 60 * 60 * 1000; // 5h 30m in ms
  const nextMidnightIST = new Date(nextMidnightUTC.getTime() + istOffsetMs);

  const msUntilReset      = Math.max(0, nextMidnightUTC.getTime() - now.getTime());
  const hoursUntilReset   = Math.round((msUntilReset / (1000 * 60 * 60)) * 10) / 10;
  const minutesUntilReset = Math.round(msUntilReset / (1000 * 60));

  const h = Math.floor(msUntilReset / (1000 * 60 * 60));
  const m = Math.floor((msUntilReset % (1000 * 60 * 60)) / (1000 * 60));

  // IST display time — midnight UTC = 5:30 AM IST
  const istHour = nextMidnightIST.getUTCHours();
  const istMin  = nextMidnightIST.getUTCMinutes();
  const istLabel = `${istHour}:${String(istMin).padStart(2, '0')} ${istHour < 12 ? 'AM' : 'PM'} IST`;

  return {
    lastReset:        lastReset.toISOString(),
    nextResetUTC:     nextMidnightUTC.toISOString(),
    nextResetIST:     nextMidnightIST.toISOString(),
    hoursUntilReset,
    minutesUntilReset,
    resetLabel:       `Resets in ${h}h ${m}m (${istLabel})`,
  };
}

// ── Per-provider stats ────────────────────────────────────────────
function getProviderStats(provider) {
  const providerQuotas = QUOTAS[provider] || {};

  return Object.entries(providerQuotas).map(([model, quota]) => {
    const key    = `${provider}:${model}`;
    const entry  = usageCounts.get(key) || { requests: 0, tokens: 0 };

    const requestsUsed  = entry.requests;
    const tokensUsed    = entry.tokens;
    const requestsLimit = quota.requestsPerDay ?? null;
    const tokensLimit   = quota.tokensPerDay   ?? null;

    // Compute percent used
    let percentUsed = null;
    if (requestsLimit) {
      percentUsed = Math.min(100, Math.round((requestsUsed / requestsLimit) * 100));
    } else if (tokensLimit) {
      percentUsed = Math.min(100, Math.round((tokensUsed / tokensLimit) * 100));
    }

    // Status classification
    let status = 'healthy';
    if (!requestsLimit && !tokensLimit) {
      status = 'unlimited';
    } else if (percentUsed !== null) {
      if (percentUsed > 90)       status = 'critical';
      else if (percentUsed > 70)  status = 'warning';
    }

    return {
      model,
      requestsUsed,
      requestsLimit,
      tokensUsed,
      tokensLimit,
      percentUsed,
      status,
    };
  });
}

// ── All stats ─────────────────────────────────────────────────────
function getAllStats() {
  return {
    resetInfo: getResetInfo(),
    providers: {
      gemini:    getProviderStats('gemini'),
      groq:      getProviderStats('groq'),
      cerebras:  getProviderStats('cerebras'),
      sambanova: getProviderStats('sambanova'),
    },
  };
}

// ── Start the reset chain on module load ─────────────────────────
scheduleReset();

module.exports = { trackRequest, getAllStats, getResetInfo };

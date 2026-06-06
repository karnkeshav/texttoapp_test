'use strict';
/**
 * geminiPool.js — Multi-SDK, multi-model Gemini fallback pool
 *
 * Confirmed free-tier model status (last tested 2026-05-27):
 *   ✅ new + legacy : gemini-2.5-flash, gemini-2.5-flash-lite, gemini-3.1-flash-lite,
 *                     gemini-flash-lite-latest
 *   ✅ new only     : gemini-3-flash-preview  (legacy gives GoogleGenerativeAI error)
 *   ✅ legacy only  : gemma-4-31b-it, gemma-4-26b-a4b-it  (BAD_REQUEST on new SDK)
 *   ⏳ rate-limited : gemini-3.5-flash, gemini-flash-latest  (429 under load, still usable)
 *   ❌ needs billing: gemini-2.5-pro, gemini-2.0-*, gemini-3-pro-*, gemini-3.1-pro-*,
 *                     antigravity-preview-05-2026
 *   ❌ not found    : gemini-3.1-flash-lite-preview
 *
 * TWO-TIER POOL — every slot has a `tier` property:
 *
 *   tier: 'build'  → highest-quality models; used for app generation, plan analysis,
 *                    code repair, edit mode, and vision/multimodal.
 *                    Models: gemini-2.5-flash, gemini-3.5-flash, gemini-3-flash-preview,
 *                            gemini-flash-latest
 *
 *   tier: 'chat'   → lighter/faster models; used for conversational intents
 *                    (chat, reasoning, conversion). Gemma included here.
 *                    Falls back to build-tier models when all chat slots are exhausted.
 *                    Models: gemini-2.5-flash-lite, gemini-3.1-flash-lite,
 *                            gemini-flash-lite-latest, gemma-4-31b-it, gemma-4-26b-a4b-it
 *
 * Callers pass `tier: 'build'` (default) or `tier: 'chat'` to pooledStream/pooledGenerate.
 * Vision/multimodal callers also pass `multimodal: true` which restricts to new-SDK slots
 * (legacy SDK cannot handle inlineData parts).
 *
 * Pool behaviour:
 *   - Tries slots in order on every call (first = highest priority within tier)
 *   - On 429 / quota error: marks that slot cooling for COOLDOWN_MS, tries next slot
 *   - On 404 / permanent error: marks slot dead for this process lifetime
 *   - On full primary exhaustion: chat falls back to build tier; build waits cooldown
 *   - Billing-enabled models: uncomment entries in the BILLING section below
 */

const { GoogleGenAI }        = require('@google/genai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { trackRequest }       = require('./quotaTracker');
const { isStreamTruncated }  = require('./truncationDetector');

// ── Pool configuration ────────────────────────────────────────────────────────
// tier: 'build' → app generation, plan analysis, code repair, vision
// tier: 'chat'  → conversational intents (lightweight, fast)
// mode: 'generate' | 'stream'
const POOL_CONFIG = [

  // ════════════════════════════════════════════════════════════════════════════
  // BUILD TIER — highest-quality models for code generation + reasoning
  // Priority: highest token ceiling first (gemini-3-flash-preview, then 2.5-flash)
  // ════════════════════════════════════════════════════════════════════════════

  { sdk: 'new',    model: 'gemini-3-flash-preview',   mode: 'stream',   tier: 'build' },
  { sdk: 'new',    model: 'gemini-3-flash-preview',   mode: 'generate', tier: 'build' },
  { sdk: 'new',    model: 'gemini-2.5-flash',         mode: 'stream',   tier: 'build' },
  { sdk: 'new',    model: 'gemini-2.5-flash',         mode: 'generate', tier: 'build' },
  { sdk: 'legacy', model: 'gemini-2.5-flash',         mode: 'stream',   tier: 'build' },
  { sdk: 'legacy', model: 'gemini-2.5-flash',         mode: 'generate', tier: 'build' },
  { sdk: 'new',    model: 'gemini-3.5-flash',         mode: 'stream',   tier: 'build' },
  { sdk: 'new',    model: 'gemini-3.5-flash',         mode: 'generate', tier: 'build' },
  { sdk: 'legacy', model: 'gemini-3.5-flash',         mode: 'stream',   tier: 'build' },
  { sdk: 'legacy', model: 'gemini-3.5-flash',         mode: 'generate', tier: 'build' },
  { sdk: 'new',    model: 'gemini-flash-latest',      mode: 'stream',   tier: 'build' },
  { sdk: 'new',    model: 'gemini-flash-latest',      mode: 'generate', tier: 'build' },
  { sdk: 'legacy', model: 'gemini-flash-latest',      mode: 'stream',   tier: 'build' },
  { sdk: 'legacy', model: 'gemini-flash-latest',      mode: 'generate', tier: 'build' },

  // ════════════════════════════════════════════════════════════════════════════
  // CHAT TIER — lightweight models for conversational / reasoning / conversion
  // All lite models confirmed working. Gemma legacy-only (new SDK: BAD_REQUEST).
  // When all chat slots are exhausted, pooledStream/pooledGenerate auto-fall back
  // to build-tier models (handled in the loop logic below).
  // ════════════════════════════════════════════════════════════════════════════

  { sdk: 'new',    model: 'gemini-2.5-flash-lite',    mode: 'generate', tier: 'chat' },
  { sdk: 'new',    model: 'gemini-2.5-flash-lite',    mode: 'stream',   tier: 'chat' },
  { sdk: 'legacy', model: 'gemini-2.5-flash-lite',    mode: 'generate', tier: 'chat' },
  { sdk: 'legacy', model: 'gemini-2.5-flash-lite',    mode: 'stream',   tier: 'chat' },

  { sdk: 'new',    model: 'gemini-3.1-flash-lite',    mode: 'generate', tier: 'chat' },
  { sdk: 'new',    model: 'gemini-3.1-flash-lite',    mode: 'stream',   tier: 'chat' },
  { sdk: 'legacy', model: 'gemini-3.1-flash-lite',    mode: 'generate', tier: 'chat' },
  { sdk: 'legacy', model: 'gemini-3.1-flash-lite',    mode: 'stream',   tier: 'chat' },

  { sdk: 'new',    model: 'gemini-flash-lite-latest', mode: 'generate', tier: 'chat' },
  { sdk: 'new',    model: 'gemini-flash-lite-latest', mode: 'stream',   tier: 'chat' },
  { sdk: 'legacy', model: 'gemini-flash-lite-latest', mode: 'generate', tier: 'chat' },
  { sdk: 'legacy', model: 'gemini-flash-lite-latest', mode: 'stream',   tier: 'chat' },

  // Gemma — open-source; legacy SDK only
  { sdk: 'legacy', model: 'gemma-4-31b-it',           mode: 'generate', tier: 'chat' },
  { sdk: 'legacy', model: 'gemma-4-31b-it',           mode: 'stream',   tier: 'chat' },
  { sdk: 'legacy', model: 'gemma-4-26b-a4b-it',       mode: 'generate', tier: 'chat' },
  { sdk: 'legacy', model: 'gemma-4-26b-a4b-it',       mode: 'stream',   tier: 'chat' },

  // ── Billing-enabled (uncomment when a payment method is added) ────────────
  // { sdk: 'new',    model: 'gemini-2.5-pro',           mode: 'generate', tier: 'build' },
  // { sdk: 'new',    model: 'gemini-2.5-pro',           mode: 'stream',   tier: 'build' },
  // { sdk: 'new',    model: 'gemini-2.0-flash',         mode: 'generate', tier: 'build' },
  // { sdk: 'new',    model: 'gemini-2.0-flash',         mode: 'stream',   tier: 'build' },
  // { sdk: 'new',    model: 'gemini-3.1-pro-preview',   mode: 'generate', tier: 'build' },
  // { sdk: 'new',    model: 'gemini-3.1-pro-preview',   mode: 'stream',   tier: 'build' },
];

const COOLDOWN_MS = 60_000; // 1 min cooldown after 429

// ── Slot state tracking ───────────────────────────────────────────
const slotState = POOL_CONFIG.map(() => ({
  coolUntil: 0,  // epoch ms — 0 means available
  dead:      false, // 404 / permanent error
}));

function isAvailable(i) {
  return !slotState[i].dead && Date.now() >= slotState[i].coolUntil;
}

function markCooling(i) {
  slotState[i].coolUntil = Date.now() + COOLDOWN_MS;
  const slot = POOL_CONFIG[i];
  console.warn(`[GeminiPool] Slot ${i} (${slot.sdk}/${slot.model}) cooling for ${COOLDOWN_MS / 1000}s`);
}

function markDead(i) {
  slotState[i].dead = true;
  const slot = POOL_CONFIG[i];
  console.error(`[GeminiPool] Slot ${i} (${slot.sdk}/${slot.model}) marked dead — will not retry`);
}

function isQuotaError(err) {
  const msg = err?.message || String(err);
  return msg.includes('"code":429') || msg.includes('429') ||
         msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') ||
         err?.status === 429;
}

function isNotFound(err) {
  const msg = err?.message || String(err);
  return msg.includes('"code":404') || msg.includes('NOT_FOUND') ||
         msg.includes('no longer available') || msg.includes('not found for API');
}

// BAD_REQUEST (400) — model doesn't support the requested config (e.g. Gemma + JSON mode)
// Mark dead so we skip it for this process run rather than throwing to the user.
function isBadRequest(err) {
  const msg = err?.message || String(err);
  return msg.includes('"code":400') || msg.includes('BAD_REQUEST') ||
         msg.includes('Invalid JSON') || msg.includes('response_mime_type');
}

// PERMISSION_DENIED (403) or invalid API key for a specific model.
// Treat as temporary cooldown — the key may still work for other models/endpoints.
function isPermissionError(err) {
  const msg = err?.message || String(err);
  return msg.includes('"code":403') || msg.includes('PERMISSION_DENIED') ||
         msg.includes('API_KEY_INVALID') || err?.status === 403;
}

// ── Helpers to extract text from SDK responses ────────────────────
function extractText(response, sdk) {
  if (sdk === 'legacy') {
    // Legacy SDK: response.response.text() is a function
    return typeof response?.response?.text === 'function'
      ? response.response.text()
      : '';
  }
  // New SDK: .text getter (works with thinkingBudget:0), fallback to candidates
  return response?.text
    ?? response?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text
    ?? '';
}

// ── Per-SDK generateContent wrappers ─────────────────────────────
async function newSDKGenerate(model, contents, config, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  return ai.models.generateContent({
    model,
    contents,
    config: { ...config, thinkingConfig: { thinkingBudget: 0 } },
  });
}

async function legacySDKGenerate(model, contents, config, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: {
      maxOutputTokens: config.maxOutputTokens,
      temperature:     config.temperature,
      ...(config.responseMimeType ? { responseMimeType: config.responseMimeType } : {}),
    },
  });
  // Legacy SDK expects a flat string or Content[] — convert
  const prompt = Array.isArray(contents)
    ? contents.map(c => c.parts.map(p => p.text).join('')).join('\n')
    : contents;
  return m.generateContent(prompt);
}

// ── Per-SDK generateContentStream wrappers ───────────────────────
async function newSDKStream(model, contents, config, apiKey, systemInstruction) {
  const ai = new GoogleGenAI({ apiKey });
  return ai.models.generateContentStream({
    model,
    contents,
    config: { ...config, systemInstruction },
  });
}

async function legacySDKStream(model, contents, config, apiKey, systemInstruction) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({
    model,
    systemInstruction,
    generationConfig: {
      maxOutputTokens: config.maxOutputTokens,
      temperature:     config.temperature,
    },
  });
  const prompt = Array.isArray(contents)
    ? contents.map(c => c.parts.map(p => p.text).join('')).join('\n')
    : contents;
  const result = await m.generateContentStream(prompt);
  // Wrap legacy stream to match new SDK's async iterable interface
  return {
    [Symbol.asyncIterator]: async function* () {
      for await (const chunk of result.stream) {
        yield { text: chunk.text() };
      }
    },
  };
}

// ── Slot selector ─────────────────────────────────────────────────
/**
 * Returns the ordered slot list for a given (mode, tier, multimodal) combination.
 * Chat tier: primary chat slots first, then build slots as automatic fallback.
 * Build tier: build slots only (no chat fallback — build needs best quality).
 * multimodal: restricts to new-SDK slots (legacy wrapper drops inlineData).
 */
function selectSlots(mode, tier, multimodal) {
  const all = POOL_CONFIG.map((slot, i) => ({ slot, i }));
  const matches = (t) => (s) =>
    s.slot.mode === mode &&
    s.slot.tier === t &&
    (!multimodal || s.slot.sdk === 'new');

  if (tier === 'chat') {
    // Try chat-tier slots first, then fall back to build-tier
    return [...all.filter(matches('chat')), ...all.filter(matches('build'))];
  }
  return all.filter(matches('build'));
}

// ── Public: one-shot generation (plan phase, repair pass, diagnose) ─
/**
 * Tries generate slots in order, falls back on quota errors.
 * @param {object} opts
 * @param {Array}  opts.contents   - [{role, parts:[{text}]}]
 * @param {object} opts.config     - {temperature, maxOutputTokens, ...}
 * @param {string} opts.apiKey
 * @param {string} [opts.tier]     - 'build' (default) | 'chat'
 * @returns {Promise<string>}      - extracted text
 */
async function pooledGenerate({ contents, config, apiKey, tier = 'build' }) {
  const generateSlots = selectSlots('generate', tier, false);

  // First pass — try available slots
  for (const { slot, i } of generateSlots) {
    if (!isAvailable(i)) continue;
    try {
      const raw = slot.sdk === 'new'
        ? await newSDKGenerate(slot.model, contents, config, apiKey)
        : await legacySDKGenerate(slot.model, contents, config, apiKey);
      const text = extractText(raw, slot.sdk);
      console.log(`[GeminiPool] generate ✅ slot ${i} (${slot.sdk}/${slot.model}) [${slot.tier}]`);
      trackRequest('gemini', slot.model);
      return text;
    } catch (err) {
      if (isQuotaError(err))      { markCooling(i); continue; }
      if (isNotFound(err))        { markDead(i);    continue; }
      if (isBadRequest(err))      { markDead(i);    continue; } // e.g. Gemma + JSON mode
      if (isPermissionError(err)) { markCooling(i); continue; }
      // Unexpected error: log and try next slot rather than surfacing immediately
      console.warn(`[GeminiPool] Slot ${i} (${slot.sdk}/${slot.model}) unexpected error: ${err.message} — trying next slot`);
    }
  }

  // Second pass — wait out the shortest cooldown and retry once
  const cooling = generateSlots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[GeminiPool] All generate slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i} [${slot.tier}]`);
    await new Promise(r => setTimeout(r, wait + 500));
    try {
      const raw = slot.sdk === 'new'
        ? await newSDKGenerate(slot.model, contents, config, apiKey)
        : await legacySDKGenerate(slot.model, contents, config, apiKey);
      const text = extractText(raw, slot.sdk);
      console.log(`[GeminiPool] generate ✅ slot ${i} after cooldown`);
      return text;
    } catch (err) {
      if (isQuotaError(err)) markCooling(i);
    }
  }

  const err = new Error('All Gemini pool slots exhausted — quota exceeded on all models/SDKs');
  err.code = 'GEMINI_POOL_EXHAUSTED';
  throw err;
}

// ── Public: streaming generation (main chat) ─────────────────────
/**
 * Streams through pool slots. Falls back to next slot on quota error.
 * @param {object}   opts
 * @param {Array}    opts.contents
 * @param {object}   opts.config
 * @param {string}   opts.apiKey
 * @param {string}   opts.systemInstruction
 * @param {Function} opts.onChunk      - (text: string) => void
 * @param {Function} opts.onDone       - (fullText: string) => void
 * @param {string}   [opts.tier]       - 'build' (default) | 'chat'
 * @param {boolean}  [opts.multimodal] - true = new-SDK slots only (inlineData support)
 */
async function pooledStream({ contents, config, apiKey, systemInstruction, onChunk, onDone, tier = 'build', multimodal = false }) {
  const streamSlots = selectSlots('stream', tier, multimodal);

  for (const { slot, i } of streamSlots) {
    if (!isAvailable(i)) continue;
    let fullText = '';
    try {
      const stream = slot.sdk === 'new'
        ? await newSDKStream(slot.model, contents, config, apiKey, systemInstruction)
        : await legacySDKStream(slot.model, contents, config, apiKey, systemInstruction);

      for await (const chunk of stream) {
        const text = chunk.text || '';
        if (text) { fullText += text; onChunk(text); }
      }
      if (isStreamTruncated(fullText)) {
        console.warn(`[GeminiPool] Slot ${i} (${slot.sdk}/${slot.model}) output truncated — escalating to fallback chain`);
        // Do not try other Gemini slots — same ceiling. Exit pool immediately.
        const err = new Error('Gemini output truncated — escalating to higher-token fallback');
        err.code = 'GEMINI_POOL_EXHAUSTED';
        throw err;
      }
      console.log(`[GeminiPool] stream ✅ slot ${i} (${slot.sdk}/${slot.model}) [${slot.tier}]`);
      trackRequest('gemini', slot.model);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err))      { markCooling(i); continue; }
      if (isNotFound(err))        { markDead(i);    continue; }
      if (isBadRequest(err))      { markDead(i);    continue; }
      if (isPermissionError(err)) { markCooling(i); continue; }
      // Unexpected error — if no content was streamed yet, try the next slot.
      // If content was partially sent we can't safely restart, so surface the error.
      if (fullText.length === 0) {
        console.warn(`[GeminiPool] Slot ${i} (${slot.sdk}/${slot.model}) unexpected error: ${err.message} — trying next slot`);
        continue;
      }
      throw err;
    }
  }

  // Cooldown wait fallback — wait out the shortest cooldown across all selected slots
  const cooling = streamSlots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[GeminiPool] All stream slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i} [${slot.tier}]`);
    await new Promise(r => setTimeout(r, wait + 500));
    try {
      const stream = slot.sdk === 'new'
        ? await newSDKStream(slot.model, contents, config, apiKey, systemInstruction)
        : await legacySDKStream(slot.model, contents, config, apiKey, systemInstruction);
      let fullText = '';
      for await (const chunk of stream) {
        const text = chunk.text || '';
        if (text) { fullText += text; onChunk(text); }
      }
      if (isStreamTruncated(fullText)) {
        console.warn(`[GeminiPool] Cooldown slot ${i} (${slot.sdk}/${slot.model}) output truncated — escalating to fallback`);
        const err = new Error('Gemini output truncated — escalating to higher-token fallback');
        err.code = 'GEMINI_POOL_EXHAUSTED';
        throw err;
      }
      console.log(`[GeminiPool] stream ✅ slot ${i} after cooldown`);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err)) markCooling(i);
    }
  }

  const err = new Error('All Gemini stream pool slots exhausted — quota exceeded on all models/SDKs');
  err.code = 'GEMINI_POOL_EXHAUSTED';
  throw err;
}

// ── Pool status (for diagnose endpoint) ──────────────────────────
function poolStatus() {
  return POOL_CONFIG.map((slot, i) => ({
    slot: i,
    sdk:   slot.sdk,
    model: slot.model,
    mode:  slot.mode,
    tier:  slot.tier,
    available: isAvailable(i),
    dead: slotState[i].dead,
    coolUntil: slotState[i].coolUntil > Date.now()
      ? new Date(slotState[i].coolUntil).toISOString()
      : null,
  }));
}

module.exports = { pooledGenerate, pooledStream, poolStatus };

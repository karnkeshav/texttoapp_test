'use strict';
/**
 * geminiPool.js — Multi-SDK, multi-model Gemini fallback pool
 *
 * Discovery results (scripts/discover-models.js — run to refresh):
 *   ✅ Free-tier, both SDKs:  gemini-3.5-flash, gemini-2.5-flash, gemini-3.1-flash-lite,
 *                              gemini-3-flash-preview, gemini-2.5-flash-lite,
 *                              gemini-flash-latest, gemini-flash-lite-latest
 *   ✅ Legacy SDK only:       gemma-4-31b-it, gemma-4-26b-a4b-it  (BAD_REQUEST on new SDK)
 *   ❌ Needs billing:         gemini-2.5-pro, gemini-2.0-*, gemini-3-pro-*, gemini-3.1-pro-*
 *   ❌ Not found:             gemini-3.1-flash-lite-preview
 *
 * Pool behaviour:
 *   - Tries slots in order on every call (first = highest priority)
 *   - On 429 / quota error: marks that slot cooling for COOLDOWN_MS, tries next slot
 *   - On 404 / permanent error: marks slot dead for this process lifetime
 *   - On full exhaustion: waits out shortest cooldown and retries once
 *   - Each model has its OWN per-minute quota — 9 working models = 9× the capacity
 *
 * To add billing-enabled models: uncomment entries in the BILLING section below.
 */

const { GoogleGenAI }        = require('@google/genai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Pool configuration ────────────────────────────────────────────────────────
// Order = priority. Earlier = tried first. Each model has independent quota.
// generate = one-shot (plan phase, code repair)   stream = SSE chat
const POOL_CONFIG = [

  // ── Tier 1: Newest / highest-capability flash models ─────────────────────
  { sdk: 'new',    model: 'gemini-3.5-flash',       mode: 'generate' },
  { sdk: 'new',    model: 'gemini-3.5-flash',       mode: 'stream'   },
  { sdk: 'legacy', model: 'gemini-3.5-flash',       mode: 'generate' },
  { sdk: 'legacy', model: 'gemini-3.5-flash',       mode: 'stream'   },

  { sdk: 'new',    model: 'gemini-2.5-flash',       mode: 'generate' },
  { sdk: 'new',    model: 'gemini-2.5-flash',       mode: 'stream'   },
  { sdk: 'legacy', model: 'gemini-2.5-flash',       mode: 'generate' },
  { sdk: 'legacy', model: 'gemini-2.5-flash',       mode: 'stream'   },

  { sdk: 'new',    model: 'gemini-3.1-flash-lite',  mode: 'generate' },
  { sdk: 'new',    model: 'gemini-3.1-flash-lite',  mode: 'stream'   },
  { sdk: 'legacy', model: 'gemini-3.1-flash-lite',  mode: 'generate' },
  { sdk: 'legacy', model: 'gemini-3.1-flash-lite',  mode: 'stream'   },

  { sdk: 'new',    model: 'gemini-3-flash-preview',  mode: 'generate' },
  { sdk: 'new',    model: 'gemini-3-flash-preview',  mode: 'stream'   },
  { sdk: 'legacy', model: 'gemini-3-flash-preview',  mode: 'generate' },
  { sdk: 'legacy', model: 'gemini-3-flash-preview',  mode: 'stream'   },

  // ── Tier 2: Lighter / alias models ───────────────────────────────────────
  { sdk: 'new',    model: 'gemini-2.5-flash-lite',  mode: 'generate' },
  { sdk: 'new',    model: 'gemini-2.5-flash-lite',  mode: 'stream'   },
  { sdk: 'legacy', model: 'gemini-2.5-flash-lite',  mode: 'generate' },
  { sdk: 'legacy', model: 'gemini-2.5-flash-lite',  mode: 'stream'   },

  { sdk: 'new',    model: 'gemini-flash-latest',    mode: 'generate' },
  { sdk: 'new',    model: 'gemini-flash-latest',    mode: 'stream'   },
  { sdk: 'legacy', model: 'gemini-flash-latest',    mode: 'generate' },
  { sdk: 'legacy', model: 'gemini-flash-latest',    mode: 'stream'   },

  { sdk: 'new',    model: 'gemini-flash-lite-latest', mode: 'generate' },
  { sdk: 'new',    model: 'gemini-flash-lite-latest', mode: 'stream'   },
  { sdk: 'legacy', model: 'gemini-flash-lite-latest', mode: 'generate' },
  { sdk: 'legacy', model: 'gemini-flash-lite-latest', mode: 'stream'   },

  // ── Tier 3: Gemma open-source (legacy SDK only — new SDK returns BAD_REQUEST)
  { sdk: 'legacy', model: 'gemma-4-31b-it',          mode: 'generate' },
  { sdk: 'legacy', model: 'gemma-4-31b-it',          mode: 'stream'   },
  { sdk: 'legacy', model: 'gemma-4-26b-a4b-it',      mode: 'generate' },
  { sdk: 'legacy', model: 'gemma-4-26b-a4b-it',      mode: 'stream'   },

  // ── Billing-enabled (uncomment when you add a payment method) ────────────
  // { sdk: 'new',    model: 'gemini-2.5-pro',          mode: 'generate' },
  // { sdk: 'new',    model: 'gemini-2.5-pro',          mode: 'stream'   },
  // { sdk: 'new',    model: 'gemini-2.0-flash',        mode: 'generate' },
  // { sdk: 'new',    model: 'gemini-2.0-flash',        mode: 'stream'   },
  // { sdk: 'new',    model: 'gemini-3.1-pro-preview',  mode: 'generate' },
  // { sdk: 'new',    model: 'gemini-3.1-pro-preview',  mode: 'stream'   },
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

// ── Public: one-shot generation (plan phase, repair pass, diagnose) ─
/**
 * Tries generate slots in order, falls back on quota errors.
 * @param {object} opts
 * @param {Array}  opts.contents   - [{role, parts:[{text}]}]
 * @param {object} opts.config     - {temperature, maxOutputTokens, ...}
 * @param {string} opts.apiKey
 * @returns {Promise<string>}      - extracted text
 */
async function pooledGenerate({ contents, config, apiKey }) {
  const generateSlots = POOL_CONFIG
    .map((slot, i) => ({ slot, i }))
    .filter(({ slot }) => slot.mode === 'generate');

  // First pass — try available slots
  for (const { slot, i } of generateSlots) {
    if (!isAvailable(i)) continue;
    try {
      const raw = slot.sdk === 'new'
        ? await newSDKGenerate(slot.model, contents, config, apiKey)
        : await legacySDKGenerate(slot.model, contents, config, apiKey);
      const text = extractText(raw, slot.sdk);
      console.log(`[GeminiPool] generate ✅ slot ${i} (${slot.sdk}/${slot.model})`);
      return text;
    } catch (err) {
      if (isQuotaError(err))  { markCooling(i); continue; }
      if (isNotFound(err))    { markDead(i);    continue; }
      if (isBadRequest(err))  { markDead(i);    continue; } // e.g. Gemma + JSON mode
      throw err; // unexpected — surface immediately
    }
  }

  // Second pass — wait out the shortest cooldown and retry once
  const cooling = generateSlots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[GeminiPool] All slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i}`);
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
 * @param {object} opts
 * @param {Array}  opts.contents
 * @param {object} opts.config
 * @param {string} opts.apiKey
 * @param {string} opts.systemInstruction
 * @param {Function} opts.onChunk     - (text: string) => void
 * @param {Function} opts.onDone      - (fullText: string) => void
 * @param {boolean}  opts.multimodal  - when true, only use new-SDK slots (inlineData support)
 */
async function pooledStream({ contents, config, apiKey, systemInstruction, onChunk, onDone, multimodal = false }) {
  const streamSlots = POOL_CONFIG
    .map((slot, i) => ({ slot, i }))
    .filter(({ slot }) => slot.mode === 'stream' && (!multimodal || slot.sdk === 'new'));

  for (const { slot, i } of streamSlots) {
    if (!isAvailable(i)) continue;
    try {
      const stream = slot.sdk === 'new'
        ? await newSDKStream(slot.model, contents, config, apiKey, systemInstruction)
        : await legacySDKStream(slot.model, contents, config, apiKey, systemInstruction);

      let fullText = '';
      for await (const chunk of stream) {
        const text = chunk.text || '';
        if (text) { fullText += text; onChunk(text); }
      }
      console.log(`[GeminiPool] stream ✅ slot ${i} (${slot.sdk}/${slot.model})`);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err))  { markCooling(i); continue; }
      if (isNotFound(err))    { markDead(i);    continue; }
      if (isBadRequest(err))  { markDead(i);    continue; }
      throw err;
    }
  }

  // Cooldown wait fallback (same as generate)
  const cooling = streamSlots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[GeminiPool] All stream slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i}`);
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
    sdk:  slot.sdk,
    model: slot.model,
    mode: slot.mode,
    available: isAvailable(i),
    dead: slotState[i].dead,
    coolUntil: slotState[i].coolUntil > Date.now()
      ? new Date(slotState[i].coolUntil).toISOString()
      : null,
  }));
}

module.exports = { pooledGenerate, pooledStream, poolStatus };

'use strict';
/**
 * groqPool.js — Multi-model Groq fallback pool
 *
 * Mirrors the slot/cooldown pattern of geminiPool.js exactly.
 * Called by antigravity.js after Gemini pool is exhausted.
 *
 * Two-tier pool:
 *   tier: 'build' → high-quality 70B models for app generation
 *   tier: 'chat'  → lighter 8B/9B models for conversational intents
 *
 * Requires env var: GROQ_API_KEY
 */

const Groq = require('groq-sdk');
const { trackRequest, updateServerLimits } = require('./quotaTracker');
const { isStreamTruncated } = require('./truncationDetector');

// ── Pool configuration ────────────────────────────────────────────
// Each model has its own independent quota — the key advantage of pooling.
// All models: 131072 context window
const POOL_CONFIG = [

  // ── BUILD TIER — high-quality 70B+ models (ordered by token capacity) ────
  // llama-3.3-70b-versatile: RPD 1,000 RPM 30 TPM 6,000
  { model: 'llama-3.3-70b-versatile',                        mode: 'stream',   tier: 'build' },
  { model: 'llama-3.3-70b-versatile',                        mode: 'generate', tier: 'build' },

  // meta-llama/llama-4-scout-17b-16e-instruct: RPD 1,000 RPM 30 TPM 6,000
  { model: 'meta-llama/llama-4-scout-17b-16e-instruct',      mode: 'stream',   tier: 'build' },
  { model: 'meta-llama/llama-4-scout-17b-16e-instruct',      mode: 'generate', tier: 'build' },

  // qwen/qwen3-32b: RPD 1,000 RPM 30 TPM 6,000
  { model: 'qwen/qwen3-32b',                                 mode: 'stream',   tier: 'build' },
  { model: 'qwen/qwen3-32b',                                 mode: 'generate', tier: 'build' },

  // openai/gpt-oss-120b: RPD 1,000 RPM 30 TPM 6,000
  { model: 'openai/gpt-oss-120b',                            mode: 'stream',   tier: 'build' },
  { model: 'openai/gpt-oss-120b',                            mode: 'generate', tier: 'build' },

  // openai/gpt-oss-20b: RPD 1,000 RPM 30 TPM 6,000 (extra capacity)
  { model: 'openai/gpt-oss-20b',                             mode: 'stream',   tier: 'build' },
  { model: 'openai/gpt-oss-20b',                             mode: 'generate', tier: 'build' },

  // ── CHAT TIER — lighter models, higher quota ──────────────────────
  // llama-3.1-8b-instant: RPD 14,400 RPM 30 TPM 20,000
  { model: 'llama-3.1-8b-instant',                           mode: 'stream',   tier: 'chat' },
  { model: 'llama-3.1-8b-instant',                           mode: 'generate', tier: 'chat' },

  // openai/gpt-oss-20b: RPD 1,000 RPM 30 TPM 6,000
  { model: 'openai/gpt-oss-20b',                             mode: 'stream',   tier: 'chat' },
  { model: 'openai/gpt-oss-20b',                             mode: 'generate', tier: 'chat' },
];

const COOLDOWN_MS = 60_000; // 1 min cooldown after 429

// ── Slot state tracking (mirrors geminiPool.js exactly) ───────────
const slotState = POOL_CONFIG.map(() => ({
  coolUntil: 0,   // epoch ms — 0 means available
  dead:      false, // permanent error (404 / bad model)
}));

function isAvailable(i) {
  return !slotState[i].dead && Date.now() >= slotState[i].coolUntil;
}

function markCooling(i) {
  slotState[i].coolUntil = Date.now() + COOLDOWN_MS;
  const slot = POOL_CONFIG[i];
  console.warn(`[GroqPool] Slot ${i} (${slot.model}) cooling for ${COOLDOWN_MS / 1000}s`);
}

function markDead(i) {
  slotState[i].dead = true;
  const slot = POOL_CONFIG[i];
  console.error(`[GroqPool] Slot ${i} (${slot.model}) marked dead — will not retry`);
}

// ── Error classification ──────────────────────────────────────────
function isQuotaError(err) {
  const msg  = err?.message || String(err);
  const code = err?.error?.code || err?.code || '';
  return err?.status === 429 ||
         msg.includes('429') ||
         String(code).includes('rate_limit_exceeded') ||
         String(code).toUpperCase().includes('RATE_LIMIT');
}

function isNotFound(err) {
  const msg  = err?.message || String(err);
  const code = err?.error?.code || err?.code || '';
  return err?.status === 404 ||
         msg.includes('404') ||
         String(code).includes('model_not_found') ||
         String(code).toUpperCase().includes('NOT_FOUND');
}

function isBadRequest(err) {
  const msg = err?.message || String(err);
  return err?.status === 400 ||
         msg.includes('400') ||
         (err?.error?.type || '').includes('invalid_request_error');
}

// ── Convert Gemini contents format → Groq/OpenAI messages ─────────
// Gemini: [{role:'user'|'model', parts:[{text:'...'}]}]
// Groq:   [{role:'user'|'assistant', content:'...'}]
function toGroqMessages(contents) {
  return contents.map(c => ({
    role:    c.role === 'model' ? 'assistant' : c.role,
    content: (c.parts || []).map(p => p.text || '').join(''),
  }));
}

// ── Slot selector (mirrors geminiPool.js selectSlots exactly) ─────
function selectSlots(mode, tier) {
  const all      = POOL_CONFIG.map((slot, i) => ({ slot, i }));
  const matches  = (t) => (s) => s.slot.mode === mode && s.slot.tier === t;

  if (tier === 'chat') {
    // Try chat-tier first, then fall back to build-tier
    return [...all.filter(matches('chat')), ...all.filter(matches('build'))];
  }
  return all.filter(matches('build'));
}

// ── Public: one-shot generation ───────────────────────────────────
async function groqGenerate({ contents, config, apiKey, tier = 'build' }) {
  const key      = apiKey || process.env.GROQ_API_KEY;
  const groq     = new Groq({ apiKey: key });
  const messages = toGroqMessages(contents);
  const slots    = selectSlots('generate', tier);

     // DIAGNOSTIC
    const _sysTokens = Math.ceil((systemInstruction || '').length / 4);
    const _msgTokens = Math.ceil(JSON.stringify(messages).length / 4);
    console.log('[DIAGNOSTIC] sys tokens:', _sysTokens, '| msg tokens:', _msgTokens, '| msg count:', messages.length);
    // END DIAGNOSTIC
  
  // First pass — available slots
  for (const { slot, i } of slots) {
    if (!isAvailable(i)) continue;
    try {
      const { data: resp, response: httpResp } = await groq.chat.completions.create({
        model:       slot.model,
        messages,
        max_tokens:  config?.maxOutputTokens || 8192,
        temperature: config?.temperature     ?? 0.7,
        stream:      false,
      }).withResponse();
      const text = resp.choices?.[0]?.message?.content || '';
      console.log(`[GroqPool] generate ✅ slot ${i} (${slot.model}) [${slot.tier}]`);
      trackRequest('groq', slot.model);
      updateServerLimits('groq', slot.model, httpResp.headers);
      return text;
    } catch (err) {
      if (isQuotaError(err))  { markCooling(i); continue; }
      if (isNotFound(err))    { markDead(i);    continue; }
      if (isBadRequest(err))  { markDead(i);    continue; }
      console.warn(`[GroqPool] Slot ${i} (${slot.model}) unexpected error: ${err.message} — trying next slot`);
    }
  }

  // Second pass — wait out shortest cooldown
  const cooling = slots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[GroqPool] All generate slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i}`);
    await new Promise(r => setTimeout(r, wait + 500));
    try {
      const resp = await groq.chat.completions.create({
        model:       slot.model,
        messages,
        max_tokens:  config?.maxOutputTokens || 8192,
        temperature: config?.temperature     ?? 0.7,
        stream:      false,
      });
      const text = resp.choices?.[0]?.message?.content || '';
      console.log(`[GroqPool] generate ✅ slot ${i} after cooldown`);
      return text;
    } catch (err) {
      if (isQuotaError(err)) markCooling(i);
    }
  }

  const err = new Error('All Groq pool generate slots exhausted');
  err.code  = 'GROQ_POOL_EXHAUSTED';
  throw err;
}

// ── Public: streaming generation ─────────────────────────────────
async function groqStream({ contents, config, apiKey, systemInstruction, onChunk, onDone, tier = 'build' }) {
  const key   = apiKey || process.env.GROQ_API_KEY;
  const groq  = new Groq({ apiKey: key });
  const slots = selectSlots('stream', tier);

  // Build messages — prepend system instruction if provided
  const baseMessages = toGroqMessages(contents);
  const messages     = systemInstruction
    ? [{ role: 'system', content: systemInstruction }, ...baseMessages]
    : baseMessages;

  for (const { slot, i } of slots) {
    if (!isAvailable(i)) continue;
    let fullText = '';
    try {
      const { data: stream, response: httpResp } = await groq.chat.completions.create({
        model:       slot.model,
        messages,
        max_tokens:  config?.maxOutputTokens || 32768,
        temperature: config?.temperature     ?? 0.7,
        stream:      true,
      }).withResponse();

      for await (const chunk of stream) {
        const text = chunk.choices?.[0]?.delta?.content || '';
        if (text) { fullText += text; onChunk(text); }
      }
      // Check finish_reason from last chunk — 'length' means token limit hit
      const lastChunkReason = stream?.finalChatCompletion?.choices?.[0]?.finish_reason;
      if (lastChunkReason === 'length' || isStreamTruncated(fullText)) {
        console.warn(`[GroqPool] Slot ${i} (${slot.model}) hit token limit — trying next Groq slot`);
        continue; // try next Groq model — they have different ceilings
      }
      console.log(`[GroqPool] stream ✅ slot ${i} (${slot.model}) [${slot.tier}]`);
      trackRequest('groq', slot.model);
      updateServerLimits('groq', slot.model, httpResp.headers);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err))  { markCooling(i); continue; }
      if (isNotFound(err))    { markDead(i);    continue; }
      if (isBadRequest(err))  { markDead(i);    continue; }
      if (fullText.length === 0) {
        console.warn(`[GroqPool] Slot ${i} (${slot.model}) unexpected error: ${err.message} — trying next slot`);
        continue;
      }
      throw err;
    }
  }

  // Cooldown wait fallback
  const cooling = slots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[GroqPool] All stream slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i}`);
    await new Promise(r => setTimeout(r, wait + 500));
    try {
      const stream = await groq.chat.completions.create({
        model:       slot.model,
        messages,
        max_tokens:  config?.maxOutputTokens || 32768,
        temperature: config?.temperature     ?? 0.7,
        stream:      true,
      });
      let fullText = '';
      for await (const chunk of stream) {
        const text = chunk.choices?.[0]?.delta?.content || '';
        if (text) { fullText += text; onChunk(text); }
      }
      if (isStreamTruncated(fullText)) {
        console.warn(`[GroqPool] Cooldown slot ${i} (${slot.model}) truncated — all slots exhausted`);
        const err = new Error('All Groq pool stream slots exhausted (truncation detected)');
        err.code = 'GROQ_POOL_EXHAUSTED';
        throw err;
      }
      console.log(`[GroqPool] stream ✅ slot ${i} after cooldown`);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err)) markCooling(i);
    }
  }

  const err = new Error('All Groq pool stream slots exhausted');
  err.code  = 'GROQ_POOL_EXHAUSTED';
  throw err;
}

// ── Pool status (for diagnose endpoint) ──────────────────────────
function groqPoolStatus() {
  return POOL_CONFIG.map((slot, i) => ({
    slot:      i,
    model:     slot.model,
    mode:      slot.mode,
    tier:      slot.tier,
    available: isAvailable(i),
    dead:      slotState[i].dead,
    coolUntil: slotState[i].coolUntil > Date.now()
      ? new Date(slotState[i].coolUntil).toISOString()
      : null,
  }));
}

module.exports = { groqGenerate, groqStream, groqPoolStatus };

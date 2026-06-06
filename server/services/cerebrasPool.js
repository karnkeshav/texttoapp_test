'use strict';
/**
 * cerebrasPool.js — Multi-model Cerebras fallback pool
 *
 * Uses OpenAI-compatible API via the openai SDK with a custom baseURL.
 * Mirrors the slot/cooldown pattern of geminiPool.js and groqPool.js exactly.
 * Called by antigravity.js after Groq pool is exhausted.
 *
 * Two-tier pool:
 *   tier: 'build' → llama3.3-70b + llama-4-scout (high quality)
 *   tier: 'chat'  → llama3.1-8b (lighter, higher RPM)
 *
 * Quota model: token-based (1M tokens/day per model), not request-based.
 * Requires env var: CEREBRAS_API_KEY
 */

const OpenAI = require('openai');
const { trackRequest, updateServerLimits } = require('./quotaTracker');
const { isStreamTruncated } = require('./truncationDetector');

const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

// ── Pool configuration ────────────────────────────────────────────
// Cerebras has only 5 RPM per model — treat as low-throughput emergency fallback.
const POOL_CONFIG = [

  // ── BUILD TIER — large models for app generation (ordered by capacity) ──
  // gpt-oss-120b: RPM 5, RPD 2400, TPM 30000
  { model: 'gpt-oss-120b',              mode: 'stream',   tier: 'build' },
  { model: 'gpt-oss-120b',              mode: 'generate', tier: 'build' },

  // zai-glm-4.7: RPM 5, RPD 2400, TPM 30000
  { model: 'zai-glm-4.7',              mode: 'stream',   tier: 'build' },
  { model: 'zai-glm-4.7',              mode: 'generate', tier: 'build' },

  // ── CHAT TIER — lighter model ────────────────────────────────────
  // zai-glm-4.7: RPM 5, RPD 2400, TPM 30000
  { model: 'zai-glm-4.7',              mode: 'stream',   tier: 'chat' },
  { model: 'zai-glm-4.7',              mode: 'generate', tier: 'chat' },
];

const COOLDOWN_MS = 60_000; // 1 min cooldown after 429

// ── Slot state tracking ───────────────────────────────────────────
const slotState = POOL_CONFIG.map(() => ({
  coolUntil: 0,
  dead:      false,
}));

function isAvailable(i) {
  return !slotState[i].dead && Date.now() >= slotState[i].coolUntil;
}

function markCooling(i) {
  slotState[i].coolUntil = Date.now() + COOLDOWN_MS;
  const slot = POOL_CONFIG[i];
  console.warn(`[CerebrasPool] Slot ${i} (${slot.model}) cooling for ${COOLDOWN_MS / 1000}s`);
}

function markDead(i) {
  slotState[i].dead = true;
  const slot = POOL_CONFIG[i];
  console.error(`[CerebrasPool] Slot ${i} (${slot.model}) marked dead — will not retry`);
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

// ── Convert Gemini contents → OpenAI messages ─────────────────────
function toOpenAIMessages(contents) {
  return contents.map(c => ({
    role:    c.role === 'model' ? 'assistant' : c.role,
    content: (c.parts || []).map(p => p.text || '').join(''),
  }));
}

// ── Slot selector ─────────────────────────────────────────────────
function selectSlots(mode, tier) {
  const all     = POOL_CONFIG.map((slot, i) => ({ slot, i }));
  const matches = (t) => (s) => s.slot.mode === mode && s.slot.tier === t;

  if (tier === 'chat') {
    return [...all.filter(matches('chat')), ...all.filter(matches('build'))];
  }
  return all.filter(matches('build'));
}

// ── Cerebras client factory ───────────────────────────────────────
function makeClient(apiKey) {
  return new OpenAI({
    apiKey:  apiKey || process.env.CEREBRAS_API_KEY,
    baseURL: CEREBRAS_BASE_URL,
  });
}

// ── Public: one-shot generation ───────────────────────────────────
async function cerebrasGenerate({ contents, config, apiKey, tier = 'build' }) {
  const client   = makeClient(apiKey);
  const messages = toOpenAIMessages(contents);
  const slots    = selectSlots('generate', tier);

  for (const { slot, i } of slots) {
    if (!isAvailable(i)) continue;
    try {
      const { data: resp, response: httpResp } = await client.chat.completions.create({
        model:       slot.model,
        messages,
        max_tokens:  config?.maxOutputTokens || 8192,
        temperature: config?.temperature     ?? 0.7,
        stream:      false,
      }).withResponse();
      const text = resp.choices?.[0]?.message?.content || '';
      console.log(`[CerebrasPool] generate ✅ slot ${i} (${slot.model}) [${slot.tier}]`);
      trackRequest('cerebras', slot.model);
      updateServerLimits('cerebras', slot.model, httpResp.headers);
      return text;
    } catch (err) {
      if (isQuotaError(err))  { markCooling(i); continue; }
      if (isNotFound(err))    { markDead(i);    continue; }
      if (isBadRequest(err))  { markDead(i);    continue; }
      console.warn(`[CerebrasPool] Slot ${i} (${slot.model}) unexpected error: ${err.message} — trying next slot`);
    }
  }

  const cooling = slots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[CerebrasPool] All generate slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i}`);
    await new Promise(r => setTimeout(r, wait + 500));
    try {
      const resp = await client.chat.completions.create({
        model:       slot.model,
        messages,
        max_tokens:  config?.maxOutputTokens || 8192,
        temperature: config?.temperature     ?? 0.7,
        stream:      false,
      });
      const text = resp.choices?.[0]?.message?.content || '';
      console.log(`[CerebrasPool] generate ✅ slot ${i} after cooldown`);
      return text;
    } catch (err) {
      if (isQuotaError(err)) markCooling(i);
    }
  }

  const err = new Error('All Cerebras pool generate slots exhausted');
  err.code  = 'CEREBRAS_POOL_EXHAUSTED';
  throw err;
}

// ── Public: streaming generation ─────────────────────────────────
async function cerebrasStream({ contents, config, apiKey, systemInstruction, onChunk, onDone, tier = 'build' }) {
  const client = makeClient(apiKey);
  const slots  = selectSlots('stream', tier);

  const baseMessages = toOpenAIMessages(contents);
  const messages     = systemInstruction
    ? [{ role: 'system', content: systemInstruction }, ...baseMessages]
    : baseMessages;

  for (const { slot, i } of slots) {
    if (!isAvailable(i)) continue;
    let fullText = '';
    try {
      const { data: stream, response: httpResp } = await client.chat.completions.create({
        model:       slot.model,
        messages,
        max_tokens:  config?.maxOutputTokens || 8192,
        temperature: config?.temperature     ?? 0.7,
        stream:      true,
      }).withResponse();

      for await (const chunk of stream) {
        const text = chunk.choices?.[0]?.delta?.content || '';
        if (text) { fullText += text; onChunk(text); }
      }
      if (isStreamTruncated(fullText)) {
        console.warn(`[CerebrasPool] Slot ${i} (${slot.model}) truncated — trying next Cerebras slot`);
        continue;
      }
      console.log(`[CerebrasPool] stream ✅ slot ${i} (${slot.model}) [${slot.tier}]`);
      trackRequest('cerebras', slot.model);
      updateServerLimits('cerebras', slot.model, httpResp.headers);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err))  { markCooling(i); continue; }
      if (isNotFound(err))    { markDead(i);    continue; }
      if (isBadRequest(err))  { markDead(i);    continue; }
      if (fullText.length === 0) {
        console.warn(`[CerebrasPool] Slot ${i} (${slot.model}) unexpected error: ${err.message} — trying next slot`);
        continue;
      }
      throw err;
    }
  }

  const cooling = slots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[CerebrasPool] All stream slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i}`);
    await new Promise(r => setTimeout(r, wait + 500));
    try {
      const stream = await client.chat.completions.create({
        model:       slot.model,
        messages,
        max_tokens:  config?.maxOutputTokens || 8192,
        temperature: config?.temperature     ?? 0.7,
        stream:      true,
      });
      let fullText = '';
      for await (const chunk of stream) {
        const text = chunk.choices?.[0]?.delta?.content || '';
        if (text) { fullText += text; onChunk(text); }
      }
      if (isStreamTruncated(fullText)) {
        console.warn(`[CerebrasPool] Cooldown slot ${i} (${slot.model}) truncated — all slots exhausted`);
        const err = new Error('All Cerebras pool stream slots exhausted (truncation detected)');
        err.code = 'CEREBRAS_POOL_EXHAUSTED';
        throw err;
      }
      console.log(`[CerebrasPool] stream ✅ slot ${i} after cooldown`);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err)) markCooling(i);
    }
  }

  const err = new Error('All Cerebras pool stream slots exhausted');
  err.code  = 'CEREBRAS_POOL_EXHAUSTED';
  throw err;
}

// ── Pool status (for diagnose endpoint) ──────────────────────────
function cerebrasPoolStatus() {
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

module.exports = { cerebrasGenerate, cerebrasStream, cerebrasPoolStatus };

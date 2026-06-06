'use strict';
/**
 * sambanovaPool.js — Multi-model SambaNova fallback pool
 *
 * Uses OpenAI-compatible API via the openai SDK with a custom baseURL.
 * Mirrors the slot/cooldown pattern of geminiPool.js exactly.
 * Called by antigravity.js after Cerebras pool is exhausted.
 *
 * Two-tier pool:
 *   tier: 'build' → 70B/405B models (high quality, lower RPM)
 *   tier: 'chat'  → 3B/7B models (faster, lighter)
 *
 * Note: 405B model is placed last in build tier — it has the lowest RPM (10).
 * Note: RPD estimated as RPM × 48 (conservative — 30 min active per hour).
 * Requires env var: SAMBANOVA_API_KEY
 */

const OpenAI = require('openai');
const { trackRequest, updateServerLimits } = require('./quotaTracker');

const SAMBANOVA_BASE_URL = 'https://api.sambanova.ai/v1';

// ── Pool configuration ────────────────────────────────────────────
// All models: RPD 20 (very limited — emergency fallback only)
const POOL_CONFIG = [

  // ── BUILD TIER — large models, ordered by priority ───────────────
  // Meta-Llama-3.3-70B-Instruct: RPD 20
  { model: 'Meta-Llama-3.3-70B-Instruct',          mode: 'stream',   tier: 'build' },
  { model: 'Meta-Llama-3.3-70B-Instruct',          mode: 'generate', tier: 'build' },

  // DeepSeek-V3.2: RPD 20
  { model: 'DeepSeek-V3.2',                        mode: 'stream',   tier: 'build' },
  { model: 'DeepSeek-V3.2',                        mode: 'generate', tier: 'build' },

  // Llama-4-Maverick-17B-128E-Instruct: RPD 20
  { model: 'Llama-4-Maverick-17B-128E-Instruct',   mode: 'stream',   tier: 'build' },
  { model: 'Llama-4-Maverick-17B-128E-Instruct',   mode: 'generate', tier: 'build' },

  // gpt-oss-120b: RPD 20 (extra capacity)
  { model: 'gpt-oss-120b',                         mode: 'stream',   tier: 'build' },
  { model: 'gpt-oss-120b',                         mode: 'generate', tier: 'build' },

  // ── CHAT TIER — lighter models ────────────────────────────────────
  // gemma-3-12b-it: RPD 20
  { model: 'gemma-3-12b-it',                       mode: 'stream',   tier: 'chat' },
  { model: 'gemma-3-12b-it',                       mode: 'generate', tier: 'chat' },

  // gemma-4-31B-it: RPD 20
  { model: 'gemma-4-31B-it',                       mode: 'stream',   tier: 'chat' },
  { model: 'gemma-4-31B-it',                       mode: 'generate', tier: 'chat' },
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
  console.warn(`[SambanovaPool] Slot ${i} (${slot.model}) cooling for ${COOLDOWN_MS / 1000}s`);
}

function markDead(i) {
  slotState[i].dead = true;
  const slot = POOL_CONFIG[i];
  console.error(`[SambanovaPool] Slot ${i} (${slot.model}) marked dead — will not retry`);
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

// ── SambaNova client factory ──────────────────────────────────────
function makeClient(apiKey) {
  return new OpenAI({
    apiKey:  apiKey || process.env.SAMBANOVA_API_KEY,
    baseURL: SAMBANOVA_BASE_URL,
  });
}

// ── Public: one-shot generation ───────────────────────────────────
async function sambanovaGenerate({ contents, config, apiKey, tier = 'build' }) {
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
      console.log(`[SambanovaPool] generate ✅ slot ${i} (${slot.model}) [${slot.tier}]`);
      trackRequest('sambanova', slot.model);
      updateServerLimits('sambanova', slot.model, httpResp.headers);
      return text;
    } catch (err) {
      if (isQuotaError(err))  { markCooling(i); continue; }
      if (isNotFound(err))    { markDead(i);    continue; }
      if (isBadRequest(err))  { markDead(i);    continue; }
      console.warn(`[SambanovaPool] Slot ${i} (${slot.model}) unexpected error: ${err.message} — trying next slot`);
    }
  }

  const cooling = slots
    .filter(({ i }) => !slotState[i].dead && slotState[i].coolUntil > 0)
    .sort((a, b) => slotState[a.i].coolUntil - slotState[b.i].coolUntil);

  if (cooling.length > 0) {
    const { slot, i } = cooling[0];
    const wait = Math.max(0, slotState[i].coolUntil - Date.now());
    console.warn(`[SambanovaPool] All generate slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i}`);
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
      console.log(`[SambanovaPool] generate ✅ slot ${i} after cooldown`);
      return text;
    } catch (err) {
      if (isQuotaError(err)) markCooling(i);
    }
  }

  const err = new Error('All SambaNova pool generate slots exhausted');
  err.code  = 'SAMBANOVA_POOL_EXHAUSTED';
  throw err;
}

// ── Public: streaming generation ─────────────────────────────────
async function sambanovaStream({ contents, config, apiKey, systemInstruction, onChunk, onDone, tier = 'build' }) {
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
      console.log(`[SambanovaPool] stream ✅ slot ${i} (${slot.model}) [${slot.tier}]`);
      trackRequest('sambanova', slot.model);
      updateServerLimits('sambanova', slot.model, httpResp.headers);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err))  { markCooling(i); continue; }
      if (isNotFound(err))    { markDead(i);    continue; }
      if (isBadRequest(err))  { markDead(i);    continue; }
      if (fullText.length === 0) {
        console.warn(`[SambanovaPool] Slot ${i} (${slot.model}) unexpected error: ${err.message} — trying next slot`);
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
    console.warn(`[SambanovaPool] All stream slots cooling — waiting ${Math.ceil(wait / 1000)}s for slot ${i}`);
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
      console.log(`[SambanovaPool] stream ✅ slot ${i} after cooldown`);
      onDone(fullText);
      return;
    } catch (err) {
      if (isQuotaError(err)) markCooling(i);
    }
  }

  const err = new Error('All SambaNova pool stream slots exhausted');
  err.code  = 'SAMBANOVA_POOL_EXHAUSTED';
  throw err;
}

// ── Pool status (for diagnose endpoint) ──────────────────────────
function sambanovaPoolStatus() {
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

module.exports = { sambanovaGenerate, sambanovaStream, sambanovaPoolStatus };

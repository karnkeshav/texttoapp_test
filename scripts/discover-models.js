'use strict';
/**
 * discover-models.js — correct version
 *
 * 1. Fetches the live model list from the API (no guessing)
 * 2. Filters for models that support generateContent
 * 3. Tests each with a 3s delay between probes to avoid burst rate-limiting
 * 4. Tests both SDKs (new + legacy) per model
 * 5. Prints a clean summary and the POOL_CONFIG snippet to paste into geminiPool.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios                  = require('axios');
const { GoogleGenAI }        = require('@google/genai');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('No GEMINI_API_KEY in .env'); process.exit(1); }

const DELAY_MS = 3000; // space requests to avoid burst 429s

// Models to SKIP regardless (non-text: TTS, image, video, embedding, audio, robotics)
const SKIP_RE = /tts|imagen|veo|lyria|embedding|aqa|audio|image|robotics|computer.use|nano.banana|deep.research/i;

// ── Step 1: Fetch model list from API ────────────────────────────
async function fetchModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}&pageSize=200`;
  const { data } = await axios.get(url, { timeout: 15_000 });
  return (data.models || [])
    .filter(m => {
      const methods = m.supportedGenerationMethods || [];
      return methods.includes('generateContent') && !SKIP_RE.test(m.name);
    })
    .map(m => m.name.replace('models/', '')); // strip "models/" prefix
}

// ── Step 2: Test a model on the new SDK ──────────────────────────
async function testNewSDK(model) {
  const ai = new GoogleGenAI({ apiKey: API_KEY });
  const r = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: 'Reply with just: ok' }] }],
    config: { maxOutputTokens: 20, thinkingConfig: { thinkingBudget: 0 } },
  });
  return (r.text ?? r.candidates?.[0]?.content?.parts?.find(p => p.text)?.text ?? '').trim().slice(0, 30) || '(empty)';
}

// ── Step 3: Test a model on the legacy SDK ───────────────────────
async function testLegacySDK(model) {
  const genAI = new GoogleGenerativeAI(API_KEY);
  const m = genAI.getGenerativeModel({ model });
  const result = await m.generateContent('Reply with just: ok');
  return (result.response.text() || '').trim().slice(0, 30) || '(empty)';
}

function classify(err) {
  const msg = err?.message || String(err);
  if (msg.includes('limit: 0'))         return '❌ LIMIT_ZERO (needs billing)';
  if (msg.includes('"code":429') || msg.includes('429'))
    return '⏳ QUOTA_429 (rate limited)';
  if (msg.includes('"code":404') || msg.includes('NOT_FOUND') || msg.includes('no longer available'))
    return '❌ NOT_FOUND';
  if (msg.includes('"code":400'))       return '❌ BAD_REQUEST';
  return `❌ ERR: ${msg.slice(0, 60)}`;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log('\nFetching model list from API…');
  const models = await fetchModels();
  console.log(`Found ${models.length} text-generation models to test:\n`);
  models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));

  console.log('\n' + '═'.repeat(100));
  console.log('  TESTING — 3s gap between each model to avoid burst rate limits');
  console.log('═'.repeat(100));

  const results = [];

  for (const model of models) {
    process.stdout.write(`\n  ${model.padEnd(50)} `);

    let newResult, legResult;

    // Test new SDK
    try {
      newResult = { ok: true, text: await testNewSDK(model) };
      process.stdout.write(`new:✅ ${newResult.text.padEnd(15)} `);
    } catch (e) {
      newResult = { ok: false, text: classify(e) };
      process.stdout.write(`new:${newResult.text.slice(0, 25).padEnd(28)} `);
    }

    await sleep(1500);

    // Test legacy SDK
    try {
      legResult = { ok: true, text: await testLegacySDK(model) };
      process.stdout.write(`legacy:✅ ${legResult.text}`);
    } catch (e) {
      legResult = { ok: false, text: classify(e) };
      process.stdout.write(`legacy:${legResult.text.slice(0, 30)}`);
    }

    results.push({ model, newSDK: newResult, legacySDK: legResult });
    await sleep(DELAY_MS);
  }

  console.log('\n\n' + '═'.repeat(100));
  console.log('  SUMMARY');
  console.log('═'.repeat(100));

  const working = results.filter(r => r.newSDK.ok || r.legacySDK.ok);
  const quotaOnly = results.filter(r => !r.newSDK.ok && !r.legacySDK.ok &&
    (r.newSDK.text.includes('429') || r.legacySDK.text.includes('429')));

  console.log(`\n✅ Working (${working.length}):`);
  working.forEach(r => console.log(`   ${r.model}  new:${r.newSDK.ok ? '✅' : '❌'}  legacy:${r.legacySDK.ok ? '✅' : '❌'}`));

  console.log(`\n⏳ Rate-limited only (${quotaOnly.length}) — may work with billing or after cooldown:`);
  quotaOnly.forEach(r => console.log(`   ${r.model}`));

  const neither = results.filter(r => !r.newSDK.ok && !r.legacySDK.ok && !quotaOnly.includes(r));
  console.log(`\n❌ Unavailable (${neither.length}):`);
  neither.forEach(r => console.log(`   ${r.model}  — ${r.newSDK.text}`));

  // ── Print POOL_CONFIG snippet ─────────────────────────────────
  console.log('\n\n' + '═'.repeat(100));
  console.log('  POOL_CONFIG SNIPPET — paste into server/services/geminiPool.js');
  console.log('═'.repeat(100) + '\n');
  console.log('const POOL_CONFIG = [');
  for (const r of working) {
    if (r.newSDK.ok) {
      console.log(`  { sdk: 'new',    model: '${r.model}', mode: 'generate' },`);
      console.log(`  { sdk: 'new',    model: '${r.model}', mode: 'stream'   },`);
    }
    if (r.legacySDK.ok) {
      console.log(`  { sdk: 'legacy', model: '${r.model}', mode: 'generate' },`);
      console.log(`  { sdk: 'legacy', model: '${r.model}', mode: 'stream'   },`);
    }
  }
  if (quotaOnly.length) {
    console.log('  // ── Rate-limited (uncomment if quota resets) ──');
    for (const r of quotaOnly) {
      console.log(`  // { sdk: 'new',    model: '${r.model}', mode: 'generate' },`);
      console.log(`  // { sdk: 'new',    model: '${r.model}', mode: 'stream'   },`);
    }
  }
  console.log('];');
  console.log('');
})();

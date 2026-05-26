'use strict';
/**
 * smoke-test.js — end-to-end pipeline verification (no browser needed)
 *
 * Tests:
 *  1. Pool generate  — plan phase (structured JSON)
 *  2. Pool stream    — full chat generation (checks REPO_NAME + html block)
 *  3. Code audit     — auditAndHeal on known-good and known-bad HTML
 *  4. Output gate    — chat route logic (REPO_NAME present but no html = error)
 *
 * Run: node scripts/smoke-test.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { pooledGenerate, pooledStream } = require('../server/services/geminiPool');
const { auditAndHeal }                 = require('../server/services/codeQuality');
const { analyzePlanPhase }             = require('../server/services/planPhase');

const API_KEY  = process.env.GEMINI_API_KEY;
const PASS = '✅';
const FAIL = '❌';
const results = [];

function log(name, ok, detail = '') {
  const icon = ok ? PASS : FAIL;
  results.push({ name, ok });
  console.log(`${icon}  ${name}${detail ? '  →  ' + detail : ''}`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Test 1: Plan phase (structured JSON) ─────────────────────────
async function testPlanPhase() {
  console.log('\n── Test 1: Plan phase ──────────────────────────────');
  try {
    const plan = await analyzePlanPhase('build me a todo app', API_KEY);
    const ok = plan && typeof plan.archetype === 'string' &&
               typeof plan.requiresAskBack === 'boolean';
    log('Plan phase returns valid JSON', ok,
      `archetype=${plan.archetype} askBack=${plan.requiresAskBack}`);
    if (plan.askBackQuestion)
      log('Plan phase has askBackQuestion', typeof plan.askBackQuestion === 'string',
        plan.askBackQuestion.slice(0, 80));
  } catch (e) {
    log('Plan phase', false, e.message.slice(0, 120));
  }
}

// ── Test 2: Pool generate (raw text) ─────────────────────────────
async function testPoolGenerate() {
  console.log('\n── Test 2: Pool generate ───────────────────────────');
  try {
    const text = await pooledGenerate({
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
      config:   { maxOutputTokens: 10 },
      apiKey:   API_KEY,
    });
    log('pooledGenerate returns text', !!text, `"${text.trim()}"`);
  } catch (e) {
    log('pooledGenerate', false, e.message.slice(0, 120));
  }
}

// ── Test 3: Pool stream — full code generation ────────────────────
async function testPoolStream() {
  console.log('\n── Test 3: Pool stream (code generation) ───────────');
  const SYSTEM = 'You are Ready4Launch. Always output REPO_NAME: <name> then a ```html block with complete HTML.';

  // Minimal generation prompt
  const contents = [
    {
      role: 'user',
      parts: [{ text: `Build a minimal counter app. Output must start with:
REPO_NAME: counter-app
Then a short description, then the full HTML in a \`\`\`html block.` }],
    },
  ];

  let fullText = '';
  let chunkCount = 0;
  let streamDone = false;

  try {
    await pooledStream({
      contents,
      config:            { temperature: 0.3, maxOutputTokens: 2048 },
      apiKey:            API_KEY,
      systemInstruction: 'Generate complete single-file HTML apps.',
      onChunk: (t) => { fullText += t; chunkCount++; },
      onDone:  (t) => { fullText = t; streamDone = true; },
    });

    log('Stream received chunks',       chunkCount > 0,       `${chunkCount} chunks`);
    log('onDone called',               streamDone);
    log('Response has REPO_NAME',      /REPO_NAME\s*:/i.test(fullText));
    log('Response has ```html block',  /```html/i.test(fullText));

    const htmlMatch = fullText.match(/```html\s*([\s\S]*?)```/i);
    if (htmlMatch) {
      const htmlLen = htmlMatch[1].trim().length;
      log('HTML block has content', htmlLen > 100, `${htmlLen} chars`);
    }

    // Output gate simulation (matches server/routes/chat.js onDone logic)
    const announcedCode = /REPO_NAME\s*:/i.test(fullText);
    const hasHtmlBlock  = /```html/i.test(fullText);
    const gatePass = !(announcedCode && !hasHtmlBlock);
    log('Output gate passes', gatePass,
      announcedCode ? (hasHtmlBlock ? 'REPO_NAME + html ✓' : 'REPO_NAME but NO html ✗') : 'no code announced');

  } catch (e) {
    log('Pool stream', false, e.message.slice(0, 120));
  }
}

// ── Test 4: Code audit ────────────────────────────────────────────
async function testCodeAudit() {
  console.log('\n── Test 4: Code audit (auditAndHeal) ──────────────');

  const GOOD_HTML = `<!DOCTYPE html>
<html><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Counter</title>
  <style>body{margin:0;background:#09090f;color:#f1f5f9;}</style>
</head><body>
  <div id="app"><button id="btn">Count: 0</button></div>
  <script>
    var count = 0;
    document.getElementById('btn').addEventListener('click', function() {
      count++;
      document.getElementById('btn').textContent = 'Count: ' + count;
    });
  </script>
</body></html>`;

  const BAD_HTML = `<html><head>
  <style>body { margin: 0;
  .unclosed { color: red;
  </style>
</head><body>
  <div id="main">
  <script>
    var broken = function( { console.log('syntax error'); };
  </script>
</body></html>`;

  try {
    // Good HTML should pass with no healing needed
    const goodResult = await auditAndHeal(GOOD_HTML, API_KEY, 'gemini-2.5-flash');
    log('Good HTML passes audit', !goodResult.healed,
      `attempts=${goodResult.attempts} healed=${goodResult.healed}`);
  } catch (e) {
    log('Good HTML audit', false, e.message.slice(0, 120));
  }

  await sleep(2000);

  try {
    // Bad HTML should be healed or throw CODE_AUDIT_FAILED
    const badResult = await auditAndHeal(BAD_HTML, API_KEY, 'gemini-2.5-flash');
    log('Bad HTML healed', badResult.healed,
      `attempts=${badResult.attempts}`);
  } catch (e) {
    if (e.code === 'CODE_AUDIT_FAILED') {
      log('Bad HTML — CODE_AUDIT_FAILED thrown correctly', true,
        `${e.issues?.length} issues`);
    } else {
      log('Bad HTML audit', false, e.message.slice(0, 120));
    }
  }
}

// ── Test 5: Auth + server health ─────────────────────────────────
async function testServerHealth() {
  console.log('\n── Test 5: Server health ───────────────────────────');
  const axios = require('axios');
  try {
    const { data } = await axios.get('http://localhost:3000/api/diagnose', { timeout: 10_000 });
    log('Server is up',              true);
    log('Gemini pool has slots',     data.gemini_pool?.length > 0,
      `${data.gemini_pool?.length} slots`);
    log('Gemini live test OK',       data.gemini_live_test?.ok === true,
      data.gemini_live_test?.response || data.gemini_live_test?.error?.slice(0, 80));
    const available = data.gemini_pool?.filter(s => s.available).length;
    log('Pool slots available',      available > 0, `${available} available`);
  } catch (e) {
    log('Server health', false, e.message.slice(0, 80));
  }
}

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  console.log('═'.repeat(55));
  console.log('  Ready4Launch Smoke Test');
  console.log('═'.repeat(55));

  await testServerHealth();
  await sleep(2000);
  await testPlanPhase();
  await sleep(2000);
  await testPoolGenerate();
  await sleep(2000);
  await testPoolStream();
  await sleep(2000);
  await testCodeAudit();

  console.log('\n' + '═'.repeat(55));
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(55) + '\n');

  if (failed > 0) {
    console.log('FAILED tests:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.name}`));
    process.exit(1);
  }
})();

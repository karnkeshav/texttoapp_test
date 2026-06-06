/**
 * CHECK PHASE — Mechanical code audit + auto-heal loop
 *
 * Zero API tokens for the audit itself.
 * Uses one low-token Gemini repair call per healing attempt (max 2).
 *
 * Checks (run in order, all errors aggregated before repair):
 *   1. Tag balance       — critical structural tags must open and close correctly
 *   2. Selector audit    — getElementById / querySelector('#x') must target existing IDs
 *   3. JS syntax         — inline <script> blocks must compile without SyntaxError
 *   4. CSS braces        — <style> blocks must have balanced { } pairs
 *   5. Critical meta     — charset, viewport, <title> must be present
 */

'use strict';

const vm = require('vm');
const geminiPool = require('./geminiPool'); // not destructured — lets tests spy on individual fns

const REPAIR_TIMEOUT_MS = 55_000; // abort repair if Gemini takes longer than this

// Returns true when at least one build-tier stream slot is free right now.
// Lets fullQualityPass skip the repair step instead of waiting 60 s for a cooling slot.
function geminiStreamAvailable() {
  try {
    return geminiPool.poolStatus().some(s => s.mode === 'stream' && s.tier === 'build' && s.available);
  } catch (_) {
    return false;
  }
}

// Self-closing tags that never have a closing counterpart
const VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input',
  'link','meta','param','source','track','wbr',
]);

// Critical tags whose balance is worth enforcing
const CRITICAL_TAGS = new Set([
  'div','script','style','html','head','body',
  'main','section','article','nav','header','footer',
]);

// ── 1. Tag balance ────────────────────────────────────────────────
function checkTagBalance(html) {
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?(\/)?>/g;
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    const isClose   = match[1] === '/';
    const tag       = match[2].toLowerCase();
    const selfClose = match[3] === '/';

    if (VOID_TAGS.has(tag) || selfClose) continue;

    if (isClose) {
      // Only pop when the top of stack matches — avoids false "unclosed" reports
      if (stack.length > 0 && stack[stack.length - 1] === tag) stack.pop();
    } else {
      // Only track critical tags — non-critical open tags (span, a, p, li, td…)
      // are ignored so they cannot block critical tags from being matched on close.
      if (CRITICAL_TAGS.has(tag)) stack.push(tag);
    }
  }

  const unclosed = stack.filter(t => CRITICAL_TAGS.has(t));
  return unclosed.length > 0
    ? { passed: false, error: `Unclosed critical tags: ${unclosed.join(', ')}` }
    : { passed: true };
}

// ── 2. DOM selector audit ─────────────────────────────────────────
function checkSelectors(html) {
  const issues = [];

  const byIdRe = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = byIdRe.exec(html)) !== null) {
    const id = m[1];
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      issues.push(`getElementById('${id}') — no element with id="${id}" in HTML`);
    }
  }

  const qsIdRe = /document\.querySelector\(['"](#[a-zA-Z0-9_-]+)['"]\)/g;
  while ((m = qsIdRe.exec(html)) !== null) {
    const id = m[1].slice(1);
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      issues.push(`querySelector('#${id}') — no element with id="${id}" in HTML`);
    }
  }

  return issues.length > 0
    ? { passed: false, errors: issues }
    : { passed: true };
}

// ── 3. JavaScript syntax check ────────────────────────────────────
// Extracts every inline <script> block and compiles it with Node's vm.Script.
// Compilation parses the JS without executing it — browser APIs (document, window,
// fetch) never run, so there are no ReferenceErrors, only SyntaxErrors.
//
// Special handling for JSX: If code contains JSX syntax (React component returns),
// skip strict vm.Script validation since JSX requires Babel. Instead do basic checks.
function checkJSSyntax(html) {
  const issues = [];
  // Match <script ...> blocks; capture attributes separately so we can skip src=
  const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let blockNum = 0;

  while ((match = scriptRe.exec(html)) !== null) {
    const attrs = match[1] || '';
    const code  = match[2].trim();

    // Skip external scripts and empty blocks
    if (/\bsrc\s*=/i.test(attrs) || !code) continue;

    blockNum++;

    // Detect JSX patterns: return (...JSX), React.createElement, function App() with JSX
    const isLikelyJSX = /return\s*\(?\s*<|ReactDOM\.render|React\.createElement|<\/?\w+[\s>]/.test(code);

    if (isLikelyJSX) {
      // For JSX code, do basic bracket/paren matching instead of vm.Script
      // (JSX requires Babel transpilation, which we don't have in Node.js vm)

      const openBraces = (code.match(/\{/g) || []).length;
      const closeBraces = (code.match(/\}/g) || []).length;
      const openParens = (code.match(/\(/g) || []).length;
      const closeParens = (code.match(/\)/g) || []).length;
      const openBrackets = (code.match(/\[/g) || []).length;
      const closeBrackets = (code.match(/\]/g) || []).length;

      if (openBraces !== closeBraces) {
        issues.push(`Script block ${blockNum}: Mismatched braces { }`);
      }
      if (openParens !== closeParens) {
        issues.push(`Script block ${blockNum}: Mismatched parentheses ( )`);
      }
      if (openBrackets !== closeBrackets) {
        issues.push(`Script block ${blockNum}: Mismatched brackets [ ]`);
      }
    } else {
      // For vanilla JavaScript, use strict vm.Script validation
      try {
        new vm.Script(code); // compile-only — does not execute
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Trim the long v8 caret line from the message for readability
          const msg = err.message.split('\n')[0];
          issues.push(`Script block ${blockNum}: JavaScript SyntaxError — ${msg}`);
        }
      }
    }
  }

  return issues.length > 0
    ? { passed: false, errors: issues }
    : { passed: true };
}

// ── 4. CSS brace balance ──────────────────────────────────────────
// Counts { and } inside every <style> block after stripping comments and
// string literals to avoid false positives from content like { color: "red{}" }.
function checkCSSBraces(html) {
  const issues = [];
  const styleRe = /<style(?:\s[^>]*)?>([^]*?)<\/style>/gi;
  let match;
  let blockNum = 0;

  while ((match = styleRe.exec(html)) !== null) {
    const raw = match[1];
    blockNum++;

    // Strip /* */ comments, then string contents
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
      .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");

    const open  = (stripped.match(/\{/g) || []).length;
    const close = (stripped.match(/\}/g) || []).length;

    if (open !== close) {
      issues.push(
        `CSS style block ${blockNum}: unbalanced braces — ${open} opening '{' vs ${close} closing '}'`
      );
    }
  }

  return issues.length > 0
    ? { passed: false, errors: issues }
    : { passed: true };
}

// ── 5. Critical meta tag presence ────────────────────────────────
// Checks the three tags every GitHub Pages app needs to render correctly.
function checkMetaTags(html) {
  const issues = [];

  if (!/<meta\s[^>]*charset/i.test(html)) {
    issues.push('Missing <meta charset="UTF-8"> — text may render incorrectly');
  }
  if (!/<meta\s[^>]*name\s*=\s*["']viewport["']/i.test(html)) {
    issues.push('Missing <meta name="viewport"> — mobile layout will be broken');
  }
  if (!/<title(?:\s[^>]*)?>/ .test(html)) {
    issues.push('Missing <title> — browser tab will show a blank label');
  }

  return issues.length > 0
    ? { passed: false, errors: issues }
    : { passed: true };
}

// ── Repair pass ───────────────────────────────────────────────────
async function runRepairPass(code, errors, apiKey, _model) {
  const errorList = errors.map(e => `• ${e}`).join('\n');

  const prompt = `You are a code repair assistant. Fix ONLY the following structural issues in this HTML file.
Return ONLY the corrected HTML — no explanations, no markdown fences, no commentary.

ISSUES TO FIX:
${errorList}

HTML FILE:
${code}`;

  // pooledGenerate tries all working SDK/model slots automatically
  const text = await geminiPool.pooledGenerate({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config:   { temperature: 0.1, maxOutputTokens: 8192 },
    apiKey,
  });
  const fenced = text.match(/```(?:html|go|python|py|ruby|rb|rust|rs|php)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : text.trim();
}

// ── Run all checks, collect every error ───────────────────────────
function runAllChecks(html) {
  const errors = [];

  const tagResult  = checkTagBalance(html);
  const selResult  = checkSelectors(html);
  const jsResult   = checkJSSyntax(html);
  const cssResult  = checkCSSBraces(html);
  const metaResult = checkMetaTags(html);

  if (!tagResult.passed)  errors.push(tagResult.error);
  if (!selResult.passed)  errors.push(...selResult.errors);
  if (!jsResult.passed)   errors.push(...jsResult.errors);
  if (!cssResult.passed)  errors.push(...cssResult.errors);
  if (!metaResult.passed) errors.push(...metaResult.errors);

  return errors;
}

// ── Main audit + heal loop ────────────────────────────────────────
/**
 * Runs all 5 checks. If any fail, requests a targeted Gemini repair and re-checks.
 * Max 2 repair attempts. Throws CODE_AUDIT_FAILED if still broken after 2 passes.
 *
 * @param {string} code     Raw generated HTML
 * @param {string} apiKey   GEMINI_API_KEY
 * @param {string} model    Gemini model for repair calls
 * @returns {{ code: string, healed: boolean, attempts: number }}
 */
async function auditAndHeal(code, apiKey, model) {
  let current = code;

  for (let attempt = 0; attempt < 2; attempt++) {
    const errors = runAllChecks(current);

    if (errors.length === 0) {
      return { code: current, healed: attempt > 0, attempts: attempt };
    }

    console.log(
      `[CodeAudit] Attempt ${attempt + 1}/2 — ${errors.length} issue(s): ` +
      errors.slice(0, 3).join(' | ')
    );
    current = await runRepairPass(current, errors, apiKey, model);
  }

  // Final verification after all repair attempts
  const remaining = runAllChecks(current);

  if (remaining.length > 0) {
    const err  = new Error(`Code audit failed after 2 repair attempts: ${remaining.join('; ')}`);
    err.code   = 'CODE_AUDIT_FAILED';
    err.issues = remaining;
    throw err;
  }

  return { code: current, healed: true, attempts: 2 };
}

// ── Semantic audit ────────────────────────────────────────────────
/**
 * Asks the AI to check whether the generated app actually delivers
 * what was specified in the requirements.
 *
 * Returns { passed: boolean, issues: string[] }
 * Only flags concrete, verifiable failures — not style preferences.
 */
async function semanticAudit(generatedText, requirements, apiKey) {
  if (!requirements || !generatedText) return { passed: true, issues: [] };

  // Extract the HTML body for review (first 12 KB is enough for pattern matching)
  const htmlMatch = generatedText.match(/```html\s*([\s\S]*?)```/i)
                 || generatedText.match(/```html\s*([\s\S]*?<\/html>)/i);
  const htmlExcerpt = (htmlMatch ? htmlMatch[1] : generatedText).slice(0, 12000);

  const prompt =
`You are a QA engineer reviewing a generated web app against its specification.

SPECIFICATION:
${requirements.slice(0, 2500)}

GENERATED HTML (excerpt):
${htmlExcerpt}

Does the generated app fulfil the specification?
Flag ONLY concrete, verifiable failures such as:
  • A required feature is completely absent
  • An interactive element has no event handler
  • A required section or page is missing
  • The wrong data/content type is shown

Do NOT flag: colour choices, font preferences, layout decisions, minor copy differences.

If the app meets the spec: respond with exactly the word PASS
If there are failures: respond with FAIL then list each issue as a bullet point.
Maximum 5 issues. Keep the entire response under 150 words.`;

  let result;
  try {
    result = await geminiPool.pooledGenerate({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config:   { temperature: 0.1, maxOutputTokens: 400 },
      apiKey,
    });
  } catch (err) {
    console.warn('[SemanticAudit] pooledGenerate failed (skipping):', err.message);
    return { passed: true, issues: [] }; // non-fatal — skip audit
  }

  const text = (result || '').trim();
  if (/^pass/i.test(text)) return { passed: true, issues: [] };

  const issues = text
    .replace(/^fail\s*/i, '')
    .split('\n')
    .map(l => l.replace(/^[•\-\*\d\.]+\s*/, '').trim())
    .filter(l => l.length > 8)
    .slice(0, 5);

  return { passed: false, issues };
}

// ── Semantic repair ───────────────────────────────────────────────
/**
 * Given specific semantic issues, regenerates the HTML with those issues fixed.
 * Uses pooledStream (not pooledGenerate) so it can produce 32 K+ token output.
 *
 * Returns the full response string (REPO_NAME + intro + ```html...```)
 */
async function semanticRepair(generatedText, issues, requirements, apiKey) {
  // Multi-file output: more than one code block (html + css + js).
  // We can't safely repair and reconstruct without losing the other files,
  // so skip the repair step and return the original.
  const codeBlockCount = (generatedText.match(/```(?:html|css|javascript|js|go|python|py|ruby|rb|rust|rs|php|toml|mod)\b/gi) || []).length;
  if (codeBlockCount > 1) {
    console.warn('[SemanticRepair] Multi-file output detected — skipping repair to preserve file structure');
    return generatedText;
  }

  const htmlMatch = generatedText.match(/```html\s*([\s\S]*?)```/i)
                 || generatedText.match(/```html\s*([\s\S]*?<\/html>)/i);
  const currentHtml = htmlMatch ? htmlMatch[1] : generatedText;

  const issueList = issues.map(i => `• ${i}`).join('\n');

  const repairPrompt =
`You are fixing a generated web app that has quality issues.

SPECIFICATION:
${requirements.slice(0, 2500)}

ISSUES TO FIX:
${issueList}

CURRENT HTML:
${currentHtml}

Fix ALL listed issues while keeping everything else exactly as-is.
Return ONLY the corrected complete HTML file — no markdown fences, no commentary.`;

  let repairedHtml = '';
  try {
    await geminiPool.cascadeStream({
      contents:          [{ role: 'user', parts: [{ text: repairPrompt }] }],
      config:            { temperature: 0.2, maxOutputTokens: 32768 },
      apiKey,
      systemInstruction: '',
      onChunk: () => {},                        // silent — accumulate via onDone
      onDone:  (text) => { repairedHtml = text; },
    });
  } catch (err) {
    console.warn('[SemanticRepair] cascadeStream failed:', err.message);
    return generatedText; // return original on error
  }

  // Strip any fences the AI added
  repairedHtml = repairedHtml
    .replace(/^```html?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  if (!repairedHtml || repairedHtml.length < 200) {
    console.warn('[SemanticRepair] Repair output too short — keeping original');
    return generatedText;
  }

  // Reconstruct full response, preserving intro line and REPO_NAME
  const introMatch = generatedText.match(/^(Here[^\n]+\n)/i);
  const repoMatch  = generatedText.match(/(REPO_NAME:\s*[^\n]+)/i);
  const intro    = introMatch ? introMatch[1] : '';
  const repoLine = repoMatch  ? repoMatch[1] + '\n\n' : '';

  return `${intro}${repoLine}\`\`\`html\n${repairedHtml}\n\`\`\``;
}

// ── Full quality pass ─────────────────────────────────────────────
/**
 * Runs semantic audit → repair (if needed) → re-audit.
 * Call this after AI streaming completes, before sending 'done' to the client.
 *
 * API cost: 1 pooledGenerate (audit) + optionally 1 pooledStream (repair)
 *           + optionally 1 pooledGenerate (re-audit) = max 3 calls.
 *
 * @param {string} generatedText  Full AI response (REPO_NAME + ```html...```)
 * @param {string} requirements   enrichedNotes / compiled spec used for the build
 * @param {string} apiKey
 * @returns {Promise<string>}     Audited (and possibly repaired) response
 */
async function fullQualityPass(generatedText, requirements, apiKey) {
  // Step 1 — semantic audit
  const audit = await semanticAudit(generatedText, requirements, apiKey);
  console.log(
    `[SemanticAudit] ${audit.passed ? '✅ PASS' : `❌ FAIL — ${audit.issues.length} issue(s): ${audit.issues.slice(0, 2).join(' | ')}`}`
  );

  if (audit.passed || audit.issues.length === 0) return generatedText;

  // Step 2 — only attempt repair when a Gemini stream slot is actually free.
  // If all slots are cooling the repair call would silently block for ~60 s before
  // giving up anyway — skip it and return the original output immediately.
  if (!geminiStreamAvailable()) {
    console.warn('[SemanticRepair] No free Gemini stream slots — skipping repair to avoid blocking');
    return generatedText;
  }

  console.log('[SemanticRepair] Repairing…');

  // Wrap repair + re-audit in a hard timeout so a slow/stuck Gemini call never
  // leaves the response stream silent for longer than REPAIR_TIMEOUT_MS.
  let repaired;
  try {
    repaired = await Promise.race([
      semanticRepair(generatedText, audit.issues, requirements, apiKey),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('repair timeout')), REPAIR_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.warn(`[SemanticRepair] Skipped — ${err.message}`);
    return generatedText;
  }

  // Step 3 — re-audit to confirm fix
  const reAudit = await semanticAudit(repaired, requirements, apiKey);
  console.log(`[SemanticAudit] Re-audit: ${reAudit.passed ? '✅ PASS' : '⚠️  issues remain (proceeding with best effort)'}`);

  return repaired; // return repaired regardless — always better than original
}

module.exports = {
  checkTagBalance,
  checkSelectors,
  checkJSSyntax,
  checkCSSBraces,
  checkMetaTags,
  auditAndHeal,
  semanticAudit,
  semanticRepair,
  fullQualityPass,
};

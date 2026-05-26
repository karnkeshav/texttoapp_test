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
const { GoogleGenAI } = require('@google/genai');

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
      if (stack.length > 0 && stack[stack.length - 1] === tag) stack.pop();
    } else {
      stack.push(tag);
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
  if (!/<title\s*>/i.test(html)) {
    issues.push('Missing <title> — browser tab will show a blank label');
  }

  return issues.length > 0
    ? { passed: false, errors: issues }
    : { passed: true };
}

// ── Repair pass ───────────────────────────────────────────────────
async function runRepairPass(code, errors, apiKey, model) {
  const ai        = new GoogleGenAI({ apiKey });
  const errorList = errors.map(e => `• ${e}`).join('\n');

  const prompt = `You are a code repair assistant. Fix ONLY the following structural issues in this HTML file.
Return ONLY the corrected HTML — no explanations, no markdown fences, no commentary.

ISSUES TO FIX:
${errorList}

HTML FILE:
${code}`;

  const response = await ai.models.generateContent({
    model: model || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      thinkingConfig: { thinkingBudget: 0 }, // disable thinking — required for .text on 2.5+ models
    },
  });

  const text = response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
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

module.exports = {
  checkTagBalance,
  checkSelectors,
  checkJSSyntax,
  checkCSSBraces,
  checkMetaTags,
  auditAndHeal,
};

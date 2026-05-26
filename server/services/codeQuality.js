/**
 * CHECK PHASE — Mechanical code audit + auto-heal loop
 *
 * Zero API tokens for the audit itself.
 * Uses one low-token Gemini repair call per healing attempt (max 2).
 *
 * Checks:
 *   1. Tag balance — critical structural tags must open and close correctly
 *   2. Selector audit — getElementById / querySelector('#x') must target existing IDs
 */

const { GoogleGenAI } = require('@google/genai');

// Self-closing tags that never have a closing counterpart
const VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input',
  'link','meta','param','source','track','wbr',
]);

// Critical tags whose balance is worth enforcing
const CRITICAL_TAGS = new Set(['div','script','style','html','head','body','main','section','article','nav','header','footer']);

// ── 1. Tag balance checker ────────────────────────────────────────
function checkTagBalance(html) {
  const stack  = [];
  // Match opening and closing tags (skips self-closing />)
  const tagRe  = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?(\/)?>/g;
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    const isClose    = match[1] === '/';
    const tag        = match[2].toLowerCase();
    const selfClose  = match[3] === '/';

    if (VOID_TAGS.has(tag) || selfClose) continue;

    if (isClose) {
      // Pop matching open tag — be lenient on non-critical mismatches
      if (stack.length > 0 && stack[stack.length - 1] === tag) {
        stack.pop();
      }
    } else {
      stack.push(tag);
    }
  }

  const unclosed = stack.filter(t => CRITICAL_TAGS.has(t));
  if (unclosed.length > 0) {
    return { passed: false, error: `Unclosed critical tags: ${unclosed.join(', ')}` };
  }
  return { passed: true };
}

// ── 2. DOM selector audit ─────────────────────────────────────────
function checkSelectors(html) {
  const issues = [];

  // getElementById('some-id')
  const byIdRe  = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
  let m;
  while ((m = byIdRe.exec(html)) !== null) {
    const id = m[1];
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      issues.push(`getElementById('${id}') — no element with id="${id}" found in HTML`);
    }
  }

  // querySelector('#some-id')
  const qsIdRe  = /document\.querySelector\(['"](#[a-zA-Z0-9_-]+)['"]\)/g;
  while ((m = qsIdRe.exec(html)) !== null) {
    const id = m[1].slice(1); // strip leading #
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
      issues.push(`querySelector('#${id}') — no element with id="${id}" found in HTML`);
    }
  }

  return issues.length > 0
    ? { passed: false, errors: issues }
    : { passed: true };
}

// ── 3. Low-token repair pass ──────────────────────────────────────
async function runRepairPass(code, errors, apiKey, model) {
  const ai    = new GoogleGenAI({ apiKey });
  const errorList = errors.map(e => `• ${e}`).join('\n');

  // Send only the error trace and the full code — ask for ONLY the corrected HTML back
  const prompt = `You are a code repair assistant. Fix ONLY the following structural issues in this HTML file.
Return ONLY the corrected HTML — no explanations, no markdown fences, no commentary.

ISSUES TO FIX:
${errorList}

HTML FILE:
${code}`;

  const response = await ai.models.generateContent({
    model: model || 'gemini-3.1-flash-lite',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.1, maxOutputTokens: 8192 },
  });

  const text = response.text || '';
  // Strip any accidental markdown fences
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : text.trim();
}

// ── 4. Main audit + heal loop ─────────────────────────────────────
/**
 * @param {string} code     Raw generated HTML
 * @param {string} apiKey   GEMINI_API_KEY
 * @param {string} model    Gemini model for repair calls
 * @returns {{ code: string, healed: boolean, attempts: number }}
 * @throws  Error with code 'CODE_AUDIT_FAILED' if still broken after 2 repairs
 */
async function auditAndHeal(code, apiKey, model) {
  let current = code;

  for (let attempt = 0; attempt < 2; attempt++) {
    const tagResult  = checkTagBalance(current);
    const selResult  = checkSelectors(current);

    if (tagResult.passed && selResult.passed) {
      return { code: current, healed: attempt > 0, attempts: attempt };
    }

    const errors = [
      ...(tagResult.passed ? [] : [tagResult.error]),
      ...(selResult.passed  ? [] : selResult.errors),
    ];

    console.log(`[CodeAudit] Attempt ${attempt + 1}/2 — ${errors.length} issue(s): ${errors.slice(0, 2).join(' | ')}`);
    current = await runRepairPass(current, errors, apiKey, model);
  }

  // Final pass after all repair attempts
  const finalTag = checkTagBalance(current);
  const finalSel = checkSelectors(current);

  if (!finalTag.passed || !finalSel.passed) {
    const remaining = [
      ...(finalTag.passed ? [] : [finalTag.error]),
      ...(finalSel.passed  ? [] : finalSel.errors),
    ];
    const err = new Error(`Code audit failed after 2 repair attempts: ${remaining.join('; ')}`);
    err.code   = 'CODE_AUDIT_FAILED';
    err.issues = remaining;
    throw err;
  }

  return { code: current, healed: true, attempts: 2 };
}

module.exports = { checkTagBalance, checkSelectors, auditAndHeal };

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
  // Strip script block contents — JSX inside <script type="text/babel">
  // is NOT HTML and must never be parsed as HTML tags
  const htmlWithoutScripts = html.replace(
    /<script\b[^>]*>([\s\S]*?)<\/script>/gi,
    (match, content) => match.replace(content, ' ')
  );

  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?(\/)?>/g;
  let match;

  while ((match = tagRe.exec(htmlWithoutScripts)) !== null) {
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
async function runRepairPass(code, errors, apiKey) {
  // If unclosed tags exist AND file has Babel script block,
  // the real issue is truncated JSX — repair cannot help
  const hasBabelScript = /<script[^>]+type\s*=\s*["']text\/babel["']/i.test(code);
  const hasUnclosedTags = errors.some(e => /unclosed critical tags/i.test(e));

  if (hasBabelScript && hasUnclosedTags) {
    const err = new Error('Unclosed tags inside Babel script = truncated JSX, not malformed HTML — regeneration required');
    err.code = 'NEEDS_REGENERATION';
    throw err;
  }

  // For CDN issues — send only the head section
  const isCdnIssue = errors.some(e => /cdn|script|babel|react|production/i.test(e));
  const codeToSend = isCdnIssue
    ? (code.match(/<head[\s\S]*?<\/head>/i)?.[0] || code.slice(0, 1500))
    : code.length > 3000
      ? code.slice(0, 1500) + '\n<!-- ... -->\n' + code.slice(-1000)
      : code;

  const prompt =
`Fix ONLY these structural issues. Return ONLY the corrected complete HTML.
No explanations, no markdown fences, no commentary.

ISSUES:
${errors.map(e => `• ${e}`).join('\n')}

HTML:
${codeToSend}`;

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

  // ── STEP 0: Detect truncation — repair cannot fix a cut file ──────
  const openFences  = (generatedText.match(/^```\S*/gm) || []).length;
  const closeFences = (generatedText.match(/^```\s*$/gm) || []).length;
  const hasTruncatedFence = openFences > closeFences;
  const isTruncationIssue = issues.some(i =>
    /truncat|cut off|incomplete|missing.*clos|never closed|cut mid/i.test(i)
  );

  if (hasTruncatedFence || isTruncationIssue) {
    console.warn('[SemanticRepair] Truncation detected — signalling regeneration');
    const err = new Error('Output truncated — regeneration required, repair cannot help');
    err.code = 'NEEDS_REGENERATION';
    throw err;
  }

  // ── ATTEMPT 1: Targeted file repair ──────────────────────────────
  // Identify which specific file has the issue and repair only that file
  console.log('[SemanticRepair] Attempt 1 — targeted file repair');

  const BLOCK_RE = /```(?:html|css|javascript|js|go|python|py|ruby|rb|rust|rs|php|toml|mod|json)\s*([\s\S]*?)```/gi;
  const FILE_RE  = /^(?:<!--\s*FILE:\s*|\/\*\s*FILE:\s*|\/\/\s*FILE:\s*|#\s*FILE:\s*)([^\s*>\n]+)/i;

  const blocks = [];
  let m;
  while ((m = BLOCK_RE.exec(generatedText)) !== null) {
    const content   = m[1] || '';
    const firstLine = content.split('\n')[0];
    const pathMatch = FILE_RE.exec(firstLine);
    if (pathMatch) {
      blocks.push({
        full:    m[0],
        path:    pathMatch[1],
        content: content.split('\n').slice(1).join('\n').trim(),
      });
    }
  }

  // Find which file is broken
  const brokenPaths = new Set();
  for (const issue of issues) {
    for (const block of blocks) {
      if (
        issue.toLowerCase().includes(block.path.toLowerCase()) ||
        (/react|babel|cdn|script|production\.min/i.test(issue) && block.path.endsWith('.html')) ||
        (/fetch|localhost|hardcoded/i.test(issue) && block.path.endsWith('.js'))
      ) {
        brokenPaths.add(block.path);
      }
    }
  }
  if (brokenPaths.size === 0 && blocks.some(b => b.path.endsWith('.html'))) {
    blocks.filter(b => b.path.endsWith('.html')).forEach(b => brokenPaths.add(b.path));
  }

  let attempt1Result = generatedText;
  for (const targetPath of brokenPaths) {
    const targetBlock = blocks.find(b => b.path === targetPath);
    if (!targetBlock) continue;

    // For CDN/script issues — send only the <head> section
    // For other issues — send first 2000 chars
    const isHeadIssue = /cdn|babel|react|script|production\.min/i.test(issues.join(' '));
    const contentToSend = isHeadIssue
      ? (targetBlock.content.match(/<head[\s\S]*?<\/head>/i)?.[0] || targetBlock.content.slice(0, 1500))
      : targetBlock.content.slice(0, 2000);

    const repairPrompt =
`Fix these specific issues in ${targetPath}. Return ONLY the corrected complete file content.
No fences, no FILE comment, no explanation.

ISSUES:
${issues.map(i => `• ${i}`).join('\n')}

RULES:
• React JSX must be INLINE in <script type="text/babel"> — never src= attribute
• CDN URLs must be exactly:
  https://unpkg.com/react@18/umd/react.development.js
  https://unpkg.com/react-dom@18/umd/react-dom.development.js
  https://unpkg.com/babel-standalone@7/babel.min.js
• API calls must use relative URLs: fetch('/api/route')

CURRENT FILE (relevant section):
${contentToSend}`;

    try {
      const fixed = await geminiPool.pooledGenerate({
        contents: [{ role: 'user', parts: [{ text: repairPrompt }] }],
        config:   { temperature: 0.1, maxOutputTokens: 8192 },
        apiKey,
      });

      if (fixed && fixed.trim().length > 100) {
        // Determine the correct fence language for this file
        const ext = targetPath.split('.').pop();
        const lang = ext === 'html' ? 'html' : ext === 'css' ? 'css' :
                     ext === 'go' ? 'go' : ext === 'py' ? 'python' :
                     ext === 'json' ? 'json' : 'javascript';
        const newBlock = `\`\`\`${lang}\n// FILE: ${targetPath}\n${fixed.trim()}\n\`\`\``;
        attempt1Result = attempt1Result.replace(targetBlock.full, newBlock);
        console.log(`[SemanticRepair] Attempt 1 ✅ repaired ${targetPath}`);
      }
    } catch (err) {
      console.warn(`[SemanticRepair] Attempt 1 failed for ${targetPath}:`, err.message);
    }
  }

  return attempt1Result;
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

  // ── Audit 1 ───────────────────────────────────────────────────────
  const audit1 = await semanticAudit(generatedText, requirements, apiKey);
  console.log(`[SemanticAudit] ${audit1.passed ? '✅ PASS' : `❌ FAIL — ${audit1.issues.length} issue(s): ${audit1.issues.slice(0,2).join(' | ')}`}`);
  if (audit1.passed) return generatedText;

  // ── Attempt 1: Targeted file repair ──────────────────────────────
  let afterAttempt1 = generatedText;
  try {
    afterAttempt1 = await semanticRepair(generatedText, audit1.issues, requirements, apiKey);
  } catch (err) {
    if (err.code === 'NEEDS_REGENERATION') throw err;
    console.warn('[SemanticRepair] Attempt 1 non-fatal:', err.message);
  }

  const audit2 = await semanticAudit(afterAttempt1, requirements, apiKey);
  console.log(`[SemanticAudit] After attempt 1: ${audit2.passed ? '✅ PASS' : `❌ FAIL — ${audit2.issues.slice(0,2).join(' | ')}`}`);
  if (audit2.passed) return afterAttempt1;

  // ── Attempt 2: Full regeneration with compact prompt ─────────────
  console.log('[SemanticRepair] Attempt 2 — full regeneration with compact prompt');
  let afterAttempt2 = afterAttempt1;
  try {
    let regenResult = '';
    await geminiPool.pooledStream({
      contents: [{
        role: 'user',
        parts: [{ text:
`REGENERATE this application from scratch. Previous attempt had issues.

ISSUES TO FIX:
${audit2.issues.map(i => `• ${i}`).join('\n')}

REQUIREMENTS:
${requirements.slice(0, 2000)}

RULES:
• React JSX MUST be inline in <script type="text/babel"> — NEVER src= attribute
• CDN URLs MUST be exactly:
  https://unpkg.com/react@18/umd/react.development.js
  https://unpkg.com/react-dom@18/umd/react-dom.development.js
  https://unpkg.com/babel-standalone@7/babel.min.js
• API calls: fetch('/api/route') — NEVER hardcoded localhost
• Implement core features only — do NOT pad with extras
• Every code block MUST be complete with closing fence

Start with REPO_NAME: then output all files completely.`
        }]
      }],
      config:            { temperature: 0.3, maxOutputTokens: 32768 },
      apiKey,
      systemInstruction: '',
      onChunk: () => {},
      onDone:  (text) => { regenResult = text; },
    });
    if (regenResult && regenResult.length > 200) {
      afterAttempt2 = regenResult;
      console.log('[SemanticRepair] Attempt 2 ✅ regeneration complete');
    }
  } catch (err) {
    console.warn('[SemanticRepair] Attempt 2 failed:', err.message);
  }

  const audit3 = await semanticAudit(afterAttempt2, requirements, apiKey);
  console.log(`[SemanticAudit] After attempt 2: ${audit3.passed ? '✅ PASS' : `❌ FAIL — ${audit3.issues.slice(0,2).join(' | ')}`}`);
  if (audit3.passed) return afterAttempt2;

  // ── Attempt 3: Senior developer diagnosis ─────────────────────────
  // Reads spec + broken output side by side, diagnoses root cause,
  // generates targeted fix — different from attempt 2 (reasons first)
  console.log('[SemanticRepair] Attempt 3 — senior developer diagnosis');
  let afterAttempt3 = afterAttempt2;
  try {
    const diagnosisPrompt =
`You are a senior full-stack developer doing a code review.

SPECIFICATION:
${requirements.slice(0, 1500)}

REMAINING ISSUES after 2 repair attempts:
${audit3.issues.map(i => `• ${i}`).join('\n')}

CURRENT OUTPUT (excerpt):
${afterAttempt2.slice(0, 3000)}

Think through WHY each issue exists, then fix ALL of them.
Return the complete corrected output with all files.
Start with REPO_NAME: then output all files.`;

    let diagResult = '';
    await geminiPool.pooledStream({
      contents: [{ role: 'user', parts: [{ text: diagnosisPrompt }] }],
      config:   { temperature: 0.2, maxOutputTokens: 32768 },
      apiKey,
      systemInstruction: '',
      onChunk: () => {},
      onDone:  (text) => { diagResult = text; },
    });
    if (diagResult && diagResult.length > 200) {
      afterAttempt3 = diagResult;
      console.log('[SemanticRepair] Attempt 3 ✅ diagnosis complete');
    }
  } catch (err) {
    console.warn('[SemanticRepair] Attempt 3 failed:', err.message);
  }

  const audit4 = await semanticAudit(afterAttempt3, requirements, apiKey);
  console.log(`[SemanticAudit] After attempt 3: ${audit4.passed ? '✅ PASS' : '⚠️ issues remain — deploying best version'}`);

  // Always return best version — never deploy original broken output
  return afterAttempt3;
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

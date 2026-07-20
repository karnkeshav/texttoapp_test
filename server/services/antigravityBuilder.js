'use strict';
/**
 * Antigravity Builder — Multi-step reasoning agent for complete app generation
 *
 * Replaces 12-stage pipeline (brief → build → audit → repair → dryrun → deploy)
 * with one powerful agent call that:
 * - Analyzes specification deeply
 * - Plans architecture
 * - Generates complete code
 * - Self-audits against requirements
 * - Self-repairs any issues
 * - Returns production-ready output
 *
 * Single API call: ~4-5k tokens, ~5-10s latency, 0 fallback complexity
 */

const axios = require('axios');

const ANTIGRAVITY_SYSTEM = `You are Ready4Launch Agent — an elite multi-step code generation system.

TASK WORKFLOW:
1. UNDERSTAND: Deeply analyze the specification and requirements
2. PLAN: Design complete file structure and architecture
3. GENERATE: Write all code files completely and correctly
4. AUDIT: Check code against spec — find ANY issues
5. REPAIR: Fix issues yourself before returning code
6. VERIFY: Confirm the fix works and meets all requirements

CRITICAL RULES:
• Generate COMPLETE files — never truncate code blocks
• Every <script> tag MUST close with </script>
• React JSX MUST be inline in <script type="text/babel"> — NEVER src= attribute
• CDN URLs must be development builds:
  https://unpkg.com/react@18/umd/react.development.js
  https://unpkg.com/react-dom@18/umd/react-dom.development.js
  https://unpkg.com/babel-standalone@7/babel.min.js
• API calls MUST use relative URLs: fetch('/api/route') — NO localhost
• Backend files at ROOT level — no nested backend/ or frontend/ directories
• Go backend serves public/ directory via http.FileServer
• NEVER use relative imports like '../'. Use absolute paths from root
• Package.json must list ALL dependencies explicitly

OUTPUT FORMAT:
Return the final, audited, working code with:
REPO_NAME: [name]
[All files with proper ``` code fences — each file must be complete]
AUDIT_RESULT: [PASS/FAIL with explanation of what works and any issues fixed]`;

/**
 * Build complete app using Antigravity Agent
 * @param {string} brief - Semantic brief with full specification
 * @param {object} stack - Tech stack {frontend, backend, type}
 * @param {string} apiKey - Google API key
 * @returns {Promise<string>} Complete code output
 */
async function buildWithAntigravity(brief, stack, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  if (!brief) throw new Error('Brief is required');

  const buildPrompt = `
${ANTIGRAVITY_SYSTEM}

SPECIFICATION:
${brief}

TECH STACK:
Frontend: ${stack?.frontend || 'html'}
Backend: ${stack?.backend || 'none'}
Type: ${stack?.type || 'static'}
Deployment: ${stack?.backend && stack.backend !== 'none' ? 'localhost' : 'github-pages'}

Now execute the 6-step workflow and return perfect, tested, production-ready code.`;

  console.log('[AntigravityBuilder] Starting multi-step code generation…');
  console.log('[AntigravityBuilder] Brief length:', brief.length, 'chars');

  try {
    const startTime = Date.now();

    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      {
        agent: 'antigravity-preview-05-2026',
        input: buildPrompt,
        environment: { type: 'remote_sandbox' }
      },
      {
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 600000 // 10 min for reasoning
      }
    );

    const elapsed = Date.now() - startTime;
    const usage = response.data.usage || {};

    console.log('[AntigravityBuilder] ✅ Complete in', elapsed + 'ms');
    console.log('[AntigravityBuilder] Tokens:', {
      input: usage.total_input_tokens,
      output: usage.total_output_tokens,
      thought: usage.total_thought_tokens,
      total: usage.total_tokens
    });

    if (response.data.status !== 'completed') {
      throw new Error(`Agent status: ${response.data.status}`);
    }

    // Extract output from steps
    const steps = response.data.steps || [];
    if (steps.length === 0) {
      throw new Error('No output from agent');
    }

    const output = steps[0]?.content?.[0]?.text || '';
    if (!output) {
      throw new Error('Empty output from agent');
    }

    // Log audit result if present
    if (output.includes('AUDIT_RESULT:')) {
      const auditMatch = output.match(/AUDIT_RESULT:\s*(.+?)(?:\n\n|$)/s);
      if (auditMatch) {
        console.log('[AntigravityBuilder] Audit:', auditMatch[1].trim().split('\n')[0]);
      }
    }

    return output;

  } catch (err) {
    const status = err.response?.status || 'network error';
    const message = err.response?.data?.error?.message || err.message;
    console.error(`[AntigravityBuilder] ❌ Failed (${status}): ${message}`);
    throw err;
  }
}

module.exports = { buildWithAntigravity };

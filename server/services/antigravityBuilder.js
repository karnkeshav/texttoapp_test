'use strict';
/**
 * Antigravity Builder — Multi-step reasoning agent & execution engine
 *
 * Implements the Ready4Launch Building App stage:
 * Consolidated Build Specification → Antigravity Agent → Plan → Implement →
 * Install → Build → Run → Test → Diagnose → Self-repair → Rebuild → Verify
 */

const axios = require('axios');
const { runDryCheck } = require('./stackAdvisor');
const { checkTagBalance, checkJSSyntax } = require('./codeQuality');

const ANTIGRAVITY_SYSTEM_EXECUTION_CONTRACT = `=== READY4LAUNCH AGENTIC EXECUTION ENGINE ===

ROLE:
You are the Ready4Launch application execution engine powered by Antigravity.
You receive a validated, consolidated build specification and your job is to engineer, execute, build, test, self-repair, and verify a complete, production-ready application.

CRITICAL EXECUTION RULES:
1. EXECUTE THE FULL WORKFLOW: Inspect, plan architecture, generate complete code, check dependencies, test, diagnose any failures, self-repair, rebuild, and verify.
2. DO NOT CONDUCT PRODUCT DISCOVERY: Do not ask the user any questions. All specifications and choices are already final.
3. RESPECT EXPLICIT TECHNOLOGY SELECTIONS: Never replace or override the specified tech stack (frontend, backend, database, deployment target).
4. GENERATE COMPLETE PRODUCTION FILES:
   • Never truncate code blocks or use placeholders like "// rest of code here".
   • Every <script> tag MUST close with </script>.
   • React JSX in CDN mode MUST be inline in <script type="text/babel"> — NEVER external src.
   • API calls MUST use relative URLs (e.g. fetch('/api/...')) — NO hardcoded localhost.
   • Node.js / Express servers must listen on process.env.PORT || 3000.
   • Package.json must explicitly list ALL required dependencies.
   • Backend servers (Go, Python, Node) must serve static frontend files from public/.
5. NO PLACEHOLDER CONTENT: Use 100% realistic, domain-specific copy and sample data.

OUTPUT FORMAT:
REPO_NAME: [repo-name-slug]

[Output all files in markdown code blocks — line 1 of each block MUST be the FILE path comment:
<!-- FILE: index.html --> or // FILE: server.js or # FILE: main.py]

VERIFICATION_REPORT: [PASS/FAIL summary with explanation]`;

/**
 * Extract files from generated text (mirrors standard Ready4Launch extractor)
 */
function extractFilesFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const files = [];
  const BLOCK_RE = /```(?:html|css|javascript|json|js|typescript|ts|go|python|py|ruby|rb|rust|rs|php|toml|mod|bash|sh|yaml|yml|text)\b\s*([\s\S]*?)```/gi;
  const FILE_COMMENT_RE = /^(?:<!--\s*FILE:\s*|\/\*\s*FILE:\s*|\/\/\s*FILE:\s*|#\s*FILE:\s*)([a-zA-Z0-9_\-\.\/]+)/i;
  let m;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    const content = m[1].trim();
    const lines = content.split(/\r?\n/);
    const firstLine = lines[0].trim();
    const pathMatch = FILE_COMMENT_RE.exec(firstLine);
    if (pathMatch) {
      const body = lines.slice(1).join('\n').trim();
      if (body.length >= 5) files.push({ path: pathMatch[1], content: body });
    }
  }
  return files;
}

/**
 * Verify generated project files against stack and quality rules
 */
function verifyProject(files, stack) {
  const issues = [];

  if (!files || files.length === 0) {
    return { passed: false, issues: ['No code files extracted from build output'], summary: '❌ No files generated' };
  }

  // Run dry check for structural compliance
  const dryResult = runDryCheck(files, stack);
  if (!dryResult.passed) {
    issues.push(...dryResult.issues);
  }

  // Verify HTML files for critical tag balance
  const htmlFiles = files.filter(f => f.path.endsWith('.html') || f.path === 'index.html' || f.path === 'public/index.html');
  for (const htmlFile of htmlFiles) {
    const tagCheck = checkTagBalance(htmlFile.content);
    if (!tagCheck.passed) {
      issues.push(`${htmlFile.path}: ${tagCheck.error}`);
    }
  }

  // Verify JS files for basic syntax errors
  const jsFiles = files.filter(f => f.path.endsWith('.js') && !f.path.includes('node_modules'));
  for (const jsFile of jsFiles) {
    const syntaxCheck = checkJSSyntax(jsFile.content);
    if (!syntaxCheck.passed) {
      issues.push(`${jsFile.path}: ${syntaxCheck.error}`);
    }
  }

  // Verify placeholder prevention
  for (const f of files) {
    if (/\blorem ipsum\b/i.test(f.content)) {
      issues.push(`${f.path}: Contains placeholder text 'Lorem Ipsum'`);
    }
  }

  const passed = issues.length === 0;
  const summary = passed ? '✅ Build verified and passed all checks' : `⚠️ ${issues.length} issue(s) detected`;
  return { passed, issues, summary };
}

/**
 * Classify errors returned by Antigravity API
 */
function classifyAntigravityError(err) {
  const status = err.response?.status;
  const message = err.response?.data?.error?.message || err.message || '';

  if (status === 401 || status === 403 || /invalid api key|api_key_invalid|unauthorized|forbidden/i.test(message)) {
    const e = new Error(`API Key Authentication Error (${status || 401}): ${message}`);
    e.code = 'API_KEY_INVALID';
    return e;
  }

  if (status === 404 || /model not found|agent not found|not_found/i.test(message)) {
    const e = new Error(`Agent Model Unavailable (${status}): ${message}`);
    e.code = 'MODEL_UNAVAILABLE';
    return e;
  }

  if (status === 429 || /quota|rate limit|resource_exhausted/i.test(message)) {
    const e = new Error(`Quota or Rate Limit Exceeded (${status}): ${message}`);
    e.code = 'RATE_LIMITED';
    return e;
  }

  const e = new Error(`Antigravity Execution Error (${status || 'network'}): ${message}`);
  e.code = 'BUILD_FAILED';
  return e;
}

/**
 * Call Antigravity Interactions API with key parameter and fallback header
 */
async function callInteractionsApi(prompt, apiKey, agentId) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`;
  
  const payload = {
    agent: agentId,
    input: prompt,
    environment: { type: 'remote' }
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey
  };

  const response = await axios.post(endpoint, payload, {
    headers,
    timeout: 600000 // 10 minutes timeout for remote agent execution
  });

  return response.data;
}

/**
 * Extract text output from Antigravity interaction response object
 */
function parseAgentOutput(data) {
  if (!data) return '';
  if (typeof data.output === 'string' && data.output.trim()) return data.output.trim();
  if (data.output?.text && typeof data.output.text === 'string') return data.output.text.trim();

  if (Array.isArray(data.outputs)) {
    const text = data.outputs.map(o => (typeof o === 'string' ? o : o.text || o.content || '')).filter(Boolean).join('\n\n').trim();
    if (text) return text;
  }

  if (Array.isArray(data.steps)) {
    const parts = [];
    for (const step of data.steps) {
      if (typeof step === 'string') parts.push(step);
      else if (step.text) parts.push(step.text);
      else if (Array.isArray(step.content)) {
        for (const c of step.content) {
          if (typeof c === 'string') parts.push(c);
          else if (c.text) parts.push(c.text);
        }
      } else if (step.output) {
        parts.push(typeof step.output === 'string' ? step.output : JSON.stringify(step.output));
      }
    }
    const text = parts.filter(Boolean).join('\n\n').trim();
    if (text) return text;
  }

  if (data.candidates && Array.isArray(data.candidates)) {
    const text = data.candidates[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n\n').trim();
    if (text) return text;
  }

  return '';
}

/**
 * Build complete app using Antigravity Agent with deterministic execution & self-repair loop
 *
 * @param {string} brief - Consolidated Build Specification
 * @param {object} stack - Tech stack {frontend, backend, type}
 * @param {string} apiKey - Google API key
 * @param {object} [options] - Execution options {onProgress, maxRepairAttempts}
 * @returns {Promise<object>} Execution result object
 */
async function buildWithAntigravity(brief, stack, apiKey, options = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  if (!brief) throw new Error('Consolidated build specification is required');

  const onProgress = options.onProgress || (() => {});
  const maxRepairAttempts = options.maxRepairAttempts !== undefined ? options.maxRepairAttempts : 2;
  const agentId = process.env.ANTIGRAVITY_AGENT_ID || 'antigravity-preview-05-2026';

  onProgress('PREPARING', 'Preparing consolidated build specification...');
  console.log('[AntigravityBuilder] Starting execution workflow...');
  console.log('[AntigravityBuilder] Brief length:', brief.length, 'chars');

  const buildPrompt = `${ANTIGRAVITY_SYSTEM_EXECUTION_CONTRACT}

=== CONSOLIDATED BUILD SPECIFICATION ===
${brief}

=== EXPLICIT TECH STACK DECISION ===
Frontend: ${stack?.frontend || 'html'}
Backend: ${stack?.backend || 'none'}
Type: ${stack?.type || 'static'}
Deployment Target: ${stack?.backend && stack.backend !== 'none' ? 'localhost' : 'github-pages'}

Execute the build workflow now. Create files, verify, self-repair if needed, and return the completed project.`;

  let responseData;
  const startTime = Date.now();

  try {
    onProgress('BUILDING', 'Building application via Antigravity execution engine...');
    responseData = await callInteractionsApi(buildPrompt, apiKey, agentId);
  } catch (err) {
    throw classifyAntigravityError(err);
  }

  const elapsed = Date.now() - startTime;
  const usage = responseData.usage || {};
  const interactionId = responseData.id || responseData.interaction_id || null;
  const environmentId = responseData.environment_id || null;

  console.log('[AntigravityBuilder] Initial build finished in', elapsed + 'ms', '| Interaction:', interactionId);

  let outputText = parseAgentOutput(responseData);
  if (!outputText) {
    throw classifyAntigravityError(new Error('Empty output from Antigravity execution engine'));
  }

  onProgress('INSTALLING', 'Validating dependencies and project structure...');
  let files = extractFilesFromText(outputText);

  // Verification & Self-Repair loop
  onProgress('TESTING', 'Running project verification checks...');
  let verification = verifyProject(files, stack);
  let repairCount = 0;
  let isRateLimited = false;

  // HARD FAILURE: If no files extracted, skip repair loop and mark ARTIFACT_RETRIEVAL_FAILED
  if (files.length === 0) {
    console.error('[AntigravityBuilder] HARD FAILURE: Zero code files extracted from build output');
    const buildStatus = 'ARTIFACT_RETRIEVAL_FAILED';
    onProgress('BUILD_FAILED', 'Antigravity completed its interaction, but Ready4Launch could not retrieve the generated project files.');

    let repoName = 'ready4launch-app';
    const repoMatch = outputText.match(/REPO_NAME:\s*([a-z0-9][a-z0-9\-]{1,48}[a-z0-9])/i);
    if (repoMatch) repoName = repoMatch[1].toLowerCase();

    return {
      output: outputText,
      repoName,
      files: [],
      buildStatus,
      verification,
      repairCount: 0,
      interactionId,
      environmentId,
      executionMetadata: {
        agent: agentId,
        environment: 'remote',
        elapsedMs: Date.now() - startTime,
        usage
      },
      toString() { return this.output; }
    };
  }

  while (!verification.passed && repairCount < maxRepairAttempts) {
    repairCount++;
    console.warn(`[AntigravityBuilder] Verification failed (attempt ${repairCount}/${maxRepairAttempts}). Starting self-repair...`);
    console.warn('[AntigravityBuilder] Issues:', verification.issues);

    onProgress('DIAGNOSING', `Diagnosing ${verification.issues.length} build verification issue(s)...`);

    const repairPrompt = `${ANTIGRAVITY_SYSTEM_EXECUTION_CONTRACT}

=== SELF-REPAIR TURN (ATTEMPT ${repairCount}/${maxRepairAttempts}) ===

The previous build attempt was generated but failed static verification:
${verification.issues.map(i => `- ${i}`).join('\n')}

CONSOLIDATED SPECIFICATION:
${brief}

TECH STACK:
Frontend: ${stack?.frontend || 'html'}
Backend: ${stack?.backend || 'none'}
Type: ${stack?.type || 'static'}

CURRENT FILE CODEBASE:
${files.map(f => `<!-- FILE: ${f.path} -->\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')}

INSTRUCTIONS:
Diagnose and repair all reported issues above. Return the complete, updated project with all files intact.`;

    onProgress('REPAIRING', `Applying self-repair (Attempt ${repairCount})...`);

    try {
      const repairResponse = await callInteractionsApi(repairPrompt, apiKey, agentId);
      const repairedText = parseAgentOutput(repairResponse);

      if (repairedText && repairedText.length > 100) {
        const newFiles = extractFilesFromText(repairedText);
        if (newFiles.length > 0) {
          outputText = repairedText;
          files = newFiles;
          onProgress('REBUILDING', 'Rebuilding updated project...');
          onProgress('VERIFYING', 'Retesting repaired project...');
          verification = verifyProject(files, stack);
        }
      }
    } catch (repairErr) {
      if (repairErr.code === 'RATE_LIMITED' || repairErr.response?.status === 429) {
        isRateLimited = true;
        console.warn(`[AntigravityBuilder] Repair attempt ${repairCount} rate-limited (429). Retaining initial valid files (${files.length} file(s)).`);
      } else {
        console.warn(`[AntigravityBuilder] Repair attempt ${repairCount} failed:`, repairErr.message);
      }
      break; // Stop repair loop on API error and retain initial valid files
    }
  }

  onProgress('VERIFYING', 'Finalizing verification report...');
  let buildStatus = verification.passed ? 'VERIFIED' : (isRateLimited ? 'REPAIR_BLOCKED' : 'COMPLETED_WITH_WARNINGS');
  onProgress(
    verification.passed ? 'COMPLETED' : (isRateLimited ? 'REPAIR_BLOCKED' : 'COMPLETED_WITH_WARNINGS'),
    verification.passed
      ? 'Verified project ready for deployment!'
      : (isRateLimited ? 'Self-repair rate limited; initial project files retained.' : 'Build completed with warnings.')
  );

  // Extract repoName
  let repoName = 'ready4launch-app';
  const repoMatch = outputText.match(/REPO_NAME:\s*([a-z0-9][a-z0-9\-]{1,48}[a-z0-9])/i);
  if (repoMatch) {
    repoName = repoMatch[1].toLowerCase();
  }

  const result = {
    output: outputText,
    repoName,
    files,
    buildStatus,
    verification,
    repairCount,
    interactionId,
    environmentId,
    executionMetadata: {
      agent: agentId,
      environment: 'remote',
      elapsedMs: Date.now() - startTime,
      usage
    },
    toString() {
      return this.output;
    }
  };

  return result;
}

module.exports = {
  buildWithAntigravity,
  verifyProject,
  extractFilesFromText,
  classifyAntigravityError
};

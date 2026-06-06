'use strict';
/**
 * Chat route — state machine for Prototype vs Complete mode.
 *
 * Conversation phases (stored in session):
 *
 *  init              → first message: run plan phase, send MODE_QUESTION, → 'mode'
 *  mode              → user picks prototype or complete
 *                        prototype → send style question         → 'prototype_style'
 *                        complete  → send Q1 of 5               → 'complete_questioning'
 *  prototype_style   → style answer received → build            → 'building'
 *  complete_questioning → Q1–Q5; after Q5: compile spec → build → 'building'
 *  building          → streaming generation; subsequent messages also stay 'building'
 *                        (user can keep refining the app)
 *
 * Edit mode (existing repo):
 *  Triggered by { editMode: true, editOwner, editRepo } in request body.
 *  Fetches current index.html, injects it + change request into prompt, skips mode Q.
 *  Done event carries { editMode, editOwner, editRepo } so frontend shows Push button.
 */

const express = require('express');
const antigravity    = require('../services/antigravity');
const { analyzePlanPhase, compileSpec } = require('../services/planPhase');
const { getFileContent } = require('../services/githubService');
const { fullQualityPass } = require('../services/codeQuality');
const { pooledStream, pooledGenerate } = require('../services/geminiPool');
const { checkGate, quickSection } = require('../middleware/packageGate');
const { recordSession } = require('../services/firestoreService');
const { getStackQuestions, buildStackContext, getDeploymentMode, runDryCheck } = require('../services/stackAdvisor');

const router = express.Router();

// ── Detect stack from existing code ────────────────────────────────────
// Analyzes HTML + checks for package.json and server files
async function detectStackFromCode(htmlCode, token, owner, repo) {
  if (!htmlCode) return { frontend: 'html', backend: 'none', type: 'static' };

  const code = htmlCode.toLowerCase();
  let frontend = 'html';
  let backend = 'none';
  let type = 'static';

  // 🔴 FIX #4: PROPER BACKEND DETECTION BY FILE TYPE
  // Don't check package.json for Python/Go/Java/C# — check their actual config files!
  let hasNodeBackend = false;
  let hasPythonBackend = false;
  let hasJavaBackend = false;
  let hasGoBackend = false;
  let hasCsharpBackend = false;
  let hasReact = false, hasVue = false, hasAngular = false, hasNuxt = false, hasNext = false, hasSvelte = false;

  try {
    if (token && owner && repo) {
      // STEP 1A: Check package.json for FRONTEND frameworks + Node.js backend only
      const pkgJson = await getFileContent(token, owner, repo, 'package.json');
      if (pkgJson) {
        try {
          const pkg = JSON.parse(pkgJson);
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };

          // Check for FRONTEND frameworks (these ARE in package.json)
          hasReact = deps.react !== undefined;
          hasVue = deps.vue !== undefined;
          hasAngular = deps['@angular/core'] !== undefined;
          hasSvelte = deps.svelte !== undefined;
          hasNext = deps.next !== undefined;
          hasNuxt = deps.nuxt !== undefined;

          // Check for Node.js backend ONLY (this IS in package.json)
          hasNodeBackend = deps.express !== undefined || deps.fastify !== undefined || deps.hapi !== undefined;

          if (hasNext) frontend = 'nextjs';
          else if (hasNuxt) frontend = 'nuxtjs';
          else if (hasReact) frontend = 'react';
          else if (hasVue) frontend = 'vue';
          else if (hasAngular) frontend = 'angular';
          else if (hasSvelte) frontend = 'svelte';

          if (hasNodeBackend) backend = 'nodejs';

          console.log(`[StackDetect] From package.json: frontend=${frontend}, backend=${backend}`);
        } catch (parseErr) {
          console.warn('[StackDetect] Could not parse package.json:', parseErr.message);
        }
      }

      // STEP 1B: Check for Python backend (requirements.txt, pyproject.toml, Pipfile)
      if (backend === 'none') {
        const requirements = await getFileContent(token, owner, repo, 'requirements.txt');
        const pyproject = await getFileContent(token, owner, repo, 'pyproject.toml');
        const pipfile = await getFileContent(token, owner, repo, 'Pipfile');

        if (requirements || pyproject || pipfile) {
          hasPythonBackend = true;
          backend = 'python';
          console.log('[StackDetect] Python backend detected: found requirements.txt/pyproject.toml/Pipfile');
        }
      }

      // STEP 1C: Check for Go backend (go.mod, go.sum)
      if (backend === 'none') {
        const gomod = await getFileContent(token, owner, repo, 'go.mod');
        const gosum = await getFileContent(token, owner, repo, 'go.sum');

        if (gomod || gosum) {
          hasGoBackend = true;
          backend = 'go';
          console.log('[StackDetect] Go backend detected: found go.mod/go.sum');
        }
      }

      // STEP 1D: Check for Java backend (pom.xml, build.gradle, gradle.build)
      if (backend === 'none') {
        const pomxml = await getFileContent(token, owner, repo, 'pom.xml');
        const buildgradle = await getFileContent(token, owner, repo, 'build.gradle');

        if (pomxml || buildgradle) {
          hasJavaBackend = true;
          backend = 'java';
          console.log('[StackDetect] Java backend detected: found pom.xml/build.gradle');
        }
      }

      // STEP 1E: Check for C# backend (.csproj, .sln)
      if (backend === 'none') {
        // List files in root to check for .csproj or .sln
        // For now, check if any HTML mentions common C# patterns
        // This is a limitation of the single-file check approach
        if (code.includes('csproj') || code.includes('dotnet') || code.includes('aspnet')) {
          hasCsharpBackend = true;
          backend = 'csharp';
          console.log('[StackDetect] C# backend suspected: found .net/aspnet references');
        }
      }

    }
  } catch (e) {
    console.log('[StackDetect] Error during backend detection:', e.message);
  }

  // ── STEP 2: Fallback to HTML analysis for FRONTEND frameworks only ──
  // ⚠️ NOTE: HTML hints can't reliably detect non-Node.js backends
  // Those require proper file detection (requirements.txt, go.mod, pom.xml, etc.)
  if (frontend === 'html') {
    // Only if we didn't find framework in package.json
    if (code.includes('react') && code.includes('reactdom')) frontend = 'react';
    else if (code.includes('vue') && code.includes('vue.global')) frontend = 'vue';
    else if (code.includes('angular')) frontend = 'angular';
    else if (code.includes('svelte')) frontend = 'svelte';
    else if (code.includes('next')) frontend = 'nextjs';
    else if (code.includes('nuxt')) frontend = 'nuxtjs';
  }

  // ── STEP 3: Only HTML hints for Node.js (can appear in HTML) ────
  // 🔴 FIX #4: Removed HTML hints for Python/Go/Java/C#
  // Those MUST be detected by their proper config files (Step 1B-E)
  // Checking HTML for "gin" or "spring" is unreliable
  if (backend === 'none') {
    if (code.includes('express') || code.includes('server.js') || code.includes('app.js')) {
      backend = 'nodejs';
    }
    // ⚠️ REMOVED: Flask, Django, Gin, Echo, Spring, AspNet checks
    // These are NOT reliable from HTML content
    // They MUST be detected from their actual config files
  }

  // ── STEP 4: Detect type ────────────────────────────────────────────────
  if (code.includes('manifest.json') && code.includes('service-worker')) {
    type = 'pwa';
  } else if (frontend === 'nextjs' || frontend === 'nuxtjs') {
    type = 'ssr';
  } else if (backend && backend !== 'none') {
    // Has any backend (Node.js, Python, Java, Go, C#) → dynamic/SPA
    type = 'spa';
  } else if (frontend !== 'html') {
    // Frontend without backend (React/Vue/Angular/Svelte CDN) → SPA
    type = 'spa';
  } else {
    // Plain HTML, no backend → static
    type = 'static';
  }

  const result = { frontend, backend, type };
  console.log(`[StackDetect] Final detection: ${JSON.stringify(result)}`);
  return result;
}

// ── Extract generated files from AI response text (mirrors app.js logic) ──
function extractFilesFromText(text) {
  const files = [];
  const BLOCK_RE = /```(?:html|css|javascript|js|json|typescript|ts|go|python|py|ruby|rb|rust|rs|php|toml|mod|bash|sh|yaml|yml)\s*([\s\S]*?)```/gi;
  const FILE_COMMENT_RE = /^(?:<!--\s*FILE:\s*|\/\*\s*FILE:\s*|\/\/\s*FILE:\s*|#\s*FILE:\s*)([^\s*>]+)/i;
  let m;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    const content   = m[1].trim();
    const firstLine = content.split('\n')[0];
    const pathMatch = FILE_COMMENT_RE.exec(firstLine);
    if (pathMatch) {
      const body = content.split('\n').slice(1).join('\n').trim();
      if (body.length >= 10) files.push({ path: pathMatch[1], content: body });
    }
  }
  return files;
}

// ── Fixed mode question ───────────────────────────────────────────
const MODE_QUESTION = `One quick question before I start — what are we building?

🚀 **Prototype** — A polished single-page app with 5+ smooth-scrolling sections, done fast. Perfect for validating ideas or sharing a preview.

📦 **Complete Product** — I'll ask you 5 focused questions (end goal, audience, features, tech needs, style) and build a production-ready app that matches your full vision exactly.

Which would you like?`;

// ── Complete-mode questions (Q1–Q5, asked one per turn) ──────────
const COMPLETE_QUESTIONS = [
  `Let's build this properly. 🎯

**Question 1 of 5 — End goal:** When someone finishes using this app, what did they accomplish? What's the core job-to-be-done? Be as specific as you like — what data do they enter, what does the app show them, what's the main outcome?`,

  `**Question 2 of 5 — Your users:** Who will use this app? (e.g. "internal team of 8", "restaurant customers", "students aged 16–22", "general public") — the more specific, the better the result.`,

  `**Question 3 of 5 — Must-have features:** List the 3–5 features that absolutely must work at launch. Anything that's nice-to-have but not critical? (Say "none" for the optional part if you prefer.)`,

  `**Question 4 of 5 — Technical needs:** Any specific requirements?
• Should it save data between visits (localStorage)?
• Mobile-first or desktop-first?
• Need to export/import data (CSV, PDF)?
• Any third-party integrations?

(Just say "none" if nothing applies)`,

  `**Question 5 of 5 — Style & feel:** Last one! Dark or light? Minimal or bold? Elegant or playful? Name a colour palette, a brand you like, or describe the mood — even rough ideas help.`,
];

// ── Helpers ───────────────────────────────────────────────────────
const FRAMEWORK_RE = /\b(react|vue|angular|next\.?js|nuxt\.?js|svelte|gatsby|remix|typescript|webpack|vite)\b/i;

/**
 * Returns true when the user's message is a question about the code
 * (explain, describe, what is X) rather than a request to change it.
 * Build/change verbs always win — if both patterns match, treat as edit.
 */
function isConversationalIntent(message) {
  const m = message.toLowerCase().trim();

  // Strip negated build verbs FIRST — "don't build", "dont create", "not now"
  // so "give me details, dont build now" doesn't falsely trigger build detection.
  const withoutNegations = m.replace(
    /\b(don'?t|do not|not|never|without|no)\s+(build|create|make|add|implement|generate|change|modify|update|fix|improve|refactor|redesign|remove|delete|replace|rewrite)\b/g,
    ''
  );

  // Explicit build/change intent (after removing negations) → treat as edit
  if (/\b(add|build|create|make|implement|generate|change|modify|update|fix|improve|refactor|redesign|remove|delete|replace|rewrite|style|design|feature|button|form|menu|chart|graph)\b/.test(withoutNegations)) {
    return false;
  }

  // Question openers, information-seeking patterns, or explicit "don't build" language
  return (
    /^(what|how|why|when|where|which|who)\b/.test(m) ||
    /\?/.test(m) ||
    /\b(don'?t build|dont build|not build|first give|give me (the )?details?|tell me (about|more)|just (tell|explain|describe)|show me|walk me through|explain|describe|summarize|overview|purpose|what does|what is|what are|how does|how do|analyze|analyse|understand|review|flow|architecture|structure|codebase|logic|working|works)\b/.test(m)
  );
}

// ── Code-paste detector ───────────────────────────────────────────
// Returns true when the message looks like pasted source code rather than
// a natural-language request. Used to avoid routing code snippets into the
// prototype/complete app-building state machine.
const CODE_LINE_RE = /^\s*(?:function\s|class\s|const\s|let\s|var\s|import\s|export\s|def\s|return\s|public\s|private\s|protected\s|async\s|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|try\s*\{|\/\/|\/\*|\*\/|#\s*include|package\s|using\s|<\?php|<!DOCTYPE|<html|<div|<style|<script|\{|\})/i;

function looksLikeCode(message) {
  const lines = message.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 3) return false; // too short to be a code snippet
  const codeLines = lines.filter(l => CODE_LINE_RE.test(l));
  return codeLines.length >= 2; // ≥2 code-like lines out of ≥3 total
}

// ── Top-level intent classifier ───────────────────────────────────
// Runs on the VERY FIRST message of a new conversation (before the build
// state machine starts).  Returns one of:
//   'build'      → enter prototype/complete state machine (existing flow)
//   'conversion' → one-shot: generate formatted content (Word / Excel / CSV / JSON / PPT)
//   'reasoning'  → one-shot: math, logic, analysis  (different system instruction)
//   'chat'       → one-shot: general question or casual conversation

const CONVERSION_RE = /\b(convert|export|save|turn|transform|put)\b.{0,40}\b(word|docx?|excel|xlsx?|spreadsheet|csv|ppt|powerpoint|presentation|json|pdf)\b|\b(word|docx?|excel|xlsx?|csv|ppt|powerpoint|json|pdf)\b.{0,30}\b(file|format|document|version)\b|\b(as|into?|in)\s+a?\s*(word|docx?|excel|xlsx?|csv|ppt|powerpoint|json|pdf)\b/i;

const REASONING_RE  = /\b(calculate|compute|solve|formula|equation|integral|derivative|proof|logic\s*puzzle|what\s+is\s+\d|how\s+many|percentage|convert\s+\d)\b|\d[\d\s]*[\+\-\*\/\^][\d\s\(\)]+=/i;

// Words that strongly signal the user wants to BUILD something (not just chat)
const BUILD_SIGNAL_RE = /\b(build|create|make|generate|develop|design|i want (an?|the)|give me (an?|the)|i need (an?|the))\b.{0,50}\b(app|website|site|page|tool|dashboard|tracker|calculator|game|quiz|platform|portal|landing|shop|store)\b/i;

// Document types that signal conversion intent even without an explicit file format keyword.
// Matches things like "make me a resume", "write a cover letter", "I need a business report".
// Excluded from this if the same message also contains app/site build signals.
const DOCUMENT_TYPE_RE = /\b(resume|cv|curriculum vitae|cover letter|business plan|proposal|report|brief|executive summary|invoice|contract|essay|article|research paper|term paper|memo|memorandum|letter|brochure|flyer|presentation|slide ?deck|deck|pitch ?deck)\b/i;

// Conversion escape phrases used in follow-up turns ("no, I want to convert / document / file")
const CONVERT_ESCAPE_RE = /\b(don'?t|do not|not|no|stop)\b.{0,25}\b(build|app|site|code)\b|\b(convert|document|file|word|pdf|excel|spreadsheet|pptx?|powerpoint)\b.{0,20}\b(it|this|that|please|instead)\b|\b(i (just |only )?(want|need|meant)|actually|instead)\b.{0,30}\b(convert|document|file|word|pdf|excel|resume|report)\b/i;

function classifyTopLevelIntent(message, modeHint) {
  // Honour an explicit mode hint from the frontend welcome card click.
  // This means "make me a resume" in convert mode stays as conversion, not build.
  if (modeHint === 'convert') return 'conversion';
  if (modeHint === 'chat')    return 'chat';

  // Format conversion always wins — very specific signal
  if (CONVERSION_RE.test(message)) return 'conversion';

  // Math / logic / numerical reasoning
  if (REASONING_RE.test(message)) return 'reasoning';

  // Explicit build request (app / website keywords) → state machine
  if (BUILD_SIGNAL_RE.test(message)) return 'build';

  // Document type without app-build context → conversion
  // (e.g. "make me a resume", "write a cover letter", "I need a business proposal")
  if (DOCUMENT_TYPE_RE.test(message) && !BUILD_SIGNAL_RE.test(message)) return 'conversion';

  // Conversational question (no repo context) → one-shot chat
  if (isConversationalIntent(message)) return 'chat';

  // Pasted code without an explicit build instruction → route to chat
  if (looksLikeCode(message)) return 'chat';

  // Default: treat as a build request (existing behaviour)
  return 'build';
}

// ── PPT purpose question (asked before generating any presentation) ──
const PPT_PURPOSE_QUESTION = `Before I build your presentation, one quick question — **what is the purpose of this presentation?**

Please pick the option that best matches:

1️⃣  **Explain ideas, strategies, or business plans** — presenting a concept, proposal, or strategy to an audience
2️⃣  **Teach or train people** — school, college, workshop, or corporate training session
3️⃣  **Present reports, research, or data** — findings, project updates, or data-driven insights to a team/management
4️⃣  **Pitch a product, startup, or proposal** — selling your idea to clients, investors, or decision-makers
5️⃣  **Marketing, seminar, webinar, or public speaking** — engaging a broader audience with visual storytelling

6️⃣  **Other** — describe your purpose briefly and I'll tailor the presentation for you.

Just reply with the number (1–6) or describe it in your own words.`;

// Purpose → slide design & flow guide (injected into the generation prompt)
const PPT_PURPOSE_GUIDES = {
  '1': {
    label: 'Business / Strategy',
    flow: 'Start with the problem → current situation → proposed strategy → expected outcome → roadmap → conclusion. Keep the story logical so the audience feels "this makes sense step by step."',
    look: 'Clean corporate theme with minimal clutter. Use white/light backgrounds with 1–2 brand accent colors. Fonts: Montserrat or Poppins for headings, Calibri/Arial for body. Clean icons and data charts.',
    tone: 'Professional, structured, evidence-based.',
  },
  '2': {
    label: 'Teaching / Training',
    flow: 'Begin with basics → explain concepts visually → give examples → activity/demo → recap → Q&A. Guide the audience — never overload a single slide.',
    look: 'Friendly, readable layouts with larger fonts and illustrations. Fonts: Poppins or Open Sans. Soft backgrounds, high contrast text, diagrams, minimal text per slide.',
    tone: 'Approachable, clear, encouraging.',
  },
  '3': {
    label: 'Report / Research / Data',
    flow: 'Start with objective → methodology/data → findings → insights → risks/issues → recommendations → next steps. Data-driven storytelling — no raw number dumps.',
    look: 'Professional structured layout with charts and tables. Fonts: Aptos, Calibri, Arial. Neutral backgrounds (white / light grey / navy). Highlight key metrics with color accents only.',
    tone: 'Factual, precise, analytical.',
  },
  '4': {
    label: 'Pitch / Proposal',
    flow: 'Start with the pain/problem → market opportunity → your solution → uniqueness → business model → traction/results → ask/next step. The audience must quickly understand value and potential.',
    look: 'Modern premium visuals with bold headlines and minimal text. Fonts: Montserrat or Poppins for headings, Helvetica for body. Dark/light contrast themes, product screenshots, strong branding.',
    tone: 'Confident, persuasive, bold.',
  },
  '5': {
    label: 'Marketing / Public Speaking',
    flow: 'Start with a hook/story/question → emotional connection → core message → examples → audience engagement → memorable ending/call to action. Focus on energy and attention retention.',
    look: 'Visually rich slides with large images and bold typography. Fonts: Bebas Neue or Montserrat for titles, Poppins for body. Vibrant backgrounds or gradients, cinematic visuals, minimal text.',
    tone: 'Energetic, inspiring, memorable.',
  },
};

function buildPPTSystemPrompt(purpose) {
  const guide = PPT_PURPOSE_GUIDES[purpose] || null;

  const baseRules = `You are Ready4Launch's presentation specialist. Generate a professional, complete PowerPoint presentation.

ABSOLUTE RULES — follow exactly:
- Use only as many slides as the content genuinely needs. If 4 slides cover the topic well, use 4. If 9 are needed, use 9. Do NOT pad slides to reach a target number.
- Maximum 10 slides total (including title slide). Never exceed 10.
- Every slide must have substantial, real content — not placeholders or "add content here".
- Each content slide must have at least 4–6 detailed bullet points or a rich table.
- Use Markdown tables for comparisons, before/after, data breakdowns.
- Never write long paragraphs on slides — insights as bullet points only.

FORMAT — EXACT STRUCTURE:
- First line: # [Presentation Title]  (title slide)
- Use ## for each individual slide headline (write as an insight statement, not a label)
  e.g.  ## Revenue growth is constrained by three structural bottlenecks
- Use ### for sub-headings within a slide (use sparingly)
- Bullet points use - (hyphen)
- Each ## slide: 4–6 substantive bullet points OR 1 Markdown table

Do NOT output REPO_NAME or \`\`\`html blocks.`;

  if (!guide) {
    return baseRules + '\n\nBuild a professional, well-structured presentation that best matches the user\'s request.';
  }

  return `${baseRules}

PRESENTATION TYPE: ${guide.label}

STORY FLOW — follow this narrative arc:
${guide.flow}

VISUAL STYLE — apply these design guidelines:
${guide.look}

TONE: ${guide.tone}

Produce as many slides as the content genuinely needs (maximum 10). Do not pad with empty slides; do not squeeze rich content into too few slides. Make each slide feel professionally crafted.`;
}

// ── System instructions for non-build intents ─────────────────────
const SYS_CONVERSION = `You are Ready4Launch's document assistant. Generate rich, complete content for the user's requested file format.

Structure your output in Markdown, optimised for the target format:

• **Word / PDF**: Use # for main headings, ## for sub-headings, ### for section headings. Write full paragraphs, use bullet lists (- item) and numbered lists (1. item) for structured content. Use Markdown tables (| col | col |) for comparative data. Be thorough — produce complete professional content, not just an outline.

• **Excel / CSV / spreadsheet**: Focus on Markdown tables (| header | header |\\n| val | val |). Each logical dataset = one table. Add a ## heading above each table to name the sheet.

• **PowerPoint / presentation**: Structure as a professional Big-4 / McKinsey-style consultant deck. Follow this EXACT format:

  STRUCTURE RULES:
  - First line MUST be: # [Presentation Title]  (becomes the title slide)
  - Use # for major section titles — these become section-divider slides:
    e.g.  # Executive Summary,  # Problem Statement,  # Current State Analysis,
          # Gap Analysis,  # Future State,  # Recommendations,  # Next Steps
  - Use ## for individual slide headlines — write as an insight statement, not a label.
    e.g.  ## Revenue is constrained by three structural bottlenecks
    e.g.  ## The as-is process creates a 3-week delay at the approval stage
  - Use ### for sub-headings within a slide (used sparingly)
  - Each ## slide: MAXIMUM 5–6 bullet points. If you have more, split into two ## slides.
  - Bullets must be concise insight statements — one clear idea each, not sentence fragments
  - Use Markdown tables for comparisons, benchmarks, before/after, and data breakdowns
  - NEVER write long paragraphs on slides — bullet points only

  STORY ARC — always follow this consulting narrative:
  1. # Executive Summary  — key findings and recommendation in 4–5 bullets
  2. # Problem Statement  — what's wrong, why it matters, what's at stake
  3. # Current State (As-Is)  — how things work today, with data and observations
  4. # Gap Analysis  — delta between current and desired state; root causes
  5. # Future State  — what good looks like; target outcomes
  6. # Recommendations  — specific, prioritised actions (use numbered slides if many)
  7. # Next Steps  — owners, timelines, immediate actions

  Produce AT LEAST 12–18 slides of real, substantive content. Do not produce placeholders.

• **JSON**: Use tables to represent arrays of objects. Use headings to define top-level keys.

Be thorough and complete — generate all the content the user needs, not just an outline.
Do NOT add disclaimers about file generation. Do NOT output REPO_NAME or \`\`\`html blocks.`;

const SYS_REASONING = `You are Ready4Launch's reasoning assistant. Answer the user's question with clear logical steps.
Show your working explicitly. Use plain text, Markdown tables, or numbered steps.
For maths: show each step on its own line. For logic: state assumptions, then derive conclusions.
Do NOT build apps or websites. Do NOT output REPO_NAME or HTML code blocks.`;

const SYS_CHAT = `You are Ready4Launch — a smart AI assistant that can build web apps, convert documents, reason through problems, and answer questions.
Answer the user helpfully and conversationally. Be concise unless depth is asked for.
If the user wants to build something, let them know they can describe an app and you will build and deploy it for free.
Do NOT output REPO_NAME or HTML code blocks unless explicitly building an app.`;

// Used both by the attachment handler (first image turn) and
// follow-up turns while chatPhase === 'vision'.
const SYS_VISION = `You are Ready4Launch's image analysis assistant.

CAPABILITIES:
• You CAN analyse, describe, read text in, and answer questions about images the user uploads.
• You can help with any questions about the content visible in an uploaded image or file.

When shown an uploaded image: describe colours, shapes, objects, text, layout, mood, and composition.
Answer any specific question the user has about what is visible in the image.
When shown a non-image file reference: help with whatever the user asks about its content.
Be concise. Do NOT output REPO_NAME or \`\`\`html blocks unless explicitly asked to build an app.`;

function detectConversionFormat(message) {
  const m = message.toLowerCase();

  // ── Prioritise the TARGET format ────────────────────────────────
  // "convert word to ppt" → the user wants PPT, not Word.
  // Look for the format keyword that appears after a direction word.
  const targetMatch = m.match(
    /\b(?:to|into|as|in)\s+(?:a\s+|an?\s+)?(word|docx?|excel|xlsx?|spreadsheet|powerpoint|pptx?|presentation|slides?|pdf|csv|json)\b/
  );
  if (targetMatch) {
    const t = targetMatch[1];
    if (/word|docx?/.test(t))               return 'docx';
    if (/excel|xlsx?|spreadsheet/.test(t))  return 'xlsx';
    if (/powerpoint|pptx?|presentation|slides?/.test(t)) return 'pptx';
    if (/pdf/.test(t))                      return 'pdf';
    if (/csv/.test(t))                      return 'csv';
    if (/json/.test(t))                     return 'json';
  }

  // ── Fallback: first format keyword found ─────────────────────────
  if (/\b(word|docx?)\b/.test(m))                        return 'docx';
  if (/\b(excel|xlsx?|spreadsheet)\b/.test(m))           return 'xlsx';
  if (/\b(powerpoint|pptx?|presentation|slides?)\b/.test(m)) return 'pptx';
  if (/\bpdf\b/.test(m))                                 return 'pdf';
  if (/\bcsv\b/.test(m))                                 return 'csv';
  if (/\bjson\b/.test(m))                                return 'json';
  return 'docx'; // default
}

function interceptFramework(message) {
  const match = message.match(FRAMEWORK_RE);
  return match ? match[0] : null;
}

function detectBuildMode(answer) {
  const a = answer.toLowerCase();
  if (/\bcomplete\b|\bfull\b|\bprod(uction)?\b|\bdetailed?\b|\ball features?\b/.test(a)) return 'complete';
  if (/\bprototype?\b|\bproto\b|\bquick\b|\bfast\b|\bsimple\b|\bsingle.page\b/.test(a)) return 'prototype';
  if (/\b2\b|second|two/.test(a)) return 'complete';
  return 'prototype'; // default
}

function defaultStyleQuestion() {
  return `One quick thing — what vibe are you going for? 🎨

• 🖤 Dark & Sleek (black + purple/blue)
• ☀️ Light & Clean (white + blue/green)
• ⚡ Bold & Energetic (dark bg + vivid accent)
• 🎯 Minimal Pro (neutral tones, subtle accent)

Or just describe your own — colours, a brand you like, any mood words. Anything helps!`;
}

// No authentication required — chat, analyse, and convert are open to all visitors.
// GitHub session is only checked during deploy (in the github routes).
function requireAuth(_req, _res, next) { next(); }

// ── Route ─────────────────────────────────────────────────────────
router.post('/chat', requireAuth, async (req, res) => {
  const {
    message,
    newConversation,
    editMode: isEditMode,
    editOwner,
    editRepo,
    editBranch = 'main',
    attachment,   // optional: { fileName, mimeType, data (base64) }
    modeHint,     // optional: 'convert' | 'chat' — set by frontend when user clicks a welcome card
  } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Validate attachment if present
  const hasAttachment = attachment && attachment.mimeType && attachment.data;
  const isImageAttachment = hasAttachment && attachment.mimeType.startsWith('image/');

  // Reset full session on new conversation (but preserve edit mode if continuing)
  const isInActiveEditSession = isEditMode &&
    req.session.editMode?.owner === editOwner &&
    req.session.editMode?.repo === editRepo &&
    (
      (Array.isArray(req.session.chatHistory) && req.session.chatHistory.length > 0) ||
      ['edit_choice', 'editing'].includes(req.session.chatPhase)
    );
  const isRestoringEditMode = isInActiveEditSession && req.session.chatPhase === 'editing';

  if ((newConversation || !req.session.chatHistory) && !isInActiveEditSession) {
    req.session.chatHistory      = [];
    req.session.planNotes        = '';
    req.session.buildMode        = null;   // 'prototype' | 'complete'
    req.session.chatPhase        = 'init'; // see phases above
    req.session.questionIndex    = 0;
    req.session.gatheredAnswers  = [];
    req.session.originalRequest  = '';
    req.session.compiledSpec     = '';
    req.session.editMode         = null;
    req.session.pptOriginalMsg   = '';     // PPT ask-back: user's original request
    req.session.pptPurpose       = '';     // PPT ask-back: chosen purpose key (1-6)
    req.session.selectedStack    = null;   // stack selection (Complete Product flow)
    req.session.stackQuestions   = null;   // stack-aware Q1-Q5
    req.session.detectedStack    = null;   // detected stack from existing repo
    req.session.currentCode      = null;   // existing repo code
  }

  // If restoring edit mode session, skip the choice screen and go straight to conversational
  if (isRestoringEditMode) {
    // Session is preserved, phase is already 'editing', ready to continue
    console.log(`[EditMode] Resuming editing session for ${editOwner}/${editRepo}`);
  }

  const history = req.session.chatHistory;
  // isFirstMessage drives "show the choice screen" logic — must stay false when
  // we're mid-edit-session even if chatHistory is empty (e.g. after a GitHub fetch error).
  const isFirstMessage = history.length === 0 && !isInActiveEditSession;
  const primaryKey = process.env.GEMINI_API_KEY;

  if (!primaryKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  // ── Package gate — must run BEFORE SSE headers so we can return JSON ──
  const isNewConv = !!(newConversation || isFirstMessage);
  const section   = quickSection(
    message,
    !!(attachment && attachment.mimeType?.startsWith('image/')),
    !!isEditMode
  );
  const gate = await checkGate(req, section, isNewConv);
  if (!gate.ok) return res.status(gate.status).json(gate);

  // Test Drive users get their own API key (GEMINI_API_KEY_C) to isolate quota.
  // Owner bypass and all paid plans use the primary key.
  const apiKey = (gate.package === 'test_drive' && !gate.owner && process.env.GEMINI_API_KEY_C)
    ? process.env.GEMINI_API_KEY_C
    : primaryKey;

  // Record session start (non-blocking) — only on new conversations
  if (isNewConv && gate.uid) {
    recordSession(gate.uid, { type: section, summary: message.trim().slice(0, 120) }).catch(() => {});
  }

  // ── SSE setup ─────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const trimmedMessage = message.trim();

  // ── PPT purpose intercept — fires on ANY new PPT request ──────
  // Runs before all other routing so it works regardless of session state.
  // Skipped when: already answering the purpose question, already generating
  // a PPT in the same session (chatPhase==='conversion' + pptPurpose set),
  // or when an attachment is present.
  // PPT intent: explicit format keyword OR user clicked Convert card and mentions presentation/slides
  const _isPptByKeyword  = CONVERSION_RE.test(trimmedMessage) && detectConversionFormat(trimmedMessage) === 'pptx';
  const _isPptByModeHint = modeHint === 'convert' && /\b(presentation|slide ?deck|deck|pitch ?deck|ppt|powerpoint|slides?)\b/i.test(trimmedMessage);
  const _isPptRequest    = !hasAttachment && (_isPptByKeyword || _isPptByModeHint);
  const _inPptPurposeFlow = req.session.chatPhase === 'ppt_purpose';
  const _pptAlreadyAnswered = req.session.chatPhase === 'conversion' &&
    req.session.conversionFormat === 'pptx' &&
    !!req.session.pptPurpose;

  if (_isPptRequest && !_inPptPurposeFlow && !_pptAlreadyAnswered) {
    // Reset PPT state and ask purpose before anything else
    req.session.chatPhase      = 'ppt_purpose';
    req.session.pptOriginalMsg = trimmedMessage;
    req.session.pptPurpose     = '';
    req.session.chatHistory.push({ role: 'user',      content: trimmedMessage });
    req.session.chatHistory.push({ role: 'assistant', content: PPT_PURPOSE_QUESTION });
    sendEvent('chunk', { text: PPT_PURPOSE_QUESTION });
    sendEvent('done',  { text: PPT_PURPOSE_QUESTION });
    return res.end();
  }

  try {
    // ════════════════════════════════════════════════════════════
    // ATTACHMENT ROUTING — handle image / document attachments before the
    // intent classifier so the AI always sees the file content.
    // Images → Gemini vision (inlineData). Other files → text extraction stub.
    // ════════════════════════════════════════════════════════════
    if (hasAttachment) {
      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

      // Build the multimodal parts array for Gemini
      const parts = [];
      if (isImageAttachment) {
        parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
      } else {
        // Non-image document: tell the model a file was attached and ask it to work from the text prompt
        parts.push({ text: `[The user attached a file: "${attachment.fileName}" (${attachment.mimeType})]` });
      }
      if (trimmedMessage && trimmedMessage !== '(see attached file)') {
        parts.push({ text: trimmedMessage });
      }

      sendEvent('status', { message: isImageAttachment ? 'Analysing image…' : 'Processing file…' });

      // 'vision' phase: follow-up turns use SYS_VISION (image-aware, no fake image creation)
      req.session.chatPhase = 'vision';

      let responseText = '';
      await pooledStream({
        contents:          [{ role: 'user', parts }],
        config:            { temperature: 0.5, maxOutputTokens: 4096 },
        apiKey,
        tier:              'build',            // build-tier = best vision/reasoning models
        multimodal:        isImageAttachment,  // new-SDK-only slots for inlineData
        systemInstruction: SYS_VISION,
        onChunk: (t) => sendEvent('chunk', { text: t }),
        onDone:  (t) => { responseText = t; },
      });

      req.session.chatHistory.push({ role: 'assistant', content: responseText });
      sendEvent('done', { text: responseText });
      return res.end();
    }

    // ════════════════════════════════════════════════════════════
    // TOP-LEVEL INTENT ROUTING (first message of a NEW conversation only)
    // Intercepts non-build intents before the build state machine starts.
    // ════════════════════════════════════════════════════════════
    if (isFirstMessage && !isEditMode) {
      const intent = classifyTopLevelIntent(trimmedMessage, modeHint);

      // ── Text-response intents ────────────────────────────────────────
      if (intent === 'conversion' || intent === 'reasoning' || intent === 'chat') {

        const sysMap = {
          conversion: SYS_CONVERSION,
          reasoning:  SYS_REASONING,
          chat:       SYS_CHAT,
        };
        const statusMap = {
          conversion: 'Preparing your document…',
          reasoning:  'Working through the problem…',
          chat:       'Thinking…',
        };

        sendEvent('status', { message: statusMap[intent] });

        // Mark session so subsequent turns stay in the same one-shot mode
        req.session.chatPhase = intent;
        req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

        // Token budget: conversion may produce long documents; chat/reasoning are shorter
        const tokenBudget = { conversion: 8192, reasoning: 3072, chat: 2048 };

        let responseText = '';
        const onChunk = (t) => sendEvent('chunk', { text: t });
        const onDone  = (t) => { responseText = t; };

        await pooledStream({
          contents:          [{ role: 'user', parts: [{ text: trimmedMessage }] }],
          config:            { temperature: 0.5, maxOutputTokens: tokenBudget[intent] ?? 2048 },
          apiKey,
          tier:              'chat',           // chat-tier: lite models + Gemma
          systemInstruction: sysMap[intent],
          onChunk,
          onDone,
        });

        req.session.chatHistory.push({ role: 'assistant', content: responseText });
        // Store the detected format on the session so follow-up turns can use it
        if (intent === 'conversion') {
          req.session.conversionFormat = detectConversionFormat(trimmedMessage);
        }
        const donePayload = intent === 'conversion'
          ? { text: responseText, downloadable: true, detectedFormat: req.session.conversionFormat }
          : { text: responseText };
        sendEvent('done', donePayload);
        return res.end();
      }
      // intent === 'build' → fall through to the state machine below
    }

    // Subsequent turns in a non-build session (conversion / reasoning / chat / vision).
    // Key behaviours:
    //   • 'vision' follow-ups use SYS_VISION (prevents fake image-creation claims)
    //   • Any phase can freely re-route to any other non-build phase
    //   • If user asks to BUILD an app, session resets and falls through to the state machine
    //   • Conversion format is updated when the user asks for a different format
    // ── PPT purpose answer — generate the presentation now ──────────────
    if (!isFirstMessage && req.session.chatPhase === 'ppt_purpose') {
      // Parse the user's purpose choice (1–6 or free text)
      const purposeKey = trimmedMessage.trim().match(/^[1-6]/)?.[0] || null;
      req.session.pptPurpose = purposeKey || 'other';

      const sysPrompt = buildPPTSystemPrompt(purposeKey);
      const originalReq = req.session.pptOriginalMsg || trimmedMessage;
      const purposeLabel = purposeKey
        ? (PPT_PURPOSE_GUIDES[purposeKey]?.label || 'Custom')
        : `Other: ${trimmedMessage.slice(0, 80)}`;

      // Inject the purpose into the generation request
      const generationMsg =
        `${originalReq}\n\n[Presentation purpose chosen by user: ${purposeLabel}]` +
        (purposeKey ? '' : `\nUser's custom purpose: ${trimmedMessage}`);

      req.session.chatPhase        = 'conversion';
      req.session.conversionFormat = 'pptx';
      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

      sendEvent('status', { message: 'Building your presentation…' });

      let responseText = '';
      await pooledStream({
        contents:          [{ role: 'user', parts: [{ text: generationMsg }] }],
        config:            { temperature: 0.6, maxOutputTokens: 8192 },
        apiKey,
        tier:              'build',   // use build tier for best quality PPT
        systemInstruction: sysPrompt,
        onChunk: (t) => sendEvent('chunk', { text: t }),
        onDone:  (t) => { responseText = t; },
      });

      req.session.chatHistory.push({ role: 'assistant', content: responseText });
      // Include purposeKey so the frontend can pass it back on /api/convert-file
      const resolvedPurpose = req.session.pptPurpose || null;
      sendEvent('done', { text: responseText, downloadable: true, detectedFormat: 'pptx', pptPurpose: resolvedPurpose });
      return res.end();
    }

    if (!isFirstMessage && ['conversion', 'reasoning', 'chat', 'vision'].includes(req.session.chatPhase)) {

      // ── Build escape hatch — user wants to start a fresh app ─────────────
      // Only fire on an EXPLICIT build signal (BUILD_SIGNAL_RE).
      // Do NOT use classifyTopLevelIntent() here — its default return value is
      // 'build', so any ambiguous follow-up message would incorrectly reset the session.
      if (BUILD_SIGNAL_RE.test(trimmedMessage)) {
        req.session.chatHistory      = [];
        req.session.planNotes        = '';
        req.session.buildMode        = null;
        req.session.chatPhase        = 'init';
        req.session.questionIndex    = 0;
        req.session.gatheredAnswers  = [];
        req.session.originalRequest  = '';
        req.session.compiledSpec     = '';
        req.session.editMode         = null;
        req.session.conversionFormat = null;
        req.session.pptOriginalMsg   = '';
        req.session.pptPurpose       = '';
        console.log('[Chat] Build escape hatch — resetting session and entering state machine');
        // Fall through to the state machine below (do NOT return here)
      } else {
        req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

        // ── Intent re-routing within an active session ────────────────────────
        if (CONVERSION_RE.test(trimmedMessage)) {
          req.session.chatPhase        = 'conversion';
          req.session.conversionFormat = detectConversionFormat(trimmedMessage);
        } else if (REASONING_RE.test(trimmedMessage)) {
          req.session.chatPhase = 'reasoning';
        } else if (req.session.chatPhase === 'vision') {
          // vision sessions stay in their mode unless re-routed above
        } else {
          // Free re-route among chat-like phases
          const reIntent = classifyTopLevelIntent(trimmedMessage);
          if (reIntent === 'reasoning' || reIntent === 'chat') req.session.chatPhase = reIntent;
        }

        // ── Text-response phases (conversion / reasoning / chat / vision) ────
        const sysMap = {
          conversion: SYS_CONVERSION,
          reasoning:  SYS_REASONING,
          chat:       SYS_CHAT,
          vision:     SYS_VISION,
        };
        const sys = sysMap[req.session.chatPhase] || SYS_CHAT;

        sendEvent('status', { message: req.session.chatPhase === 'conversion' ? 'Preparing document…' : 'Thinking…' });

        // Token budget per section for follow-ups
        const followUpBudget = { conversion: 8192, reasoning: 3072, chat: 2048, vision: 4096 };
        const maxTokens = followUpBudget[req.session.chatPhase] ?? 2048;

        // Limit history to last 10 entries (5 exchanges) to cap input tokens
        const trimmedHistory = req.session.chatHistory.slice(-10);

        let responseText = '';
        const onChunk = (t) => sendEvent('chunk', { text: t });
        const onDone  = (t) => { responseText = t; };

        await pooledStream({
          contents:          trimmedHistory.map(({ role, content }) => ({
            role: role === 'user' ? 'user' : 'model',
            parts: [{ text: content }],
          })),
          config:            { temperature: 0.5, maxOutputTokens: maxTokens },
          apiKey,
          tier:              'chat',
          systemInstruction: sys,
          onChunk,
          onDone,
        });

        req.session.chatHistory.push({ role: 'assistant', content: responseText });
        const followUpPayload = req.session.chatPhase === 'conversion'
          ? { text: responseText, downloadable: true, detectedFormat: req.session.conversionFormat || 'docx' }
          : { text: responseText };
        sendEvent('done', followUpPayload);
        return res.end();
      }
    }

    // ════════════════════════════════════════════════════════════
    // EDIT MODE — show choice (change stack vs modify) OR apply changes
    // Triggered whenever the client sends editMode=true (any turn in the session).
    // ════════════════════════════════════════════════════════════
    if (isEditMode && editOwner && editRepo) {
      // Initialise session context on first edit-mode message
      if (isFirstMessage) {
        req.session.editMode    = { owner: editOwner, repo: editRepo, branch: editBranch };
        req.session.chatPhase   = 'edit_choice';  // NEW: show choice screen first
        req.session.currentCode = null; // fetched lazily below
      }

      // ── PHASE: edit_choice — show "Change stack" vs "Modify app" ──────────
      if (req.session.chatPhase === 'edit_choice' && isFirstMessage) {
        // Fetch (and cache) the current code so we only hit GitHub once per session
        if (!req.session.currentCode) {
          sendEvent('status', { message: `Fetching code from ${editOwner}/${editRepo}…` });
          try {
            // Try multiple paths for different project structures
            const pathsToTry = [
              'public/index.html',      // Node.js/Express apps
              'index.html',             // Static/GitHub Pages apps
              'dist/index.html',        // Pre-built apps
              'src/index.html',         // Some React/Vue projects
            ];

            let foundCode = null;
            let foundPath = null;

            for (const path of pathsToTry) {
              const code = await getFileContent(req.session.githubToken, editOwner, editRepo, path);
              if (code !== null) {
                foundCode = code;
                foundPath = path;
                break;
              }
            }

            if (!foundCode) {
              const pathList = pathsToTry.join(', ');
              sendEvent('error', {
                message: `Could not find index.html in ${editOwner}/${editRepo}.\n\n` +
                  `Checked: ${pathList}\n\n` +
                  `This might not be a Ready4Launch app, or the files are in a different location. ` +
                  `Make sure your app has an index.html file.`,
              });
              return res.end();
            }

            req.session.currentCode = foundCode;
            req.session.currentCodePath = foundPath;
            console.log(`[EditMode] Found code at ${foundPath} in ${editOwner}/${editRepo}`);
          } catch (fetchErr) {
            sendEvent('error', { message: `Could not fetch code: ${fetchErr.message}` });
            return res.end();
          }
        }

        // ── Detect stack from existing code (checks package.json + HTML) ─────
        const detectedStack = await detectStackFromCode(
          req.session.currentCode,
          req.session.githubToken,
          editOwner,
          editRepo
        );
        req.session.detectedStack = detectedStack;
        console.log(`[EditMode] Detected stack from ${editOwner}/${editRepo}:`, detectedStack);

        // ── Show edit choice screen ────────────────────────────────────
        const choiceMsg = `I found your app in **${editOwner}/${editRepo}**. What would you like to do?\n\n` +
          `1️⃣ **Change the tech stack** — rebuild with different frontend/backend\n` +
          `2️⃣ **Modify within same stack** — enhance or fix the existing app`;

        req.session.chatHistory.push({ role: 'user',      content: '[Entering edit mode]' });
        req.session.chatHistory.push({ role: 'assistant', content: choiceMsg });
        sendEvent('chunk', { text: choiceMsg });
        sendEvent('done',  { text: choiceMsg, showEditChoice: true });
        return res.end();
      }

      // ── PHASE: edit_choice follow-up — user picks change stack or modify ──
      if (req.session.chatPhase === 'edit_choice' && !isFirstMessage) {
        const choice = trimmedMessage.toLowerCase().trim();

        const isExplicitStackChange =
          /^1\b/.test(choice) ||
          /\bchange\s+(the\s+)?stack\b/i.test(choice) ||
          /\bswitch\s+stack\b/i.test(choice) ||
          /\bnew\s+stack\b/i.test(choice);
        const isExplicitModify =
          /^2\b/.test(choice) ||
          /\bmodif(y|ication)\b/i.test(choice) ||
          /\bsame\s+stack\b/i.test(choice) ||
          /\b(fix|edit|update|improve|add|enhance)\b/.test(choice);

        // ── CONVERSATIONAL FALLTHROUGH — answer naturally, don't re-show buttons ──
        if (!isExplicitStackChange && !isExplicitModify) {
          req.session.chatHistory.push({ role: 'user', content: trimmedMessage });
          const hasCode = !!req.session.currentCode;
          const convPrompt = hasCode
            ? `You are reviewing the app in ${editOwner}/${editRepo}.\n\n` +
              `CURRENT CODE EXCERPT:\n\`\`\`html\n${req.session.currentCode.slice(0, 6000)}\n\`\`\`\n\n` +
              `User: ${trimmedMessage}\n\n` +
              `Answer helpfully and concisely. Do NOT output REPO_NAME or new HTML. ` +
              `If the user wants to change the app, remind them: reply **1** to change stack, **2** to modify.`
            : `The user is editing ${editOwner}/${editRepo} and says: "${trimmedMessage}"\n\n` +
              `Respond helpfully. Remind them: **1** = change stack, **2** = modify existing app.`;
          sendEvent('status', { message: 'Thinking…' });
          let convResponse = '';
          await pooledStream({
            contents:          [{ role: 'user', parts: [{ text: convPrompt }] }],
            config:            { temperature: 0.5, maxOutputTokens: 1024 },
            apiKey,
            tier:              'chat',
            systemInstruction: SYS_CHAT,
            onChunk: (t) => sendEvent('chunk', { text: t }),
            onDone:  (t) => { convResponse = t; },
          });
          req.session.chatHistory.push({ role: 'assistant', content: convResponse });
          sendEvent('done', { text: convResponse });
          return res.end();
        }

        // Choice 1: Change the stack → save original repo, reset to stack selection
        if (isExplicitStackChange) {
          req.session.chatHistory.push({ role: 'user', content: trimmedMessage });
          req.session.chatPhase    = 'stack_selection';
          req.session.selectedStack = null;
          // Bug 3 Fix A — save repo before clearing editMode
          req.session.originalEditRepo = {
            owner:  editOwner,
            repo:   editRepo,
            branch: req.session.editMode?.branch || editBranch || 'main',
          };
          req.session.editMode = null;

          const resetMsg = `Got it! Let's rebuild with a new stack. Choose your new tech stack:`;
          req.session.chatHistory.push({ role: 'assistant', content: resetMsg });
          sendEvent('chunk', { text: resetMsg });
          sendEvent('done',  { text: resetMsg, showStackSelector: true });
          return res.end();
        }

        // Choice 2: Modify within same stack → ask what changes
        if (isExplicitModify) {
          req.session.chatPhase = 'editing';
          req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

          const askMsg = `Perfect! What would you like me to **fix, enhance, or add** to your app?`;
          req.session.chatHistory.push({ role: 'assistant', content: askMsg });
          sendEvent('chunk', { text: askMsg });
          sendEvent('done',  { text: askMsg });
          return res.end();
        }

        // Fallback (shouldn't reach here)
        sendEvent('chunk', { text: 'Please reply with **1** to change the tech stack, or **2** to modify the existing app.' });
        sendEvent('done',  { text: 'Please reply with **1** to change the tech stack, or **2** to modify the existing app.', showEditChoice: true });
        return res.end();
      }

      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });
      const onChunk = (text) => sendEvent('chunk', { text });
      let capturedResponse = null;
      const onEditDone = (text) => { capturedResponse = text; };

      // ── Conversational intent: explain / describe / answer questions ──
      if (isConversationalIntent(trimmedMessage)) {
        const analysisPrompt =
          `You are a senior developer reviewing the "${editOwner}/${editRepo}" repository for the user.\n\n` +
          `CURRENT index.html (excerpt — up to 8 KB shown):\n\`\`\`html\n` +
          `${req.session.currentCode.slice(0, 8000)}\n\`\`\`\n\n` +
          `USER'S QUESTION: ${trimmedMessage}\n\n` +
          `Answer clearly and specifically. Reference actual code sections when relevant. ` +
          `Do NOT generate new HTML. Do NOT output REPO_NAME. Keep the response conversational.`;

        await antigravity.streamChat(analysisPrompt, [], null, onChunk, onEditDone, '');
        const answer = capturedResponse || '';
        req.session.chatHistory.push({ role: 'assistant', content: answer });
        // No editMode in done payload → no push button shown for plain answers
        sendEvent('done', { text: answer });
        res.end();
        return;
      }

      // ── Edit intent: apply the requested change, return full updated HTML ──
      // OPTION A: Strengthen the prompt to ensure code blocks are generated
      const editPrompt =
        `You are a senior developer. Your ONLY job is to return valid HTML code — nothing else.\n\n` +
        `EDIT MODE — modify this existing app. Return the COMPLETE updated HTML file.\n` +
        `Repository: ${editOwner}/${editRepo}\n` +
        `Branch: ${editBranch || 'main'}\n\n` +
        `CURRENT CODE:\n\`\`\`html\n${req.session.currentCode}\n\`\`\`\n\n` +
        `USER'S CHANGE REQUEST:\n${trimmedMessage}\n\n` +
        `CRITICAL INSTRUCTIONS:\n` +
        `1. Apply ONLY the requested changes\n` +
        `2. Keep all existing working features intact\n` +
        `3. Return the ENTIRE updated HTML file in a SINGLE \`\`\`html code block\n` +
        `4. Do NOT explain, summarize, or comment — only code\n` +
        `5. The code block MUST start with \`\`\`html and end with \`\`\`\n` +
        `6. Do NOT output REPO_NAME, file paths, or any text outside the code block`;

      sendEvent('status', { message: 'Applying your changes…' });

      // OPTION B: Retry loop — if validation fails, re-prompt with stricter formatting
      let retries = 0;
      const maxRetries = 2;
      let validResponse = null;

      while (retries < maxRetries && !validResponse) {
        capturedResponse = null;

        const promptForAttempt = retries === 0
          ? editPrompt
          : `${editPrompt}\n\nPrevious attempt failed formatting. YOU MUST output code in a \`\`\`html ... \`\`\` block. ` +
            `Start your response with exactly: \`\`\`html\nThen the complete HTML code.\nThen: \`\`\`\nNothing else.`;

        await antigravity.streamChat(promptForAttempt, [], null, onChunk, onEditDone, '');

        if (capturedResponse && /```html/i.test(capturedResponse)) {
          validResponse = capturedResponse;
          break;
        }
        retries++;
      }

      if (!validResponse) {
        sendEvent('error', { message: 'Could not generate the updated code after 2 attempts. Please try a simpler change or rebuild from scratch.' });
        return res.end();
      }

      capturedResponse = validResponse;

      // Semantic quality pass — verify the requested changes were actually applied
      let finalEdit = capturedResponse;
      try {
        sendEvent('status', { message: 'Verifying changes…' });
        finalEdit = await fullQualityPass(capturedResponse, `Change request: ${trimmedMessage}`, apiKey);
        if (finalEdit !== capturedResponse) sendEvent('status', { message: 'Self-heal complete ✓' });
      } catch (qErr) {
        console.warn('[QualityPass] Edit mode non-fatal:', qErr.message);
      }

      // Bug 4 — update cached code and build full multi-file payload
      const allEditedFiles = extractFilesFromText(finalEdit);
      if (allEditedFiles.length > 0) {
        const mainHtml = allEditedFiles.find(
          f => f.path === 'index.html' || f.path === 'public/index.html' ||
               f.path.endsWith('/index.html') || f.path.endsWith('.html')
        );
        req.session.currentCode = (mainHtml || allEditedFiles[0]).content;
      } else {
        const htmlMatch = finalEdit.match(/```html\s*([\s\S]*?)```/i);
        if (htmlMatch) req.session.currentCode = htmlMatch[1].trim();
      }

      req.session.chatHistory.push({ role: 'assistant', content: finalEdit });
      const branch = req.session.editMode?.branch || editBranch;
      const editDonePayload = {
        text: finalEdit, editMode: true, editOwner, editRepo, editBranch: branch,
      };
      if (allEditedFiles.length > 1) editDonePayload.generatedFiles = allEditedFiles;
      const activeStack = req.session.selectedStack || req.session.detectedStack;
      if (activeStack) {
        const { getDeploymentMode, getRunCommand } = require('../services/stackAdvisor');
        editDonePayload.deployMode = getDeploymentMode(activeStack);
        const rc = getRunCommand(activeStack);
        if (rc) editDonePayload.runCommand = rc;
      }
      sendEvent('done', editDonePayload);
      res.end();
      return;
    }

    // ════════════════════════════════════════════════════════════
    // PHASE: init — first message OR build escape-hatch reset → send mode question
    // ════════════════════════════════════════════════════════════
    if (req.session.chatPhase === 'init') {
      req.session.originalRequest = trimmedMessage;
      req.session.chatPhase       = 'mode';

      // Run plan phase silently to get domain enrichment notes + style question
      sendEvent('status', { message: 'Analysing your request…' });
      try {
        const plan = await analyzePlanPhase(trimmedMessage, apiKey);
        req.session.planNotes  = plan.enrichedNotes   || '';
        req.session.planAskBack = plan.askBackQuestion || ''; // cache for prototype mode
      } catch (e) {
        console.warn('[Plan] Non-fatal:', e.message);
        req.session.planAskBack = '';
      }

      // Framework intercept annotation (just log; mode Q handles everything)
      const fw = interceptFramework(trimmedMessage);
      if (fw) console.log(`[Chat] Framework "${fw}" detected — will annotate on build`);

      req.session.chatHistory.push({ role: 'user',      content: trimmedMessage });
      req.session.chatHistory.push({ role: 'assistant', content: MODE_QUESTION });
      sendEvent('chunk', { text: MODE_QUESTION });
      sendEvent('done',  { text: MODE_QUESTION });
      return res.end();
    }

    // ════════════════════════════════════════════════════════════
    // PHASE: mode — detect prototype or complete
    // ════════════════════════════════════════════════════════════
    if (req.session.chatPhase === 'mode') {
      // ── Conversion escape — user corrected themselves ("no, I want a Word doc") ──
      // If the response to the Prototype/Complete question is clearly a request to
      // convert or create a document (not build an app), immediately pivot to conversion.
      const isConvertEscape = CONVERSION_RE.test(trimmedMessage) ||
        DOCUMENT_TYPE_RE.test(trimmedMessage) ||
        CONVERT_ESCAPE_RE.test(trimmedMessage);

      if (isConvertEscape) {
        req.session.chatHistory = [];          // clear build history
        req.session.chatPhase   = 'conversion';
        req.session.conversionFormat = detectConversionFormat(trimmedMessage);
        req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

        sendEvent('status', { message: 'Preparing your document…' });
        let responseText = '';
        await pooledStream({
          contents:          [{ role: 'user', parts: [{ text: trimmedMessage }] }],
          config:            { temperature: 0.5, maxOutputTokens: 8192 },
          apiKey,
          tier:              'chat',
          systemInstruction: SYS_CONVERSION,
          onChunk: (t) => sendEvent('chunk', { text: t }),
          onDone:  (t) => { responseText = t; },
        });

        req.session.chatHistory.push({ role: 'assistant', content: responseText });
        sendEvent('done', {
          text: responseText,
          downloadable: true,
          detectedFormat: req.session.conversionFormat || 'docx',
        });
        return res.end();
      }

      const detected = detectBuildMode(trimmedMessage);
      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

      if (detected === 'complete') {
        req.session.buildMode       = 'complete';
        req.session.chatPhase       = 'stack_selection';
        req.session.questionIndex   = 0;
        req.session.gatheredAnswers = [];
        req.session.selectedStack   = null;

        const stackIntro = `Great — let's build this properly. 🎯

**First, choose your tech stack.** This tells me exactly which technologies to use so the generated code is ready to run without any rewrites.

Select your stack below, then I'll ask 5 focused questions to understand your requirements fully before writing a single line of code.`;

        req.session.chatHistory.push({ role: 'assistant', content: stackIntro });
        sendEvent('chunk', { text: stackIntro });
        sendEvent('done',  { text: stackIntro, showStackSelector: true });
        return res.end();

      } else {
        req.session.buildMode = 'prototype';
        req.session.chatPhase = 'prototype_style';

        // Use the style question cached during the init plan-phase call (no second API call)
        const styleQ = req.session.planAskBack || defaultStyleQuestion();

        req.session.chatHistory.push({ role: 'assistant', content: styleQ });
        sendEvent('chunk', { text: styleQ });
        sendEvent('done',  { text: styleQ });
        return res.end();
      }
    }

    // ════════════════════════════════════════════════════════════
    // PHASE: stack_selection — user picks their tech stack
    // Message format: __STACK__:{"type":"spa","frontend":"react","backend":"nodejs"}
    // ════════════════════════════════════════════════════════════
    if (req.session.chatPhase === 'stack_selection') {
      if (!trimmedMessage.startsWith('__STACK__:')) {
        // User typed something instead of using the selector — acknowledge and re-show
        const retry = `Please use the stack selector above to choose your technology stack, then click "Build with this stack →" to continue.`;
        sendEvent('chunk', { text: retry });
        sendEvent('done',  { text: retry, showStackSelector: true });
        return res.end();
      }

      // Parse the stack JSON
      let stack;
      try {
        stack = JSON.parse(trimmedMessage.slice('__STACK__:'.length));
      } catch {
        sendEvent('error', { message: 'Invalid stack selection — please try again.' });
        return res.end();
      }

      req.session.selectedStack   = stack;
      req.session.chatPhase       = 'complete_questioning';
      req.session.questionIndex   = 0;
      req.session.gatheredAnswers = [];

      // Generate 5 stack-aware questions
      req.session.stackQuestions = getStackQuestions(stack);

      const { getStackLabel } = require('../services/stackAdvisor');
      const label = getStackLabel(stack);
      const deployMode = getDeploymentMode(stack);
      const deployNote = deployMode === 'github-pages'
        ? '🌐 *Deploys to GitHub Pages — no server needed*'
        : deployMode === 'local'
        ? '💻 *Runs on localhost — I\'ll launch it automatically after building*'
        : '📋 *Needs local setup — I\'ll include full instructions*';

      const confirm = `Perfect — **${label}** it is!\n${deployNote}\n\nNow let's get the full picture. I'll ask 5 focused questions.\n\n---\n\n` + req.session.stackQuestions[0];

      req.session.chatHistory.push({ role: 'user',      content: `[Stack selected: ${label}]` });
      req.session.chatHistory.push({ role: 'assistant', content: confirm });
      sendEvent('chunk', { text: confirm });
      sendEvent('done',  { text: confirm });
      return res.end();
    }

    // ════════════════════════════════════════════════════════════
    // PHASE: complete_questioning — Q1 through Q5
    // ════════════════════════════════════════════════════════════
    if (req.session.chatPhase === 'complete_questioning') {
      // Use stack-specific questions if a stack was selected, otherwise fallback to generic
      const questions = req.session.stackQuestions || COMPLETE_QUESTIONS;

      // Save answer for the current question
      const currentQ = questions[req.session.questionIndex];
      req.session.gatheredAnswers.push({ q: currentQ, a: trimmedMessage });
      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });
      req.session.questionIndex++;

      if (req.session.questionIndex < questions.length) {
        // More questions remain
        const nextQ = questions[req.session.questionIndex];
        req.session.chatHistory.push({ role: 'assistant', content: nextQ });
        sendEvent('chunk', { text: nextQ });
        sendEvent('done',  { text: nextQ });
        return res.end();
      }

      // All answers collected → compile spec → inject stack context → fall through to build
      sendEvent('status', { message: 'Compiling your requirements into a build brief…' });
      try {
        const spec = await compileSpec(
          req.session.gatheredAnswers,
          req.session.originalRequest,
          apiKey
        );
        // Prepend stack context so the AI knows exactly what to build
        const stackCtx = req.session.selectedStack
          ? buildStackContext(req.session.selectedStack, req.session.gatheredAnswers) + '\n\n'
          : '';
        req.session.compiledSpec = stackCtx + spec;
        console.log('[Chat] Spec compiled, length:', req.session.compiledSpec.length);
      } catch (specErr) {
        console.warn('[Chat] Spec compile failed (non-fatal):', specErr.message);
        const stackCtx = req.session.selectedStack
          ? buildStackContext(req.session.selectedStack, req.session.gatheredAnswers) + '\n\n'
          : '';
        req.session.compiledSpec = stackCtx + req.session.gatheredAnswers
          .map((qa, i) => `${i + 1}. ${qa.a}`)
          .join('\n');
      }

      req.session.chatPhase = 'building';
      // ↓ fall through to build
    }

    // ════════════════════════════════════════════════════════════
    // PHASE: prototype_style — style answer received → build
    // ════════════════════════════════════════════════════════════
    if (req.session.chatPhase === 'prototype_style') {
      req.session.chatPhase = 'building';
      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });
      // ↓ fall through to build (trimmedMessage IS the style answer)
    }

    // ════════════════════════════════════════════════════════════
    // BUILD PHASE — streaming generation
    // ════════════════════════════════════════════════════════════

    // Build enrichedNotes based on mode
    let enrichedNotes = '';

    // ✅ FIX: Build stack context if selected (should be included in ALL modes)
    let stackContext = '';
    if (req.session.selectedStack) {
      stackContext = buildStackContext(req.session.selectedStack, req.session.gatheredAnswers || []) + '\n\n';
      console.log('[Chat] Including stack context for:', JSON.stringify(req.session.selectedStack));
    }

    if (req.session.buildMode === 'complete' && req.session.compiledSpec) {
      enrichedNotes =
        `COMPLETE PRODUCT BUILD — specification from 5-question requirements interview:\n` +
        `${stackContext}` +  // ✅ FIX: Include stack context
        `${req.session.compiledSpec}\n\n` +
        `Original user request: "${req.session.originalRequest}"`;

    } else if (req.session.buildMode === 'prototype') {
      const base = (req.session.planNotes && req.session.planNotes !== 'No additional context.')
        ? req.session.planNotes
        : `Original request: "${req.session.originalRequest}"`;

      // trimmedMessage at this point IS the style answer (prototype_style turn)
      enrichedNotes =
        `${stackContext}` +  // ✅ FIX: Include stack context
        `${base}\n` +
        `User's chosen style: "${trimmedMessage}". Apply this throughout.\n\n` +
        `PROTOTYPE MODE: Build a SINGLE-PAGE application. ` +
        `Include a FIXED top navigation bar with AT LEAST 5 anchor links that smooth-scroll ` +
        `to clearly labeled in-page sections. All sections must have complete, realistic, ` +
        `domain-specific content. NO multi-page routing or separate HTML files.`;

    } else if (req.session.planNotes || stackContext) {
      // ✅ FIX: Include stack context for subsequent building turns
      enrichedNotes = stackContext + (req.session.planNotes || '');
    }

    // 🔴 BUG FIX #1: Ensure enrichedNotes is NEVER empty
    if (!enrichedNotes || enrichedNotes.trim() === '') {
      enrichedNotes = 'Build request (no context available)';
      if (req.session.selectedStack) {
        enrichedNotes = `Build ${req.session.selectedStack.frontend} + ${req.session.selectedStack.backend} application`;
      } else if (req.session.detectedStack) {
        enrichedNotes = `Build ${req.session.detectedStack.frontend} + ${req.session.detectedStack.backend} application`;
      }
      console.warn('[Chat] WARNING: enrichedNotes was empty, using fallback:', enrichedNotes);
    }

    // For complete mode, send original request to AI (spec is in enrichedNotes)
    // For prototype style turn, the AI gets the history (original req visible) + style as message
    // For subsequent building turns, send trimmedMessage as-is
    let processedMessage = trimmedMessage;
    if (req.session.buildMode === 'complete' && req.session.compiledSpec) {
      processedMessage = req.session.originalRequest; // spec is in enrichedNotes
    }

    // Framework annotation
    const detectedFramework = interceptFramework(processedMessage);
    if (detectedFramework) {
      processedMessage =
        `[PLATFORM NOTE: User mentioned "${detectedFramework}". ` +
        `Platform auto-commits to Vanilla JavaScript for zero-build GitHub Pages deployment. ` +
        `Acknowledge in one sentence then proceed.]\n\n${processedMessage}`;
    }

    // Determine which history to send (use recent context window; spec is in enrichedNotes)
    const historyToSend = req.session.buildMode === 'complete'
      ? []                    // complete mode: spec self-contained, no history needed
      : history.slice(-6);   // prototype / building: send recent context

    // ── Stream — capture full text, then audit, then send done ───────
    const onChunk = (text) => sendEvent('chunk', { text });

    // onDone just captures — async quality pass runs after streamChat resolves
    let capturedText    = null;
    let outputGateError = null;
    const onDone = (fullText) => {
      const announcedCode = /REPO_NAME\s*:/i.test(fullText);
      const hasHtmlBlock  = /```html/i.test(fullText);
      if (announcedCode && !hasHtmlBlock) {
        console.warn('[Chat] Output gate: REPO_NAME without ```html — rejecting');
        outputGateError = 'Ready4Launch generated an incomplete response. Please try again.';
        return;
      }
      capturedText = fullText;
    };

    sendEvent('status', { message: 'Ready4Launch is building your app…' });
    await antigravity.streamChat(
      processedMessage,
      historyToSend,
      null,
      onChunk,
      onDone,
      enrichedNotes
    );

    // Handle output gate / missing response
    if (outputGateError) {
      sendEvent('error', { message: outputGateError });
      return res.end();
    }
    if (!capturedText) {
      sendEvent('error', { message: 'No response received. Please try again.' });
      return res.end();
    }

    // ── Semantic quality pass (audit → self-heal → re-audit) ─────────
    // Only runs when there's an HTML block and we have requirements to check against
    let finalText = capturedText;
    if (/```html/i.test(capturedText) && enrichedNotes && enrichedNotes.length > 30) {
      try {
        sendEvent('status', { message: 'Verifying build quality…' });
        finalText = await fullQualityPass(capturedText, enrichedNotes, apiKey);
        if (finalText !== capturedText) {
          sendEvent('status', { message: 'Self-heal complete ✓' });
        }
      } catch (qErr) {
        console.warn('[QualityPass] Non-fatal — proceeding with original:', qErr.message);
        finalText = capturedText;
      }
    }

    // ── Dry run retry loop: fix issues before deploying ──────────────
    // If selected stack is set, keep fixing until dry run passes
    let dryResult = null;
    let dryRunAttempt = 0;
    const MAX_DRY_RUN_RETRIES = 3;

    if (req.session.selectedStack) {
      while (dryRunAttempt < MAX_DRY_RUN_RETRIES) {
        try {
          const extractedFiles = extractFilesFromText(finalText);
          dryResult = runDryCheck(extractedFiles, req.session.selectedStack);

          if (dryResult.passed) {
            // ✅ Dry run passed — we're done
            console.log(`[DryRun] ✅ Passed on attempt ${dryRunAttempt + 1}`);
            break;
          } else {
            // ❌ Dry run failed — try to fix
            dryRunAttempt++;
            if (dryRunAttempt >= MAX_DRY_RUN_RETRIES) {
              // Max retries reached — proceed with best effort
              console.warn(`[DryRun] ⚠️  Max retries (${MAX_DRY_RUN_RETRIES}) reached. Issues: ${dryResult.summary}`);
              break;
            }

            // Re-prompt AI to fix the specific issues
            console.warn(`[DryRun] ⚠️  Failed on attempt ${dryRunAttempt}: ${dryResult.summary}`);
            sendEvent('status', { message: `Fixing issues (attempt ${dryRunAttempt}/${MAX_DRY_RUN_RETRIES})…` });

            // Extract REPO_NAME from previous output to maintain it
            const repoMatch = finalText.match(/REPO_NAME:\s*([a-z0-9][a-z0-9\-]{1,48}[a-z0-9])/i);
            const repoName = repoMatch ? repoMatch[1] : 'myapp';

            const fixPrompt = `⚠️ CRITICAL REBUILD REQUIRED

The code generation had ERRORS that must be FIXED:
${dryResult.issues?.map(iss => `  ❌ ${iss}`).join('\n') || `  ❌ ${dryResult.summary}`}

REPO_NAME: ${repoName}

═══════════════════════════════════════════════════════════════════════

CRITICAL REQUIREMENTS FOR THIS REBUILD:

1. **COMPLETENESS IS MANDATORY**
   - Every file MUST be complete — no truncation, no cut-offs, no mid-sentence endings
   - Double-check that every closing tag, bracket, brace, and parenthesis is present
   - The code must be SYNTACTICALLY VALID JavaScript/HTML/JSON

2. **FILE MARKING — REQUIRED FOR ALL FILES**
   You MUST mark every code block with a FILE comment as its first line:
   - HTML: <!-- FILE: path/to/file.html -->
   - JavaScript: // FILE: path/to/file.js
   - JSON: // FILE: package.json (put on first line BEFORE JSON)
   - CSS: /* FILE: path/to/file.css */

   Example:
   \`\`\`json
   // FILE: package.json
   { "name": "${repoName}", ... }
   \`\`\`

3. **Node.js APPS MUST INCLUDE package.json**
   - VALID JSON format (not JS comments after the FILE line)
   - "start" or "dev" script that runs the server
   - ALL dependencies listed (express, react-dom, etc)
   - No truncation — complete dependencies object

4. **Node.js APPS MUST INCLUDE server.js OR index.js**
   - Proper Express initialization
   - All route handlers complete and closed
   - Public folder serving configured
   - No cut-off code

5. **HTML/React apps**
   - <!DOCTYPE html> tag present
   - <html>, <head>, <body> properly closed
   - All <script> tags closed
   - React + Babel CDN links if needed

6. **GENERATE COMPLETE WORKING CODE**
   - No placeholders like "..." or "// rest of code"
   - No "assume this is complete" comments
   - Every function, object, array must be fully written

7. **Keep REPO_NAME as: ${repoName}**

═══════════════════════════════════════════════════════════════════════

NOW: Regenerate the ENTIRE corrected application with ALL files complete and valid:
            `.trim();

            let fixedText = null;
            const onFixChunk = (text) => {
              // Don't send chunks for fix attempts — too noisy
            };
            const onFixDone = (text) => {
              fixedText = text;
            };

            // Generate fix with history context
            await antigravity.streamChat(
              fixPrompt,
              history.slice(-4),
              null,
              onFixChunk,
              onFixDone,
              enrichedNotes
            );

            if (fixedText) {
              // Try to extract files from the fixed response
              const fixedFiles = extractFilesFromText(fixedText);
              if (fixedFiles && fixedFiles.length > 0) {
                finalText = fixedText;
                console.log(`[DryRun] ✅ Generated fix attempt ${dryRunAttempt} with ${fixedFiles.length} files`);
              } else {
                console.warn(`[DryRun] ⚠️  Fix attempt ${dryRunAttempt} produced no valid files, keeping previous version`);
                break;
              }
            } else {
              console.warn(`[DryRun] ⚠️  Fix attempt ${dryRunAttempt} produced no output, keeping previous version`);
              break;
            }
          }
        } catch (dryErr) {
          console.warn('[DryRun] Error during retry:', dryErr.message);
          break;
        }
      }
    }

    // Finalise
    req.session.chatHistory.push({ role: 'assistant', content: finalText });
    const donePayload = { text: finalText };
    if (req.session.editMode) {
      donePayload.editMode  = true;
      donePayload.editOwner = req.session.editMode.owner;
      donePayload.editRepo  = req.session.editMode.repo;
      // Include deployment mode for edit mode using detected stack
      if (req.session.detectedStack) {
        donePayload.deployMode = getDeploymentMode(req.session.detectedStack);
        console.log(`[EditMode] Deployment mode for ${req.session.editMode.repo}: ${donePayload.deployMode}`);
      }
    } else {
      // Flag the frontend explicitly when this is a build response.
      // This lets the client show the deploy button even if its own
      // regex-parsing of the large HTML payload fails.
      const hasBuildOutput = /REPO_NAME\s*:/i.test(finalText) || /```html/i.test(finalText) || /```json/i.test(finalText);
      if (hasBuildOutput) {
        donePayload.build = true;
        // Also extract REPO_NAME server-side as a reliable fallback
        const rn = finalText.match(/REPO_NAME:\s*([a-z0-9][a-z0-9\-]{1,48}[a-z0-9])/i);
        if (rn) donePayload.repoName = rn[1].toLowerCase();

        // ── Include final dry run result ──────────────────────────
        if (dryResult) {
          donePayload.dryRun = dryResult;
          console.log(`[DryRun] Final result: ${dryResult.summary}`);
        }
        // Bug 3 Fix B — carry original repo when user changed stack mid-edit
        if (req.session.originalEditRepo) {
          donePayload.isStackRebuild = true;
          donePayload.targetRepo     = req.session.originalEditRepo;
          req.session.originalEditRepo = null;
        }
        // Include deployment mode so frontend shows correct CTA
        // Use selected stack if available, otherwise fall back to detected stack
        // 🔴 BUG FIX #3: Verify stack has all required fields
        let stackForDeployment = req.session.selectedStack || req.session.detectedStack;
        if (stackForDeployment) {
          // Ensure all required fields are present
          if (!stackForDeployment.frontend || !stackForDeployment.backend || !stackForDeployment.type) {
            console.warn('[DeployMode] Stack missing fields, rebuilding:', stackForDeployment);
            // Attempt to rebuild with detected info
            const detected = req.session.detectedStack || {};
            stackForDeployment = {
              frontend: stackForDeployment.frontend || detected.frontend || 'html',
              backend: stackForDeployment.backend || detected.backend || 'none',
              type: stackForDeployment.type || detected.type || 'static'
            };
          }
          donePayload.deployMode = getDeploymentMode(stackForDeployment);
          console.log('[DeployMode] Final stack for deployment:', stackForDeployment, '→', donePayload.deployMode);
        }
      }
    }
    sendEvent('done', donePayload);
    res.end();

  } catch (err) {
    console.error('─── Chat error ───');
    console.error('Message:', err.message);
    console.error('Status :', err.response?.status);
    console.error('─────────────────');
    if (!res.writableEnded) {
      sendEvent('error', { message: 'Ready4Launch ran into an issue. Please try again.' });
      res.end();
    }
  }
});

module.exports = router;

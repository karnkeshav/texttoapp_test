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

const router = express.Router();

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

function classifyTopLevelIntent(message) {
  // Format conversion always wins — very specific signal
  if (CONVERSION_RE.test(message)) return 'conversion';

  // Math / logic / numerical reasoning
  if (REASONING_RE.test(message)) return 'reasoning';

  // Explicit build request → state machine
  if (BUILD_SIGNAL_RE.test(message)) return 'build';

  // Conversational question (no repo context) → one-shot chat
  if (isConversationalIntent(message)) return 'chat';

  // Default: treat as a build request (existing behaviour)
  return 'build';
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

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

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
  } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Validate attachment if present
  const hasAttachment = attachment && attachment.mimeType && attachment.data;
  const isImageAttachment = hasAttachment && attachment.mimeType.startsWith('image/');

  // Reset full session on new conversation
  if (newConversation || !req.session.chatHistory) {
    req.session.chatHistory      = [];
    req.session.planNotes        = '';
    req.session.buildMode        = null;   // 'prototype' | 'complete'
    req.session.chatPhase        = 'init'; // see phases above
    req.session.questionIndex    = 0;
    req.session.gatheredAnswers  = [];
    req.session.originalRequest  = '';
    req.session.compiledSpec     = '';
    req.session.editMode         = null;
  }

  const history = req.session.chatHistory;
  const isFirstMessage = history.length === 0;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  // ── SSE setup ─────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const trimmedMessage = message.trim();

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
        config:            { temperature: 0.5, maxOutputTokens: 8192 },
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
      const intent = classifyTopLevelIntent(trimmedMessage);

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

        let responseText = '';
        const onChunk = (t) => sendEvent('chunk', { text: t });
        const onDone  = (t) => { responseText = t; };

        await pooledStream({
          contents:          [{ role: 'user', parts: [{ text: trimmedMessage }] }],
          config:            { temperature: 0.5, maxOutputTokens: 8192 },
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

        let responseText = '';
        const onChunk = (t) => sendEvent('chunk', { text: t });
        const onDone  = (t) => { responseText = t; };

        await pooledStream({
          contents:          req.session.chatHistory.map(({ role, content }) => ({
            role: role === 'user' ? 'user' : 'model',
            parts: [{ text: content }],
          })),
          config:            { temperature: 0.5, maxOutputTokens: 8192 },
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
    // EDIT MODE — conversational questions OR code changes for an existing repo.
    // Triggered whenever the client sends editMode=true (any turn in the session).
    // ════════════════════════════════════════════════════════════
    if (isEditMode && editOwner && editRepo) {
      // Initialise session context on first edit-mode message
      if (isFirstMessage) {
        req.session.editMode    = { owner: editOwner, repo: editRepo, branch: editBranch };
        req.session.chatPhase   = 'editing';
        req.session.currentCode = null; // fetched lazily below
      }

      // Fetch (and cache) the current index.html so we only hit GitHub once per session
      if (!req.session.currentCode) {
        sendEvent('status', { message: `Fetching code from ${editOwner}/${editRepo}…` });
        try {
          req.session.currentCode = await getFileContent(
            req.session.githubToken, editOwner, editRepo, 'index.html'
          );
        } catch (fetchErr) {
          sendEvent('error', { message: `Could not fetch code: ${fetchErr.message}` });
          return res.end();
        }
        if (!req.session.currentCode) {
          sendEvent('error', { message: `No index.html found in ${editOwner}/${editRepo}.` });
          return res.end();
        }
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
      const editPrompt =
        `EDIT MODE — modify this existing app. Return the COMPLETE updated HTML file.\n` +
        `Repository: ${editOwner}/${editRepo}\n\n` +
        `CURRENT CODE:\n\`\`\`html\n${req.session.currentCode}\n\`\`\`\n\n` +
        `USER'S CHANGE REQUEST: ${trimmedMessage}\n\n` +
        `INSTRUCTIONS: Apply ONLY the requested changes. Keep all working features intact. ` +
        `Output the entire updated HTML file in a single \`\`\`html block.`;

      sendEvent('status', { message: 'Applying your changes…' });
      await antigravity.streamChat(editPrompt, [], null, onChunk, onEditDone, '');

      if (!capturedResponse || !/```html/i.test(capturedResponse)) {
        sendEvent('error', { message: 'Could not generate the updated code. Please try again.' });
        return res.end();
      }

      // Semantic quality pass — verify the requested changes were actually applied
      let finalEdit = capturedResponse;
      try {
        sendEvent('status', { message: 'Verifying changes…' });
        finalEdit = await fullQualityPass(capturedResponse, `Change request: ${trimmedMessage}`, apiKey);
        if (finalEdit !== capturedResponse) sendEvent('status', { message: 'Self-heal complete ✓' });
      } catch (qErr) {
        console.warn('[QualityPass] Edit mode non-fatal:', qErr.message);
      }

      // Update cached code so the next edit turn builds on this version
      const updatedHtmlMatch = finalEdit.match(/```html\s*([\s\S]*?)```/i);
      if (updatedHtmlMatch) req.session.currentCode = updatedHtmlMatch[1].trim();

      req.session.chatHistory.push({ role: 'assistant', content: finalEdit });
      const branch = req.session.editMode?.branch || editBranch;
      sendEvent('done', { text: finalEdit, editMode: true, editOwner, editRepo, editBranch: branch });
      res.end();
      return;
    }

    // ════════════════════════════════════════════════════════════
    // PHASE: init — first message OR build escape-hatch reset → send mode question
    // ════════════════════════════════════════════════════════════
    if (req.session.chatPhase === 'init') {
      req.session.originalRequest = trimmedMessage;
      req.session.chatPhase       = 'mode';

      // Run plan phase silently to get domain enrichment notes
      sendEvent('status', { message: 'Analysing your request…' });
      try {
        const plan = await analyzePlanPhase(trimmedMessage, apiKey);
        req.session.planNotes = plan.enrichedNotes || '';
      } catch (e) {
        console.warn('[Plan] Non-fatal:', e.message);
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
      const detected = detectBuildMode(trimmedMessage);
      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

      if (detected === 'complete') {
        req.session.buildMode       = 'complete';
        req.session.chatPhase       = 'complete_questioning';
        req.session.questionIndex   = 0;
        req.session.gatheredAnswers = [];

        const q = COMPLETE_QUESTIONS[0];
        req.session.chatHistory.push({ role: 'assistant', content: q });
        sendEvent('chunk', { text: q });
        sendEvent('done',  { text: q });
        return res.end();

      } else {
        req.session.buildMode = 'prototype';
        req.session.chatPhase = 'prototype_style';

        // Get a domain-specific style question from plan phase (re-run with cached notes)
        sendEvent('status', { message: 'Preparing style options…' });
        let styleQ = defaultStyleQuestion();
        try {
          const plan2 = await analyzePlanPhase(req.session.originalRequest, apiKey);
          if (plan2.askBackQuestion) styleQ = plan2.askBackQuestion;
        } catch { /* keep default */ }

        req.session.chatHistory.push({ role: 'assistant', content: styleQ });
        sendEvent('chunk', { text: styleQ });
        sendEvent('done',  { text: styleQ });
        return res.end();
      }
    }

    // ════════════════════════════════════════════════════════════
    // PHASE: complete_questioning — Q1 through Q5
    // ════════════════════════════════════════════════════════════
    if (req.session.chatPhase === 'complete_questioning') {
      // Save answer for the current question
      const currentQ = COMPLETE_QUESTIONS[req.session.questionIndex];
      req.session.gatheredAnswers.push({ q: currentQ, a: trimmedMessage });
      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });
      req.session.questionIndex++;

      if (req.session.questionIndex < COMPLETE_QUESTIONS.length) {
        // More questions remain
        const nextQ = COMPLETE_QUESTIONS[req.session.questionIndex];
        req.session.chatHistory.push({ role: 'assistant', content: nextQ });
        sendEvent('chunk', { text: nextQ });
        sendEvent('done',  { text: nextQ });
        return res.end();
      }

      // All 5 answers collected → compile spec → fall through to build
      sendEvent('status', { message: 'Compiling your requirements into a build brief…' });
      try {
        const spec = await compileSpec(
          req.session.gatheredAnswers,
          req.session.originalRequest,
          apiKey
        );
        req.session.compiledSpec = spec;
        console.log('[Chat] Spec compiled, length:', spec.length);
      } catch (specErr) {
        console.warn('[Chat] Spec compile failed (non-fatal):', specErr.message);
        // Fallback: join the raw answers
        req.session.compiledSpec = req.session.gatheredAnswers
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

    if (req.session.buildMode === 'complete' && req.session.compiledSpec) {
      enrichedNotes =
        `COMPLETE PRODUCT BUILD — specification from 5-question requirements interview:\n` +
        `${req.session.compiledSpec}\n\n` +
        `Original user request: "${req.session.originalRequest}"`;

    } else if (req.session.buildMode === 'prototype') {
      const base = (req.session.planNotes && req.session.planNotes !== 'No additional context.')
        ? req.session.planNotes
        : `Original request: "${req.session.originalRequest}"`;

      // trimmedMessage at this point IS the style answer (prototype_style turn)
      enrichedNotes =
        `${base}\n` +
        `User's chosen style: "${trimmedMessage}". Apply this throughout.\n\n` +
        `PROTOTYPE MODE: Build a SINGLE-PAGE application. ` +
        `Include a FIXED top navigation bar with AT LEAST 5 anchor links that smooth-scroll ` +
        `to clearly labeled in-page sections. All sections must have complete, realistic, ` +
        `domain-specific content. NO multi-page routing or separate HTML files.`;

    } else if (req.session.planNotes) {
      // Subsequent turns in 'building' phase (app refinement)
      enrichedNotes = req.session.planNotes;
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

    // Finalise
    req.session.chatHistory.push({ role: 'assistant', content: finalText });
    const donePayload = { text: finalText };
    if (req.session.editMode) {
      donePayload.editMode  = true;
      donePayload.editOwner = req.session.editMode.owner;
      donePayload.editRepo  = req.session.editMode.repo;
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

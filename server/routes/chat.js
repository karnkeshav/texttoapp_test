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
  } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

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
    // EDIT MODE — modify an existing GitHub repo
    // ════════════════════════════════════════════════════════════
    if (isEditMode && editOwner && editRepo && isFirstMessage) {
      req.session.editMode  = { owner: editOwner, repo: editRepo };
      req.session.chatPhase = 'building';

      sendEvent('status', { message: `Fetching current code from ${editOwner}/${editRepo}…` });
      let currentCode;
      try {
        currentCode = await getFileContent(req.session.githubToken, editOwner, editRepo, 'index.html');
      } catch (fetchErr) {
        sendEvent('error', { message: `Could not fetch code: ${fetchErr.message}` });
        return res.end();
      }

      if (!currentCode) {
        sendEvent('error', { message: `No index.html found in ${editOwner}/${editRepo}.` });
        return res.end();
      }

      // Build the edit prompt — inject current code + change request
      const editPrompt =
        `EDIT MODE — modify this existing app. Return the COMPLETE updated HTML file.\n` +
        `Repository: ${editOwner}/${editRepo}\n\n` +
        `CURRENT CODE:\n\`\`\`html\n${currentCode}\n\`\`\`\n\n` +
        `USER'S CHANGE REQUEST: ${trimmedMessage}\n\n` +
        `INSTRUCTIONS: Apply ONLY the requested changes. Keep all working features intact. ` +
        `Output the entire updated HTML file in a single \`\`\`html block.`;

      req.session.chatHistory.push({ role: 'user', content: trimmedMessage });

      const onChunk = (text) => sendEvent('chunk', { text });
      const onDone  = (fullText) => {
        if (!/```html/i.test(fullText)) {
          sendEvent('error', { message: 'Could not generate the updated code. Please try again.' });
          return res.end();
        }
        req.session.chatHistory.push({ role: 'assistant', content: fullText });
        sendEvent('done', { text: fullText, editMode: true, editOwner, editRepo });
        res.end();
      };

      sendEvent('status', { message: 'Applying your changes…' });
      await antigravity.streamChat(editPrompt, [], null, onChunk, onDone, '');
      return;
    }

    // ════════════════════════════════════════════════════════════
    // PHASE: init — first message → send mode question
    // ════════════════════════════════════════════════════════════
    if (isFirstMessage) {
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

    // ── SSE onChunk / onDone ───────────────────────────────────────
    const onChunk = (text) => sendEvent('chunk', { text });

    const onDone = (fullText) => {
      // Output gate: REPO_NAME present but no ```html = malformed
      const announcedCode = /REPO_NAME\s*:/i.test(fullText);
      const hasHtmlBlock  = /```html/i.test(fullText);

      if (announcedCode && !hasHtmlBlock) {
        console.warn('[Chat] Output gate: REPO_NAME without ```html — rejecting');
        sendEvent('error', { message: 'AppBuilder generated an incomplete response. Please try again.' });
        return res.end();
      }

      req.session.chatHistory.push({ role: 'assistant', content: fullText });

      // Edit mode carries repo context so frontend can offer Push instead of Deploy
      const donePayload = { text: fullText };
      if (req.session.editMode) {
        donePayload.editMode  = true;
        donePayload.editOwner = req.session.editMode.owner;
        donePayload.editRepo  = req.session.editMode.repo;
      }

      sendEvent('done', donePayload);
      res.end();
    };

    sendEvent('status', { message: 'AppBuilder is building your app…' });
    await antigravity.streamChat(
      processedMessage,
      historyToSend,
      null,
      onChunk,
      onDone,
      enrichedNotes
    );

  } catch (err) {
    console.error('─── Chat error ───');
    console.error('Message:', err.message);
    console.error('Status :', err.response?.status);
    console.error('─────────────────');
    if (!res.writableEnded) {
      sendEvent('error', { message: 'AppBuilder ran into an issue. Please try again.' });
      res.end();
    }
  }
});

module.exports = router;

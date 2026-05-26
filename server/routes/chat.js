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

  // Explicit build/change intent → always treat as edit
  if (/\b(add|build|create|make|implement|generate|change|modify|update|fix|improve|refactor|redesign|remove|delete|replace|rewrite|style|design|feature|button|form|menu|chart|graph)\b/.test(m)) {
    return false;
  }

  // Question openers or pure information-seeking patterns
  return (
    /^(what|how|why|when|where|which|who)\b/.test(m) ||
    /\?/.test(m) ||
    /\b(explain|describe|summarize|overview|purpose|tell me|show me|what does|what is|what are|how does|how do|walk me through|analyze|analyse|understand|review|flow|architecture|structure|codebase|logic|working|works)\b/.test(m)
  );
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
        outputGateError = 'AppBuilder generated an incomplete response. Please try again.';
        return;
      }
      capturedText = fullText;
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
      sendEvent('error', { message: 'AppBuilder ran into an issue. Please try again.' });
      res.end();
    }
  }
});

module.exports = router;

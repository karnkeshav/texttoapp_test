const express = require('express');
const antigravity    = require('../services/antigravity');
const { analyzePlanPhase } = require('../services/planPhase');

const router = express.Router();

// ── Framework regex intercept (zero API cost) ─────────────────────
const FRAMEWORK_RE = /\b(react|vue|angular|next\.?js|nuxt\.?js|svelte|gatsby|remix|typescript|webpack|vite)\b/i;

function interceptFramework(message) {
  const match = message.match(FRAMEWORK_RE);
  if (!match) return null;
  return match[0]; // returns the matched framework name
}

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

router.post('/chat', requireAuth, async (req, res) => {
  const { message, repoFullName, newConversation } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  if (repoFullName) req.session.selectedRepo = repoFullName;

  if (newConversation || !req.session.chatHistory) {
    req.session.chatHistory = [];
  }
  const history = req.session.chatHistory;
  const isFirstMessage = history.length === 0;

  // ── SSE setup ─────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const trimmedMessage = message.trim();

  // ── Step 1: Framework intercept (regex, zero tokens) ──────────
  const detectedFramework = interceptFramework(trimmedMessage);
  let processedMessage = trimmedMessage;

  if (detectedFramework) {
    console.log(`[Chat] Framework intercept: "${detectedFramework}" → annotated for vanilla JS`);
    processedMessage = `[PLATFORM NOTE: User mentioned "${detectedFramework}". Platform auto-commits to Vanilla JavaScript for zero-build GitHub Pages deployment. Acknowledge in one sentence then proceed.]\n\n${trimmedMessage}`;
  }

  // ── Step 2: Plan phase (first message only, single JSON call) ─
  let enrichedNotes = '';

  if (isFirstMessage) {
    try {
      sendEvent('status', { message: 'Analysing your request…' });

      const apiKey = process.env.GEMINI_API_KEY;
      const model  = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
      const plan   = await analyzePlanPhase(trimmedMessage, apiKey, model);

      console.log(`[Plan] Archetype: ${plan.archetype} | AskBack: ${plan.requiresAskBack}`);

      // If a critical gap exists — ask back directly, skip AI generation
      if (plan.requiresAskBack && plan.askBackQuestion) {
        const question = plan.askBackQuestion;
        req.session.chatHistory.push({ role: 'user',      content: trimmedMessage });
        req.session.chatHistory.push({ role: 'assistant', content: question });
        sendEvent('chunk', { text: question });
        sendEvent('done',  { text: question });
        return res.end();
      }

      enrichedNotes = plan.enrichedNotes || '';
    } catch (planErr) {
      // Plan phase failure is non-fatal — continue without enrichment
      console.warn('[Plan] Phase failed (non-fatal):', planErr.message);
    }
  }

  // ── Step 3: Stream from Antigravity (with Gemini fallback) ────
  const onChunk = (text) => sendEvent('chunk', { text });
  const onDone  = (fullText) => {
    req.session.chatHistory.push({ role: 'user',      content: trimmedMessage });
    req.session.chatHistory.push({ role: 'assistant', content: fullText });
    sendEvent('done', { text: fullText });
    res.end();
  };

  try {
    sendEvent('status', { message: 'AppBuilder is thinking…' });
    await antigravity.streamChat(
      processedMessage,
      history,
      req.session.googleTokens,
      onChunk,
      onDone,
      enrichedNotes
    );
  } catch (err) {
    console.error('─── AI error ───');
    console.error('Message :', err.message);
    console.error('Status  :', err.response?.status);
    console.error('Body    :', JSON.stringify(err.response?.data, null, 2));
    console.error('────────────────');
    sendEvent('error', { message: 'AppBuilder ran into an issue. Please try again.' });
    res.end();
  }
});

module.exports = router;

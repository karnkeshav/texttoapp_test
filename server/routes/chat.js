const express = require('express');
const claude = require('../services/claude');
const antigravity = require('../services/antigravity');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.githubToken) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

/**
 * POST /api/chat
 * Body: { messages: [{role, content}], repoFullName: 'owner/repo' }
 * Streams Server-Sent Events back.
 */
router.post('/chat', requireAuth, async (req, res) => {
  const { messages, repoFullName } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Store the selected repo in the session
  if (repoFullName) req.session.selectedRepo = repoFullName;

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const onChunk = (text) => sendEvent('chunk', { text });
  const onDone = (fullText) => {
    sendEvent('done', { text: fullText, provider: activeProvider });
    res.end();
  };

  let activeProvider = 'AppBuilder';
  let useClaude = true;

  try {
    // Try Claude first; fall back to Antigravity on quota errors
    try {
      const quotaOk = await claude.checkQuota();
      useClaude = quotaOk;
    } catch {
      useClaude = false;
    }

    if (useClaude) {
      sendEvent('status', { message: 'AppBuilder is thinking...' });
      await claude.streamChat(messages, onChunk, onDone);
    } else {
      // Pass conversation context so Antigravity can continue seamlessly
      sendEvent('status', { message: 'AppBuilder is thinking...' });
      const context = req.session.conversationContext || null;
      const result = await antigravity.streamChat(messages, onChunk, (fullText) => {
        req.session.conversationContext = { messages, lastResponse: fullText };
        onDone(fullText);
      }, context);
    }
  } catch (err) {
    console.error('Chat error:', err.message);
    sendEvent('error', { message: 'AppBuilder encountered an error. Please try again.' });
    res.end();
  }
});

module.exports = router;

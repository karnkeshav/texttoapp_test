const express = require('express');
const antigravity = require('../services/antigravity');

const router = express.Router();

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

  // ── SSE setup ─────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const onChunk = (text) => sendEvent('chunk', { text });
  const onDone  = (fullText) => {
    req.session.chatHistory.push({ role: 'user',      content: message.trim() });
    req.session.chatHistory.push({ role: 'assistant', content: fullText });
    sendEvent('done', { text: fullText });
    res.end();
  };

  try {
    sendEvent('status', { message: 'AppBuilder is thinking…' });
    await antigravity.streamChat(
      message.trim(),
      history,
      req.session.googleTokens,
      onChunk,
      onDone
    );
  } catch (err) {
    console.error('─── Antigravity error ───');
    console.error('Message :', err.message);
    console.error('Status  :', err.response?.status);
    console.error('Body    :', JSON.stringify(err.response?.data, null, 2));
    console.error('─────────────────────────');
    sendEvent('error', { message: 'AppBuilder ran into an issue. Please try again.' });
    res.end();
  }
});

module.exports = router;

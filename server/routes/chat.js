const express = require('express');
const { v4: uuidv4 } = require('uuid');
const antigravity = require('../services/antigravity');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.githubToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/**
 * POST /api/chat
 * Body: { message: string, repoFullName?: string, newConversation?: boolean }
 * Streams Server-Sent Events back to the client.
 *
 * Conversation continuity is handled by Antigravity's session_id persistence —
 * we store one session ID per browser session (reset on "new conversation").
 */
router.post('/chat', requireAuth, async (req, res) => {
  const { message, repoFullName, newConversation } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Store the selected repo in the session for context
  if (repoFullName) req.session.selectedRepo = repoFullName;

  // Manage Antigravity session ID — one per conversation
  if (newConversation || !req.session.agSessionId) {
    req.session.agSessionId = `appbuilder-${req.session.user?.login || 'user'}-${uuidv4()}`;
  }
  const sessionId = req.session.agSessionId;

  // ── SSE setup ─────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const onChunk = (text) => sendEvent('chunk', { text });
  const onDone  = (text) => {
    sendEvent('done', { text });
    res.end();
  };

  // ── Call Antigravity ──────────────────────────────────────────
  try {
    sendEvent('status', { message: 'AppBuilder is thinking…' });
    await antigravity.streamChat(message.trim(), sessionId, onChunk, onDone);
  } catch (err) {
    console.error('Antigravity error:', err.message);
    sendEvent('error', { message: 'AppBuilder ran into an issue. Please try again.' });
    res.end();
  }
});

module.exports = router;

/**
 * Antigravity AI service
 * Google Generative Language — Interactions API
 * POST https://generativelanguage.googleapis.com/v1beta/interactions
 * Auth: x-goog-api-key header
 */

const axios = require('axios');

// ── System rules injected into every interaction ─────────────────
const SYSTEM_RULES = [
  'You are AppBuilder — an expert web developer who helps people create complete, deployable web applications using only HTML and vanilla JavaScript.',
  'NEVER write any code before you have complete answers to your questions.',
  'On the FIRST user message, always respond with a warm greeting and a numbered list of clarifying questions.',
  'Keep asking follow-up questions until you fully understand: purpose, target users, features, design preferences, content, and pages/sections needed.',
  'Every app you build must work on GitHub Pages (completely free — no backend servers, no databases, no paid services).',
  'Output ONLY HTML + vanilla JavaScript. Never suggest React, Vue, Angular, FastAPI, Node.js, or any other framework — even if the user asks for them.',
  'For data persistence use localStorage or free public APIs such as JSONbin.io or Open-Meteo.',
  'Once you have all answers, say exactly: "Perfect! I have everything I need. Let me now build your complete app." — then output the full, production-ready HTML+JS code.',
  'After the code, give clear step-by-step GitHub Pages deployment instructions: Settings → Pages → Branch: main → Save.',
  'Use modern, beautiful CSS with gradients, animations, and responsive design — every app should look professional.',
  'Never mention Google, Antigravity, any AI system, or any underlying technology in your responses. You are simply AppBuilder.',
];

// ── Build the request payload ─────────────────────────────────────
function buildPayload(userInput, sessionId) {
  return {
    agent: process.env.ANTIGRAVITY_AGENT_ID || 'antigravity-preview-05-2026',
    input: userInput,
    config: {
      environment: {
        type: 'remote_sandbox',
        os: 'linux-ubuntu-24.04',
        timeout_seconds: 300,
        allow_internet: true,
      },
      persistence: {
        session_id: sessionId,
        keep_alive_seconds: 3600,
      },
      runtime_policies: {
        auto_approve_tool_execution: true,
        max_steps_per_interaction: 25,
      },
    },
    context: {
      active_workflows: [],
      rules: SYSTEM_RULES,
    },
    stream: true,
  };
}

// ── Extract displayable text from an SSE event object ────────────
// Antigravity streams multi-step agentic events — we pull out any
// text that should be shown to the end user.
function extractText(event) {
  if (!event || typeof event !== 'object') return null;

  // Direct text fields
  if (typeof event.text === 'string' && event.text) return event.text;
  if (typeof event.content === 'string' && event.content) return event.content;

  // Nested output shapes
  if (event.output?.text) return event.output.text;
  if (event.output?.content) return event.output.content;
  if (event.delta?.text) return event.delta.text;
  if (event.delta?.content) return event.delta.content;
  if (event.agent_output?.text) return event.agent_output.text;
  if (event.response?.text) return event.response.text;
  if (event.message?.content) return typeof event.message.content === 'string'
    ? event.message.content : null;

  // Step-level events — only surface user-facing output types
  const outputTypes = new Set(['agent_output', 'response', 'text', 'message', 'final_response']);
  if (outputTypes.has(event.type)) {
    return event.text || event.content || null;
  }

  return null;
}

// ── Main streaming function ───────────────────────────────────────
/**
 * @param {string}   userInput  Latest message from the user
 * @param {string}   sessionId  Antigravity session ID (per conversation)
 * @param {Function} onChunk    Called with each text fragment as it arrives
 * @param {Function} onDone     Called once with the complete response text
 */
async function streamChat(userInput, sessionId, onChunk, onDone) {
  const endpoint = process.env.ANTIGRAVITY_API_ENDPOINT;
  const apiKey   = process.env.ANTIGRAVITY_API_KEY;

  if (!endpoint) throw new Error('ANTIGRAVITY_API_ENDPOINT is not set in .env');
  if (!apiKey)   throw new Error('ANTIGRAVITY_API_KEY is not set in .env');

  const response = await axios({
    method: 'post',
    url: endpoint,
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    data: buildPayload(userInput, sessionId),
    responseType: 'stream',
    timeout: 320_000, // slightly above the 300s sandbox timeout
  });

  let fullText = '';
  let buffer   = '';

  return new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;

        const raw = line.slice(5).trim();
        if (raw === '[DONE]') {
          onDone(fullText);
          resolve(fullText);
          return;
        }

        try {
          const event = JSON.parse(raw);
          const text  = extractText(event);
          if (text) {
            fullText += text;
            onChunk(text);
          }
        } catch (_) {
          // skip malformed chunks silently
        }
      }
    });

    response.data.on('end', () => {
      onDone(fullText);
      resolve(fullText);
    });

    response.data.on('error', reject);
  });
}

module.exports = { streamChat };

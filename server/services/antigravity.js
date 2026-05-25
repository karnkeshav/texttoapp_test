/**
 * Antigravity AI service
 * Google Generative Language — Interactions API
 *
 * Confirmed accepted fields: agent, input, environment:{type}, stream
 * Auth: OAuth2 Bearer token (same Gmail account used in Antigravity desktop app)
 */

const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');

// ── System prompt embedded in every request ───────────────────────
const SYSTEM_PROMPT = `You are AppBuilder — an expert web developer who helps people create complete, deployable web applications using only HTML and vanilla JavaScript.

YOUR RULES — follow these strictly:
1. NEVER write any code before you have complete answers to your questions.
2. On the FIRST user message, respond with a warm greeting and a numbered list of clarifying questions.
3. Ask until you fully understand: purpose, target users, features, design preferences, content, pages/sections.
4. Every app must work on GitHub Pages (free — no backend servers, no databases, no paid services).
5. Output ONLY HTML + vanilla JavaScript. Never suggest React, Vue, Angular, FastAPI, or Node.js.
6. For data persistence use localStorage or free public APIs (JSONbin.io, Open-Meteo, etc.).
7. Once you have all answers, say: "Perfect! I have everything I need. Let me now build your complete app." — then output the full production-ready code.
8. After the code, give step-by-step GitHub Pages deployment instructions: Settings → Pages → Branch: main → Save.
9. Use modern, beautiful CSS with gradients, animations, and responsive design.
10. Never mention Google, Antigravity, any AI system, or any underlying technology. You are simply AppBuilder.

---`;

// ── Build input with system prompt + conversation history ─────────
function buildInput(history, newUserMessage) {
  const lines = [SYSTEM_PROMPT, ''];

  if (history.length > 0) {
    lines.push('CONVERSATION SO FAR:');
    history.forEach(({ role, content }) => {
      lines.push(`${role === 'user' ? 'User' : 'AppBuilder'}: ${content}`);
      lines.push('');
    });
  }

  lines.push(`User: ${newUserMessage}`);
  lines.push('');
  lines.push('AppBuilder:');
  return lines.join('\n');
}

// ── Get a fresh access token (auto-refreshes using stored refresh token) ──
async function getFreshAccessToken(googleTokens) {
  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
  );
  client.setCredentials(googleTokens);

  // getAccessToken() auto-refreshes if the token is expired
  const { token } = await client.getAccessToken();
  return token;
}

// ── Extract displayable text from a streamed SSE event ────────────
function extractText(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.text === 'string' && event.text)        return event.text;
  if (typeof event.content === 'string' && event.content)  return event.content;
  if (event.output?.text)    return event.output.text;
  if (event.output?.content) return event.output.content;
  if (event.delta?.text)     return event.delta.text;
  if (event.delta?.content)  return event.delta.content;
  if (event.agent_output?.text)  return event.agent_output.text;
  if (event.response?.text)      return event.response.text;
  if (typeof event.message?.content === 'string') return event.message.content;
  const outputTypes = new Set(['agent_output', 'response', 'text', 'message', 'final_response']);
  if (outputTypes.has(event.type)) return event.text || event.content || null;
  return null;
}

// ── Main streaming function ───────────────────────────────────────
/**
 * @param {string}   newUserMessage  Latest message from the user
 * @param {Array}    history         [{role, content}, ...] conversation so far
 * @param {object}   googleTokens    OAuth2 tokens from req.session.googleTokens
 * @param {Function} onChunk         Called with each streamed text fragment
 * @param {Function} onDone          Called once with the complete response text
 */
async function streamChat(newUserMessage, history, googleTokens, onChunk, onDone) {
  const endpoint = process.env.ANTIGRAVITY_API_ENDPOINT;
  const agentId  = process.env.ANTIGRAVITY_AGENT_ID || 'antigravity-preview-05-2026';

  if (!endpoint)      throw new Error('ANTIGRAVITY_API_ENDPOINT not set in .env');
  if (!googleTokens)  throw new Error('Google account not connected — please sign in with Google first');

  const accessToken = await getFreshAccessToken(googleTokens);

  const payload = {
    agent: agentId,
    input: buildInput(history, newUserMessage),
    environment: { type: 'remote_sandbox' },
    stream: true,
  };

  const response = await axios({
    method: 'post',
    url: endpoint,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    data: payload,
    responseType: 'stream',
    timeout: 320_000,
  });

  let fullText = '';
  let buffer   = '';

  return new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (raw === '[DONE]') { onDone(fullText); resolve(fullText); return; }
        try {
          const event = JSON.parse(raw);
          const text  = extractText(event);
          if (text) { fullText += text; onChunk(text); }
        } catch (_) {}
      }
    });
    response.data.on('end',   () => { onDone(fullText); resolve(fullText); });
    response.data.on('error', reject);
  });
}

module.exports = { streamChat };

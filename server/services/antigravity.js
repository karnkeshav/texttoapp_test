/**
 * Antigravity AI fallback service.
 * Mirrors Claude's streaming interface so the chat route is provider-agnostic.
 *
 * TODO: Replace ANTIGRAVITY_API_ENDPOINT and adjust the request/response shape
 * once you have the exact Antigravity API documentation.
 */

const axios = require('axios');
const { SYSTEM_PROMPT } = require('./claude');

function buildHeaders() {
  return {
    'Authorization': `Bearer ${process.env.ANTIGRAVITY_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
}

async function streamChat(messages, onChunk, onDone, context = null) {
  const endpoint = process.env.ANTIGRAVITY_API_ENDPOINT;
  if (!endpoint) throw new Error('ANTIGRAVITY_API_ENDPOINT not set');

  const payload = {
    system: SYSTEM_PROMPT,
    messages,
    stream: true,
    ...(context ? { context } : {}),
  };

  const response = await axios({
    method: 'post',
    url: `${endpoint}/chat/completions`,
    headers: buildHeaders(),
    data: payload,
    responseType: 'stream',
  });

  let fullText = '';

  await new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.replace(/^data:\s*/, '');
        if (raw === '[DONE]') { resolve(); return; }
        try {
          const parsed = JSON.parse(raw);
          // Adjust path based on actual Antigravity response shape
          const text = parsed?.choices?.[0]?.delta?.content
            || parsed?.delta?.text
            || parsed?.text
            || '';
          if (text) {
            fullText += text;
            onChunk(text);
          }
        } catch (_) { /* skip malformed chunks */ }
      }
    });
    response.data.on('end', resolve);
    response.data.on('error', reject);
  });

  onDone(fullText);
  return fullText;
}

module.exports = { streamChat };

/**
 * AI service — Google GenAI unified SDK (@google/genai)
 */

const { GoogleGenAI } = require('@google/genai');

// ── System prompt ─────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `You are AppBuilder — an expert web developer who helps people create complete, deployable web applications using only HTML and vanilla JavaScript.

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
10. Never mention Google, Gemini, any AI system, or any underlying technology. You are simply AppBuilder.`;

// ── Main streaming function ───────────────────────────────────────
/**
 * @param {string}   newUserMessage  Latest message from the user
 * @param {Array}    history         [{role, content}, ...] conversation so far
 * @param {object}   _googleTokens   Unused — kept for API compatibility
 * @param {Function} onChunk         Called with each streamed text fragment
 * @param {Function} onDone          Called once with the complete response text
 */
async function streamChat(newUserMessage, history, _googleTokens, onChunk, onDone) {
  const apiKey    = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env — get one free at aistudio.google.com');

  const ai = new GoogleGenAI({ apiKey });

  // Build contents array: history + new user message
  const contents = [
    ...history.map(({ role, content }) => ({
      role: role === 'user' ? 'user' : 'model',
      parts: [{ text: content }],
    })),
    { role: 'user', parts: [{ text: newUserMessage }] },
  ];

  const response = await ai.models.generateContentStream({
    model: modelName,
    contents,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  });

  let fullText = '';
  for await (const chunk of response) {
    const text = chunk.text;
    if (text) {
      fullText += text;
      onChunk(text);
    }
  }

  onDone(fullText);
  return fullText;
}

module.exports = { streamChat };

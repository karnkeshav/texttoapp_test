/**
 * PLAN PHASE — Single-pass intent analysis via Gemini structured JSON output
 *
 * Classifies the user prompt, decides if an ask-back is needed, and generates
 * an enriched context note — all in one low-latency API call using gemini-3.1-flash-lite.
 * Only runs on the FIRST message of a conversation (history.length === 0).
 */

const { GoogleGenAI } = require('@google/genai');

const ANALYSIS_PROMPT = `You are a technical requirements analyst for a web app builder platform called AppBuilder.
Analyse the user's prompt and return a single structured JSON object.

User prompt: "{PROMPT}"

ARCHETYPE RULES:
- NOVICE:  Broad goal description ("landing page for my dental clinic", "portfolio site")
- BUILDER: Mentions a framework or asks architectural questions (React, Vue, database, API)
- EXPERT:  Explicitly specifies design tokens, tech stack, or a detailed feature flow

ASK-BACK RULES — set requiresAskBack to true ONLY if one of these critical gaps exists:
  GAP 1: Prompt demands an interactive calculation/data-entry utility but provides zero input logic
          (e.g. "expense manager" with nothing else). Question: offer wizard vs seed data.
  GAP 2: User explicitly states design choices that would break legibility (dark text on dark bg).
          Question: offer frosted-glass auto-fix.
  GAP 3: Prompt requires persistent saved state (favourites, progress) with no storage path given.
          Question: confirm localStorage + offer pre-populated mock data.

If none of the three gaps apply → requiresAskBack: false, askBackQuestion: "".

enrichedNotes: A concise addendum (max 80 words) capturing any domain-specific details,
named features, colour preferences, or technical constraints extracted from the prompt.
These notes supplement the generation context. If the prompt is vague, write "No additional context."`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    archetype:        { type: 'string', enum: ['NOVICE', 'BUILDER', 'EXPERT'] },
    requiresAskBack:  { type: 'boolean' },
    askBackQuestion:  { type: 'string' },
    enrichedNotes:    { type: 'string' },
  },
  required: ['archetype', 'requiresAskBack', 'enrichedNotes'],
};

/**
 * Run the plan phase for a first-turn user message.
 * @param {string} userMessage
 * @param {string} apiKey  GEMINI_API_KEY
 * @param {string} [model] defaults to gemini-3.1-flash-lite
 * @returns {{ archetype, requiresAskBack, askBackQuestion, enrichedNotes }}
 */
async function analyzePlanPhase(userMessage, apiKey, model = 'gemini-3.1-flash-lite') {
  const ai = new GoogleGenAI({ apiKey });

  const prompt = ANALYSIS_PROMPT.replace('{PROMPT}', userMessage);

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
      maxOutputTokens: 512,
    },
  });

  const parsed = JSON.parse(response.text);
  return {
    archetype:       parsed.archetype       || 'NOVICE',
    requiresAskBack: parsed.requiresAskBack ?? false,
    askBackQuestion: parsed.askBackQuestion || '',
    enrichedNotes:   parsed.enrichedNotes   || '',
  };
}

module.exports = { analyzePlanPhase };

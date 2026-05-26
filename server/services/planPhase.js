/**
 * PLAN PHASE — Intent analysis + visual direction prompt
 *
 * Runs once on the FIRST message. Returns structured JSON:
 *  - archetype: NOVICE | BUILDER | EXPERT
 *  - requiresAskBack: true → send askBackQuestion before generating
 *  - askBackQuestion: the question to show the user
 *  - enrichedNotes: domain context injected into the generation turn
 *
 * GAP PRIORITY (first match wins):
 *  1. Critical workflow void — can't build without knowing the data flow
 *  2. Data lifecycle ambiguity — persistent state with no storage path
 *  3. Visual direction missing — no colour/theme specified (fires for most prompts)
 *  4. Severe contrast violation — explicit colour choices break legibility
 */

const { GoogleGenAI } = require('@google/genai');

const ANALYSIS_PROMPT = `You are a design-aware requirements analyst for AppBuilder — a platform that converts plain-English descriptions into complete, beautiful HTML+JS web apps.

Analyse the user prompt below and return a single structured JSON object.

User prompt: "{PROMPT}"

── ARCHETYPE ──────────────────────────────────────────────────────────────
NOVICE:   Broad goal with no tech details ("landing page", "portfolio", "tracker app")
BUILDER:  Mentions React, Vue, Angular, Next.js, Svelte, TypeScript, databases, backend
EXPERT:   Explicitly specifies colours, design tokens, component names, or detailed feature flow

── ASK-BACK RULES ─────────────────────────────────────────────────────────
Check gaps in priority order. Stop at the FIRST gap that applies.
Set requiresAskBack: true and write a warm, enthusiastic askBackQuestion.

GAP 1 — CRITICAL WORKFLOW VOID
  Condition: The prompt requests an interactive data-entry utility (expense tracker,
  booking system, inventory manager, quiz app, calculator) BUT provides zero description
  of what data is entered, the inputs, or how the workflow flows.
  Question: Ask ONE specific functional question about the core workflow.
  Example: "I've got the layout ready! Should I include a [smart input form for X],
  or pre-populate it with realistic sample data so it looks great right away?"

GAP 2 — DATA PERSISTENCE AMBIGUITY
  Condition: The app needs to SAVE data across page reloads (favourites, user progress,
  saved items, history, preferences) but no storage mechanism is mentioned.
  Do NOT fire this if the app is obviously stateless (e.g. landing page, portfolio).
  Question: Confirm localStorage + offer pre-populated mock data.
  Example: "To keep your [data type] saved across visits, I'll use browser localStorage.
  Want me to pre-load some realistic sample data so it looks populated from the start?"

GAP 3 — VISUAL DIRECTION MISSING  ← fires for most prompts
  Condition: The prompt does NOT mention ANY of: a colour scheme, theme name, dark/light
  mode preference, mood word (minimal, bold, elegant, playful), or specific hex colours.
  This is the DEFAULT gap — it should fire for the majority of prompts.

  Write an engaging, emoji-rich question offering 3–4 visual style options.
  The options MUST be tailored to the specific domain/industry in the prompt.
  Each option should have a name, emoji, and the 2 key colours in parentheses.
  End with "or describe your own style!"

  Domain-specific examples to guide you (do NOT copy verbatim — adapt to the actual domain):
  • Fitness app: "🖤 Dark & Intense (black/neon green), ⚡ Electric Energy (navy/electric yellow), 🌊 Clean Athlete (white/cobalt blue)"
  • Restaurant: "🌙 Upscale & Moody (charcoal/gold), ☀️ Fresh & Warm (cream/terracotta), 🎨 Artsy Bistro (deep plum/rose)"
  • Finance/Budget: "🏦 Premium Dark (midnight/emerald), 💎 Corporate Clean (white/electric blue), 🔮 Bold Modern (deep indigo/gold)"
  • Portfolio: "⚫ Minimal Noir (black/white+accent), 🌈 Creative Bold (dark/vivid gradient), 🎯 Clean Pro (white/slate)"
  • E-commerce: "🛍️ Luxury Dark (black/gold), 🌿 Fresh Minimal (white/sage green), 🔥 High Energy (dark/electric red)"
  Always start with: "One quick thing before I build —"

GAP 4 — SEVERE CONTRAST VIOLATION
  Condition: The user explicitly states colour choices that would break legibility
  (e.g. white text on white background, yellow on light yellow, very dark on dark).
  Question: Offer frosted-glass auto-fix to maintain contrast.
  "Those colour choices might hurt readability — should I add a subtle frosted-glass
  layer behind text blocks to keep everything crisp and legible?"

── SKIP ask-back entirely (requiresAskBack: false) when ALL of these are true ──
  • A colour scheme, mood, or visual style is clearly stated in the prompt
  • The core feature or interaction is unambiguous
  • No critical workflow or data storage question is unanswered

── ENRICHED NOTES ─────────────────────────────────────────────────────────
enrichedNotes: Extract and summarise in max 80 words:
  - Domain/industry context
  - Named features or sections the user mentioned
  - Any colours, theme, or visual style stated (even if vague — capture it)
  - Target audience if mentioned
  - Any technical constraints
If the prompt is very vague, write: "No additional context."
If the user chose a theme (via previous answer or in the prompt), include: "Theme: [their choice]"`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    archetype:       { type: 'string', enum: ['NOVICE', 'BUILDER', 'EXPERT'] },
    requiresAskBack: { type: 'boolean' },
    askBackQuestion: { type: 'string' },
    enrichedNotes:   { type: 'string' },
  },
  required: ['archetype', 'requiresAskBack', 'askBackQuestion', 'enrichedNotes'],
};

/**
 * @param {string} userMessage
 * @param {string} apiKey
 * @param {string} [model]
 * @returns {{ archetype, requiresAskBack, askBackQuestion, enrichedNotes }}
 */
async function analyzePlanPhase(userMessage, apiKey, model = 'gemini-2.0-flash') {
  const ai = new GoogleGenAI({ apiKey });
  const prompt = ANALYSIS_PROMPT.replace('{PROMPT}', userMessage);

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 600,
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

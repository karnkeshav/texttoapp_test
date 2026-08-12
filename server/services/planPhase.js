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

const { pooledGenerate } = require('./geminiPool');

const ANALYSIS_PROMPT = `You are a design-aware requirements analyst for Ready4Launch — a platform that converts plain-English descriptions into complete, beautiful HTML+JS web apps.

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
async function analyzePlanPhase(userMessage, apiKey, _model) {
  const prompt = ANALYSIS_PROMPT.replace('{PROMPT}', userMessage);

  // pooledGenerate cycles through all working SDK/model slots automatically
  const rawText = await pooledGenerate({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 600,
    },
    apiKey,
  });

  const parsed = JSON.parse(rawText);
  return {
    archetype:       parsed.archetype       || 'NOVICE',
    requiresAskBack: parsed.requiresAskBack ?? false,
    askBackQuestion: parsed.askBackQuestion || '',
    enrichedNotes:   parsed.enrichedNotes   || '',
  };
}

/**
 * Compile 5 gathered Q&A answers into a structured build brief.
 * Used by complete-mode conversations after all questions are answered.
 *
 * @param {Array<{q:string, a:string}>} gatheredAnswers
 * @param {string} originalRequest
 * @param {string} apiKey
 * @returns {Promise<string>} — 200-350 word spec
 */
async function compileSpec(gatheredAnswers, originalRequest, apiKey) {
  const qaText = gatheredAnswers
    .map((qa, i) => `Q${i + 1}: ${qa.q.split('\n')[0].replace(/\*\*/g, '').trim()}\nAnswer: ${qa.a}`)
    .join('\n\n');

  const prompt = `You are a senior product manager writing a build brief for an AI frontend developer.

Based on this requirements interview, write a focused specification (200–350 words) covering:
1. Core purpose — what the app does and the problem it solves
2. Target users — who uses it, their context, technical level
3. Must-have features — numbered list, specific
4. Technical / UX constraints (offline, mobile-first, data export, etc.)
5. Visual direction — style, mood, colours

Original request: "${originalRequest}"

Interview Q&A:
${qaText}

Write in imperative, builder-focused language. Be specific and actionable. No waffle.`;

  return pooledGenerate({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.3, maxOutputTokens: 700 },
    apiKey,
  });
}

/**
 * Generate a contextual discovery preview for Complete Product mode.
 *
 * @param {string} originalRequest
 * @param {string} planNotes
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function generateDiscoveryPreview(originalRequest, planNotes, apiKey) {
  const domainMatch = originalRequest.match(/\b(bookstore|restaurant|fitness|clinic|portfolio|ecommerce|inventory|task|blog|chat|recipe|school|hotel|bank)\b/i);
  const domainTerm = domainMatch ? domainMatch[1].toLowerCase() : 'application';

  const prompt = `You are an expert product analyst for Ready4Launch.
Write a warm, professional, domain-aware Discovery Preview (100–150 words) for a user building a "${domainTerm}" app based on prompt: "${originalRequest}".

Requirements:
1. Acknowledge the user's specific product idea ("${originalRequest}") using domain terms.
2. Outline that you will ask 5 focused questions covering:
   - customers and users
   - core workflow and features
   - data and operations
   - integrations/live functionality
   - experience and design
3. State explicit estimates:
   - Estimated discovery time: ~5–8 minutes
   - Estimated build time: ~5–15 minutes for a moderate application
4. Include helpful guidance: "You can answer in plain language. If you don't know something, say 'I don't know' and Ready4Launch will recommend an approach."

Do not ask Question 1 here — this is just the preview intro.`;

  try {
    const text = await pooledGenerate({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.3, maxOutputTokens: 350 },
      apiKey,
    });
    if (text && text.trim().length > 30) return text.trim();
  } catch (err) {
    console.warn('[DiscoveryPreview] Fallback used:', err.message);
  }

  // Fallback if API unavailable
  return `Great — I understand you're building a ${domainTerm} app based on your request: "${originalRequest}".

I'll ask 5 focused questions to define your requirements without asking you to repeat information:
• Users and audience
• Core workflow and features
• Data and store operations
• Integrations and live functionality
• Experience and visual design

⏱️ **Estimated discovery time:** ~5–8 minutes
🚀 **Estimated build time:** ~5–15 minutes for a moderate application

*You can answer in plain language. If you don't know something, say "I don't know" and Ready4Launch will recommend an approach.*`;
}

/**
 * Generate a single contextual discovery question tailored to the current area and project state.
 *
 * @param {Object} opts
 * @param {string} opts.originalRequest
 * @param {string} opts.planNotes
 * @param {Array<{q:string, a:string}>} opts.gatheredAnswers
 * @param {number} opts.areaIndex - 0..4
 * @param {boolean} [opts.isFollowUp]
 * @param {string} opts.apiKey
 * @returns {Promise<string>}
 */
async function generateContextualQuestion({ originalRequest, planNotes, gatheredAnswers, areaIndex, isFollowUp, apiKey }) {
  const AREA_TITLES = [
    'Product + Core Workflow',
    'Users + Roles + Scale',
    'Data + Business Operations',
    'Integrations + Live Functionality',
    'Experience + Design'
  ];

  const currentAreaTitle = AREA_TITLES[areaIndex] || AREA_TITLES[0];
  const qNumber = isFollowUp ? `Follow-up` : `Question ${areaIndex + 1} of 5`;

  const previousQA = (gatheredAnswers || [])
    .map(item => `Q: ${item.q.split('\n')[0].replace(/\*\*/g, '').trim()}\nA: ${item.a}`)
    .join('\n\n');

  const prompt = `You are a product analyst conducting a requirements discovery interview.

Original Prompt: "${originalRequest}"
Context Notes: "${planNotes || ''}"

Previous Interview Answers:
${previousQA || '(None yet)'}

Task: Write ONE targeted, non-repetitive question for: ${qNumber} — ${currentAreaTitle}.

Rules:
1. Acknowledge what the user has ALREADY specified in their prompt or answers. DO NOT ask them to repeat facts already known.
2. If the user said "I don't know" in their last answer, acknowledge it warmly, state a recommended default approach, and ask the next question.
3. Use domain-specific terms from their prompt (e.g. bookstore, books, inventory, customers, stock).
4. Make the question specific, actionable, and easy for a non-technical user to answer.
5. Format the question heading exactly as: "**${qNumber} — ${currentAreaTitle}:**" followed by the question.`;

  try {
    const text = await pooledGenerate({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.3, maxOutputTokens: 300 },
      apiKey,
    });
    if (text && text.trim().length > 20) return text.trim();
  } catch (err) {
    console.warn('[ContextualQuestion] Fallback used:', err.message);
  }

  // Domain-aware fallback
  const isBookstore = /bookstore|book/i.test(originalRequest);
  if (areaIndex === 0) {
    if (isBookstore) {
      return `**${qNumber} — Product + Core Workflow:** Should customers only browse and search the books available in the store, or should they also be able to reserve, order, or purchase books?`;
    }
    return `**${qNumber} — Product + Core Workflow:** What is the primary job-to-be-done for someone using this application, and what main outcome should it produce?`;
  }
  if (areaIndex === 1) {
    return `**${qNumber} — Users + Roles + Scale:** Who are the main users accessing this application (e.g. general public, registered members, staff administrators), and do different users need different permissions?`;
  }
  if (areaIndex === 2) {
    return `**${qNumber} — Data + Business Operations:** What data needs to be saved between visits (e.g. user accounts, saved items, history, inventory), and should the app come with pre-loaded sample data?`;
  }
  if (areaIndex === 3) {
    return `**${qNumber} — Integrations + Live Functionality:** Are there any specific live features needed, such as data export (CSV/PDF), search/filtering, notifications, or third-party API connections?`;
  }
  return `**${qNumber} — Experience + Design:** What visual style and mood fits best (e.g. Dark & Sleek, Light & Clean, Minimal Pro), and are there any specific brand colors or palettes you prefer?`;
}

module.exports = { analyzePlanPhase, compileSpec, generateDiscoveryPreview, generateContextualQuestion };

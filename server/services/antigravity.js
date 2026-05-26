/**
 * AI service — Antigravity (primary) + Gemini (fallback)
 *
 * Primary:  Antigravity Interactions API via API key
 *           POST generativelanguage.googleapis.com/v1beta/interactions?key=…
 * Fallback: Google GenAI SDK (gemini-3.1-flash-lite) — kicks in on 429 / 5xx
 */

const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

// ── System prompt ─────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `You are AppBuilder — an expert web developer who builds complete, production-ready web applications using only HTML and vanilla JavaScript.

═══════════════════════════════════════════
PHASE 1 — INTENT ANALYSIS (run on EVERY user message)
═══════════════════════════════════════════

Classify the incoming prompt silently into one of three archetypes:

▸ VISIONARY NOVICE — broad goal descriptions ("I need a landing page for my dental clinic")
  → You have enough context. BUILD SILENTLY. Do not ask questions.

▸ SEMI-TECHNICAL BUILDER — mentions React, Vue, Angular, Next.js, Nuxt, Svelte, TypeScript, etc.
  → Intercept immediately. Respond with ONE sentence: "Great concept — I'll build this as a fully optimised Vanilla JavaScript app, which gives you instant deployment to GitHub Pages with zero build steps."
  → Then proceed to build or ask only if a critical gap exists (see below).

▸ FUNCTIONAL EXPERT — specifies tech, design tokens, or feature flows explicitly
  → Follow their spec exactly. BUILD SILENTLY.

═══════════════════════════════════════════
PHASE 2 — SILENT BUILD GATE
═══════════════════════════════════════════

BUILD WITHOUT ASKING if the prompt provides ALL of the following:
  ✓ The app's purpose (what it does)
  ✓ At least one feature or user interaction
  ✓ Target audience is obvious from context OR explicitly stated

If these three conditions are met → SKIP ALL QUESTIONS and go straight to building.

═══════════════════════════════════════════
PHASE 3 — ASK-BACK GATE (use SPARINGLY)
═══════════════════════════════════════════

Pause ONLY when one of these three critical architectural gaps exists.
Maximum 1–2 questions per response. Never a numbered list of 5+ questions.

  GAP 1 — CRITICAL WORKFLOW VOID
  The prompt demands an interactive calculation or data-entry utility but provides
  zero input fields or logic flow (e.g. "expense manager" with no further detail).
  Ask: "I have the core interface ready. Should I include a transaction input wizard,
  or pre-populate it with realistic seed data so it's immediately usable?"

  GAP 2 — SEVERE CONTRAST VIOLATION
  The user forces specific design choices that break legibility (dark text on dark bg).
  Ask: "Your colour choices conflict with legibility standards. Should I apply a frosted-
  glass overlay behind text blocks to enforce readable contrast automatically?"

  GAP 3 — DATA LIFECYCLE AMBIGUITY
  User requests persistent state (saved items, favourites, progress) with no storage path.
  Ask: "To keep your data across page reloads I'll use browser localStorage. Should I
  pre-populate it with realistic mock data on first load?"

═══════════════════════════════════════════
PHASE 4 — GENERATION CONTRACT
═══════════════════════════════════════════

Before writing code, lock in this contract internally:

  [DATA MODE]:        Dynamic state via browser localStorage — no backend required.
  [LAYOUT]:          Mobile-first CSS (320px base) → primary hero at 1280px+ desktop.
  [UI ARCHITECTURE]: Pinned :root CSS variables · glassmorphism containers · WCAG AA contrast.
  [CONTENT]:         100% realistic, domain-specific copy — zero Lorem Ipsum.
  [DELIVERY]:        Single self-contained index.html — no external build tools.

═══════════════════════════════════════════
PHASE 5 — PRE-OUTPUT SANITY CHECK (mandatory)
═══════════════════════════════════════════

Before writing the first line of code, run this internal dry run:

  a. FEATURE TRACE  — step through every user action; confirm the code handles it
  b. JS SAFETY      — every function defined before called; event listeners after DOM ready
  c. CSS INTEGRITY  — every class/id in HTML exists in CSS; media queries mobile → desktop
  d. SPEC CHECK     — compare final feature list to user request; nothing missing, nothing extra
  e. VISUAL CHECK   — mentally render at 375px (mobile) and 1280px (laptop); polished at both

Only after passing all five checks → output REPO_NAME then the complete code.

═══════════════════════════════════════════
CORE RULES
═══════════════════════════════════════════

- Output ONLY HTML + vanilla JavaScript. No React, Vue, Angular, FastAPI, Node.js.
- Every app must work on GitHub Pages (static only — no backend, no database).
- Use localStorage or free public APIs (Open-Meteo, JSONbin.io) for data persistence.
- When ready to output code, say: "Perfect! I have everything I need. Let me now build your complete app."
- Do NOT include any manual GitHub Pages setup instructions — deployment is fully automated.
- Never mention Google, Gemini, Antigravity, any AI system, or underlying technology. You are AppBuilder.

═══════════════════════════════════════════
REPO NAME (REQUIRED on final code output)
═══════════════════════════════════════════

Place this as the very first line of your response — before any other text:
  REPO_NAME: your-app-slug
  Slug rules: lowercase, hyphen-separated, 2–5 words (e.g. "recipe-finder", "budget-tracker").

═══════════════════════════════════════════
DESIGN STANDARDS
═══════════════════════════════════════════

RESPONSIVE:
  - Mobile-first CSS; min-width breakpoints to scale up; Grid for layout, Flexbox for components
  - Primary experience optimised for 1280px+ laptop viewport
  - Min tap target 44×44px on mobile

VISUAL (latest trends, no compromises):
  - CSS custom properties (--color-*, --space-*, --font-*) for every repeating value
  - Bold hero gradients · frosted-glass panels (backdrop-filter: blur) · layered box-shadows
  - Typography: 1–2 Google Fonts · hero ≥ 56px desktop / ≥ 32px mobile · line-height 1.5–1.7
  - WCAG AA contrast minimum (4.5:1 body · 3:1 large text)

INTERACTIONS:
  - CSS transitions 0.2–0.3s ease on ALL interactive elements
  - Hover lift: transform: translateY(-2px) + enhanced shadow
  - Page-load entrance animations: fade-in + slide-up, staggered across sections
  - :active micro-animation: scale(0.97) on buttons
  - Smooth scroll: scroll-behavior: smooth on html element
  - Spinners / skeleton screens for async operations

CONTENT:
  - Realistic, domain-specific copy — never "Lorem ipsum"
  - Icons via Unicode or inline SVG only (no external icon libraries unless CDN-pinned)

---`;

// ── Build flat input string for Antigravity ───────────────────────
function buildInput(history, newUserMessage, enrichedNotes = '') {
  const lines = [SYSTEM_INSTRUCTION, ''];

  // Inject plan-phase enriched context if available (first-turn only)
  if (enrichedNotes && enrichedNotes !== 'No additional context.') {
    lines.push('── ENRICHED CONTEXT FROM PLAN PHASE ──');
    lines.push(enrichedNotes);
    lines.push('──────────────────────────────────────');
    lines.push('');
  }

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

// ── Build contents array for Gemini SDK ──────────────────────────
function buildContents(history, newUserMessage) {
  return [
    ...history.map(({ role, content }) => ({
      role: role === 'user' ? 'user' : 'model',
      parts: [{ text: content }],
    })),
    { role: 'user', parts: [{ text: newUserMessage }] },
  ];
}

// ── Extract text from Antigravity SSE event ───────────────────────
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

// ── Fallback trigger conditions ───────────────────────────────────
function shouldFallback(err) {
  const status = err.response?.status;
  return status === 429 || status === 503 || status === 502 || status === 500;
}

// ── PRIMARY: Antigravity Interactions API ─────────────────────────
async function streamFromAntigravity(newUserMessage, history, apiKey, agentId, onChunk, onDone, enrichedNotes = '') {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`;

  const response = await axios({
    method: 'post',
    url: endpoint,
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    data: {
      agent: agentId,
      input: buildInput(history, newUserMessage, enrichedNotes),
      environment: { type: 'remote_sandbox' },
      stream: true,
    },
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

// ── FALLBACK: Gemini GenAI SDK ────────────────────────────────────
async function streamFromGemini(newUserMessage, history, apiKey, modelName, onChunk, onDone) {
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContentStream({
    model: modelName,
    contents: buildContents(history, newUserMessage),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      temperature: 0.7,
      maxOutputTokens: 8192,
    },
  });

  let fullText = '';
  for await (const chunk of response) {
    const text = chunk.text;
    if (text) { fullText += text; onChunk(text); }
  }

  onDone(fullText);
  return fullText;
}

// ── Main entry point ──────────────────────────────────────────────
async function streamChat(newUserMessage, history, _googleTokens, onChunk, onDone, enrichedNotes = '') {
  const apiKey   = process.env.GEMINI_API_KEY;
  const agentId  = process.env.ANTIGRAVITY_AGENT_ID || 'antigravity-preview-05-2026';
  const gemModel = process.env.GEMINI_MODEL         || 'gemini-3.1-flash-lite';

  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env');

  try {
    console.log('[AI] Trying Antigravity…');
    await streamFromAntigravity(newUserMessage, history, apiKey, agentId, onChunk, onDone, enrichedNotes);
    console.log('[AI] Antigravity ✅');
  } catch (err) {
    if (shouldFallback(err)) {
      console.warn(`[AI] Antigravity ${err.response?.status} — falling back to Gemini (${gemModel})`);
      await streamFromGemini(newUserMessage, history, apiKey, gemModel, onChunk, onDone);
      console.log('[AI] Gemini fallback ✅');
    } else {
      console.error('[AI] Antigravity error (no fallback):', err.response?.status, err.message);
      throw err;
    }
  }
}

module.exports = { streamChat };

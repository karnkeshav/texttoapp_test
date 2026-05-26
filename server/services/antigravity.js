/**
 * AI service — Antigravity (primary) + Gemini pool (fallback)
 *
 * Primary:  Antigravity Interactions API via API key
 *           POST generativelanguage.googleapis.com/v1beta/interactions?key=…
 * Fallback: geminiPool — round-robins both SDKs across all working models,
 *           cools down quota-exhausted slots and retries automatically.
 */

const axios = require('axios');
const { pooledStream } = require('./geminiPool');

// ── Circuit breaker (module-level — shared across all requests) ───
// When Antigravity returns 429 the breaker "trips" and all subsequent
// requests are routed straight to Gemini pool for COOLDOWN_MS milliseconds.
// After cooldown the next request probes Antigravity again; if it 429s
// again the breaker re-trips automatically.
const antigravityBreaker = {
  cooldownUntil: 0,
  COOLDOWN_MS: 5 * 60 * 1000, // 5 minutes

  isOpen() {
    return Date.now() < this.cooldownUntil;
  },

  trip() {
    this.cooldownUntil = Date.now() + this.COOLDOWN_MS;
    const resetAt = new Date(this.cooldownUntil).toLocaleTimeString();
    console.warn(`[AI] ⚡ Antigravity circuit breaker OPEN — Gemini pool takes over until ${resetAt}`);
  },

  remainingSeconds() {
    return Math.max(0, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
  },
};

// ── System prompt ─────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `You are AppBuilder — an elite frontend engineer who crafts visually stunning, fully functional single-page web apps using only HTML and vanilla JavaScript.

══════════════════════════════════════════════════════
MANDATORY DESIGN SYSTEM  (every rule applies to every app — no exceptions)
══════════════════════════════════════════════════════

Read enrichedNotes first. Apply the user's chosen theme/colours exactly.
If no theme was stated, choose a dark base with a domain-appropriate accent colour.

▌ COLOUR ARCHITECTURE
:root {
  /* Dark themes (default) */
  --bg:       #09090f;   /* deepest background */
  --bg-2:     #111118;   /* section alternation */
  --surface:  rgba(255,255,255,0.05);   /* card/panel fill */
  --border:   rgba(255,255,255,0.08);   /* card borders */
  --border-h: rgba(255,255,255,0.16);   /* hover borders */
  --text:     #f1f5f9;
  --text-2:   #94a3b8;
  --text-3:   #64748b;

  /* Accent — pick from domain context: */
  /* Tech/SaaS:    --accent:#7c3aed; --accent-2:#3b82f6; */
  /* Fitness:      --accent:#22c55e; --accent-2:#16a34a; */
  /* Finance:      --accent:#10b981; --accent-2:#0284c7; */
  /* Food/Resto:   --accent:#f59e0b; --accent-2:#ef4444; */
  /* Health:       --accent:#06b6d4; --accent-2:#8b5cf6; */
  /* Creative:     --accent:#ec4899; --accent-2:#f97316; */
  --accent:   /* choose based on domain */;
  --accent-2: /* complementary */;
  --grad:     linear-gradient(135deg, var(--accent), var(--accent-2));
}
/* Light theme override (if user chose light): swap --bg:#f8fafc, --surface:rgba(0,0,0,0.04),
   --border:rgba(0,0,0,0.08), --text:#0f172a, --text-2:#64748b */

▌ PATTERN 1 — HERO SECTION  (mandatory opening — every app must start with this)
.hero {
  min-height: 100vh;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 120px 24px 80px;
  /* Apply a rich gradient that uses the accent: */
  background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(ACCENT_RGB,0.25) 0%, transparent 70%),
              linear-gradient(160deg, var(--bg) 0%, var(--bg-2) 100%);
}
/* Floating ambient orbs — creates depth */
.orb {
  position: absolute; border-radius: 50%; pointer-events: none;
  filter: blur(90px); opacity: 0.18; animation: floatOrb 9s ease-in-out infinite;
}
.orb-1 { width:500px; height:500px; background:var(--accent); top:-120px; left:-80px; }
.orb-2 { width:400px; height:400px; background:var(--accent-2); bottom:-80px; right:-60px; animation-delay:-4s; }
.orb-3 { width:300px; height:300px; background:var(--accent); top:40%; left:55%; animation-delay:-7s; }
@keyframes floatOrb {
  0%,100% { transform: translateY(0) scale(1); }
  50%      { transform: translateY(-28px) scale(1.06); }
}

▌ PATTERN 2 — GLASSMORPHISM CARDS  (all content panels, feature cards, modals)
.card {
  background: var(--surface);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 32px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.35), 0 1px 0 rgba(255,255,255,0.06) inset;
  transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
}
.card:hover {
  transform: translateY(-4px);
  border-color: var(--border-h);
  box-shadow: 0 20px 60px rgba(0,0,0,0.4), 0 0 0 1px var(--border-h);
}

▌ PATTERN 3 — GRADIENT HEADINGS  (hero title + any primary section heading)
.headline {
  font-size: clamp(40px, 5.5vw, 72px);
  font-weight: 900;
  line-height: 1.08;
  letter-spacing: -2.5px;
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 50%, #fff 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

▌ PATTERN 4 — ENTRANCE ANIMATIONS  (stagger all page elements on load)
@keyframes fadeUp   { from { opacity:0; transform:translateY(28px); } to { opacity:1; transform:translateY(0); } }
@keyframes fadeIn   { from { opacity:0; }                              to { opacity:1; } }
@keyframes scaleIn  { from { opacity:0; transform:scale(0.94); }      to { opacity:1; transform:scale(1); } }
/* Apply to sections/cards: */
.animate { animation: fadeUp 0.55s cubic-bezier(0.22,1,0.36,1) both; }
/* Stagger via: nth-child(1){animation-delay:.05s} nth-child(2){animation-delay:.15s} ... up to 6 */

▌ PATTERN 5 — BUTTONS  (every clickable action)
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--grad);
  color: #fff; border: none; border-radius: 12px;
  padding: 14px 28px; font-size: 15px; font-weight: 700; cursor: pointer;
  transition: all 0.22s ease;
  box-shadow: 0 4px 20px rgba(ACCENT_RGB, 0.4);
  font-family: inherit;
}
.btn:hover  { transform: translateY(-2px); box-shadow: 0 10px 36px rgba(ACCENT_RGB, 0.55); }
.btn:active { transform: scale(0.96); }
/* Ghost variant: */
.btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-2); box-shadow:none; }
.btn-ghost:hover { border-color:var(--border-h); color:var(--text); }

▌ PATTERN 6 — FORM INPUTS
input, textarea, select {
  width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px 18px; color: var(--text);
  font-size: 15px; font-family: inherit; outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
input:focus, textarea:focus, select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(ACCENT_RGB, 0.15);
}
input::placeholder { color: var(--text-3); }

▌ TYPOGRAPHY
Import 1–2 Google Fonts. Preferred: Inter (all weights) or Sora for headings.
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
body { font-family: 'Inter', -apple-system, sans-serif; }
Hero heading: clamp(40px,6vw,72px) weight 900. Section headings: 28–40px weight 800.
Body: 16px, line-height 1.75. All text: WCAG AA (4.5:1 body / 3:1 large).

▌ LAYOUT
Mobile-first. Base at 320px. Primary viewport: 1280px laptop.
Use CSS Grid for page layout, Flexbox for components.
.container { max-width:1200px; margin:0 auto; padding:0 24px; }
Min tap target: 44×44px. Smooth scroll: html { scroll-behavior:smooth; }

▌ FULLY FUNCTIONAL UI — MANDATORY
Every button MUST do something visible.
Every form MUST validate, submit, and update the UI.
Every listed feature MUST be implemented and interactive.
Use localStorage for ALL persistence. Pre-populate with 4–6 realistic sample items on first load.
Show empty-states (with icon + message + action button) when lists are empty.
Show loading states (spinner or skeleton) for any async operation.

▌ CONTENT — ZERO TOLERANCE FOR PLACEHOLDERS
100% realistic, domain-specific copy — every word.
No "Lorem ipsum". No "Sample text". No "Coming soon". No "Placeholder".
Real feature names, real micro-copy, real sample data that fits the domain.
Sample data should be believable: real-sounding names, realistic numbers, proper dates.

══════════════════════════════════════════════════════
BEHAVIOUR
══════════════════════════════════════════════════════

• enrichedNotes will contain the user's chosen theme/colours — apply them exactly. Do NOT re-ask about design.
• NOVICE prompt → build immediately, using enrichedNotes for all context.
• BUILDER prompt (React / Vue / Angular / Next.js / Svelte / TypeScript mentioned):
  Reply ONE sentence: "Great idea — I'll build this as a Vanilla JS app for instant GitHub Pages deployment with zero build steps."
  Then build immediately.
• EXPERT prompt → follow their spec exactly.

ASK a question ONLY when a critical FUNCTIONAL gap would break the build:
  → "expense tracker" with no description of what's tracked — ask what categories/data
  → "quiz app" with no content — ask what topic or offer to generate sample questions
  Maximum 1 question. Never ask about colours or design after the user already answered.

══════════════════════════════════════════════════════
OUTPUT FORMAT
══════════════════════════════════════════════════════

When ready to build, say exactly: "Here's your [app name]! 🚀"

Then on the VERY NEXT LINE output:
  REPO_NAME: your-app-slug
  (lowercase, hyphens, 2–5 words — e.g. "recipe-finder", "budget-tracker", "gym-log")

Then the COMPLETE self-contained app in a single \`\`\`html code block.
One file only. No separate CSS or JS files. All styles in <style>, all logic in <script>.
No CDN libraries except Google Fonts. No external dependencies.
Do NOT include GitHub Pages setup instructions — deployment is automated.
Never reveal: Google, Gemini, Antigravity, any AI model, or underlying technology.

══════════════════════════════════════════════════════
SILENT SANITY CHECK  (run before writing the first line of code)
══════════════════════════════════════════════════════

DESIGN CHECK:
  ✓ Hero section with gradient background + floating orb elements
  ✓ Glassmorphism cards on all content panels (backdrop-filter: blur)
  ✓ Gradient heading on the main title
  ✓ fadeUp entrance animations on load (staggered delays)
  ✓ All buttons have hover lift + active scale states

FUNCTION CHECK:
  ✓ Every button triggers a visible action
  ✓ All localStorage reads/writes working correctly
  ✓ All JS functions defined before use; DOM queries run after DOMContentLoaded
  ✓ All CSS classes referenced in HTML exist in <style>

CONTENT CHECK:
  ✓ Zero Lorem Ipsum or placeholder text
  ✓ 4–6 realistic sample data items pre-loaded
  ✓ Empty states shown when no data exists

LAYOUT CHECK:
  ✓ Renders correctly at 375px (mobile)
  ✓ Polished and spacious at 1280px (laptop)

SPEC CHECK:
  ✓ Every feature mentioned by the user is implemented
  ✓ User's chosen theme/colours from enrichedNotes are applied

All checks pass → write the code. Any check fails → fix it first.

---`;

// ── Build flat input string for Antigravity ───────────────────────
// Only the last 3 history turns are embedded in the flat input string.
// The build spec / style choices live in enrichedNotes, not in raw history,
// so trimming history here doesn't lose any critical build context while
// keeping the per-request token footprint well inside Antigravity's quota.
function buildInput(history, newUserMessage, enrichedNotes = '') {
  const lines = [SYSTEM_INSTRUCTION, ''];

  // Inject plan-phase enriched context if available
  if (enrichedNotes && enrichedNotes !== 'No additional context.') {
    lines.push('── ENRICHED CONTEXT FROM PLAN PHASE ──');
    lines.push(enrichedNotes);
    lines.push('──────────────────────────────────────');
    lines.push('');
  }

  // Trim to last 3 turns — reduces TPM without losing spec context
  const recentHistory = history.slice(-3);
  if (recentHistory.length > 0) {
    lines.push('CONVERSATION SO FAR:');
    recentHistory.forEach(({ role, content }) => {
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
// Fallback to Gemini on ANY HTTP error from Antigravity (quota, agent config,
// server errors, bad request, deprecated endpoint — everything).
// Only re-throw for true network-level failures where no HTTP response arrived
// (ECONNREFUSED, ETIMEDOUT, DNS failure) — Gemini would fail for the same reason.
function shouldFallback(err) {
  return err.response != null; // HTTP response received (any status) → fallback
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

// ── FALLBACK: Gemini pool (both SDKs, all working models) ─────────
async function streamFromGeminiPool(newUserMessage, history, apiKey, onChunk, onDone, enrichedNotes = '') {
  // Inject plan context so Gemini gets the same context as Antigravity
  let contextualMessage = newUserMessage;
  if (enrichedNotes && enrichedNotes !== 'No additional context.') {
    contextualMessage =
      `── PLAN CONTEXT ──\n${enrichedNotes}\n──────────────────\n\n${newUserMessage}`;
  }

  await pooledStream({
    contents:          buildContents(history, contextualMessage),
    config:            { temperature: 0.7, maxOutputTokens: 32768 },
    apiKey,
    systemInstruction: SYSTEM_INSTRUCTION,
    onChunk,
    onDone,
  });
}

// ── Main entry point ──────────────────────────────────────────────
async function streamChat(newUserMessage, history, _googleTokens, onChunk, onDone, enrichedNotes = '') {
  const apiKey  = process.env.GEMINI_API_KEY;
  const agentId = process.env.ANTIGRAVITY_AGENT_ID || 'antigravity-preview-05-2026';

  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env');

  // ── Circuit breaker: skip Antigravity while cooling down after a 429 ──
  if (antigravityBreaker.isOpen()) {
    console.log(`[AI] Antigravity breaker open (${antigravityBreaker.remainingSeconds()}s left) — routing to Gemini pool`);
    await streamFromGeminiPool(newUserMessage, history, apiKey, onChunk, onDone, enrichedNotes);
    console.log('[AI] Gemini pool ✅');
    return;
  }

  try {
    console.log('[AI] Trying Antigravity…');
    await streamFromAntigravity(newUserMessage, history, apiKey, agentId, onChunk, onDone, enrichedNotes);
    console.log('[AI] Antigravity ✅');
  } catch (err) {
    if (shouldFallback(err)) {
      // Trip the breaker specifically on 429 (quota exhausted).
      // Other HTTP errors (500, 503, 400) fall back once without tripping the breaker
      // — they're transient and shouldn't lock out Antigravity for 5 minutes.
      if (err.response?.status === 429) {
        antigravityBreaker.trip();
      } else {
        console.warn(`[AI] Antigravity ${err.response?.status} — one-shot fallback (breaker not tripped)`);
      }
      await streamFromGeminiPool(newUserMessage, history, apiKey, onChunk, onDone, enrichedNotes);
      console.log('[AI] Gemini pool ✅');
    } else {
      console.error('[AI] Antigravity network error (no fallback):', err.message);
      throw err;
    }
  }
}

module.exports = { streamChat };

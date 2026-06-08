'use strict';

const { pooledGenerate } = require('./geminiPool');
const { groqGenerate }   = require('./groqPool');

function buildCompressionPrompt(history, enrichedNotes, stack) {
  const stackLabel = stack
    ? `${stack.frontend || 'html'}${stack.backend && stack.backend !== 'none' ? ' + ' + stack.backend : ''} (${stack.type || 'static'})`
    : 'static HTML';

  const conversationText = history
    .map(turn => {
      const role    = turn.role === 'user' ? 'USER' : 'ASSISTANT';
      const content = (turn.content || '')
        .replace(/```[\s\S]*?```/gs, '[code generated]')
        .replace(/REPO_NAME:\s*[^\n]+/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (content.length < 5) return null;
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return `You are a senior technical analyst preparing a build brief
for a software engineer who will generate code from it.
The engineer sees ONLY this brief — not the conversation.
Missing details = missing features. Be precise and complete.

STACK: ${stackLabel}

REQUIREMENTS FROM PLAN PHASE:
${enrichedNotes || 'No additional context provided.'}

CONVERSATION (Q&A, choices, preferences):
${conversationText || 'No conversation history.'}

Write a precise build brief with these exact sections.
Write in direct requirement language — not "user said" but "the app must".
No code. No commentary. No preamble. Maximum 800 words.

APP OVERVIEW:
One sentence: what the app does and who uses it.

TECH STACK:
Frontend: [exact value]
Backend: [exact value or "none — static app"]
Type: [static / dynamic / pwa / ssr]
Deployment: [github-pages / localhost / manual]

FEATURES — implement every one of these exactly:
[List every feature with full interaction detail.
Not "dashboard" but "dashboard with line chart showing
daily signups for the last 30 days, filterable by date range".]

DATA & PERSISTENCE:
[What data exists, how stored, what sample data looks like,
initial state on first load.]

DESIGN & STYLE:
[Exact colours chosen, dark/light theme, font preferences,
mood words, any UI patterns requested.]

API STRUCTURE (if backend exists):
[Every API endpoint needed, what it receives, what it returns.]

FILE STRUCTURE EXPECTED:
[List the exact files that must be generated for this stack.]

CONSTRAINTS & PREFERENCES:
[Mobile-first vs desktop, export needs, anything explicitly
NOT wanted, performance requirements.]`;
}

function selectBuildModel(brief, stack) {
  const hasBackend         = stack?.backend && stack.backend !== 'none';
  const hasComplexFeatures = /auth|database|realtime|websocket|payment|oauth|jwt|crud|search|filter/i.test(brief);
  const hasMultiFile       = /multiple files|separate|api routes|endpoints/i.test(brief);
  const isLargeApp         = brief.split(' ').length > 400;

  if (hasBackend && (hasComplexFeatures || isLargeApp)) {
    return { tier: 'build', hint: 'gemini-3-flash-preview', reason: 'backend + complex features' };
  }
  if (hasBackend || hasMultiFile) {
    return { tier: 'build', hint: 'gemini-2.5-flash', reason: 'backend or multi-file' };
  }
  return { tier: 'build', hint: 'gemini-2.5-flash', reason: 'static or simple SPA' };
}

async function compileBrief(history, enrichedNotes, stack, apiKey) {
  const prompt = buildCompressionPrompt(history, enrichedNotes, stack);

  console.log(`[BriefCompiler] Compiling brief from ${history.length} turns + ${enrichedNotes?.length || 0} char spec`);

  let brief = null;

  // Attempt 1: Gemini chat-tier (lite model — cheap and fast)
  try {
    brief = await pooledGenerate({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config:   { temperature: 0.1, maxOutputTokens: 1024 },
      apiKey,
      tier:     'chat',
    });
    if (brief && brief.trim().length > 100) {
      console.log(`[BriefCompiler] ✅ Gemini chat-tier — ${brief.length} chars (~${Math.ceil(brief.length / 4)} tokens)`);
    } else {
      brief = null;
    }
  } catch (e) {
    console.warn('[BriefCompiler] Gemini chat-tier failed:', e.message);
  }

  // Attempt 2: Groq 8b (high quota, cheap)
  if (!brief) {
    try {
      brief = await groqGenerate({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config:   { temperature: 0.1, maxOutputTokens: 1024 },
        apiKey:   process.env.GROQ_API_KEY,
        tier:     'chat',
      });
      if (brief && brief.trim().length > 100) {
        console.log(`[BriefCompiler] ✅ Groq chat-tier — ${brief.length} chars (~${Math.ceil(brief.length / 4)} tokens)`);
      } else {
        brief = null;
      }
    } catch (e) {
      console.warn('[BriefCompiler] Groq chat-tier failed:', e.message);
    }
  }

  // Fallback: use enrichedNotes directly — still safe (~3,000 tokens max)
  if (!brief) {
    console.warn('[BriefCompiler] All compression failed — using enrichedNotes as brief');
    brief = enrichedNotes || 'Build the application as described by the user.';
  }

  const modelHint = selectBuildModel(brief, stack);
  console.log(`[BriefCompiler] Model hint: ${modelHint.hint} (${modelHint.reason})`);

  return { brief, modelHint };
}

module.exports = { compileBrief, selectBuildModel };

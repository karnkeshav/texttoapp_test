'use strict';
/**
 * Diagnostic: simulate a two-turn conversation through the Gemini pool
 * and print the full output so we can see whether REPO_NAME + ```html appears.
 *
 * Run with: node scripts/diagnose-gemini-output.js
 */

require('dotenv').config();
const { streamChat } = require('../server/services/antigravity');

// Simulate the exact second-turn history the server would pass
// (first turn: user says "build me a counter", AI asks style question)
const STYLE_Q = 'One quick thing before I build — what vibe? 🎨 Dark & Sleek (black/purple), ☀️ Light & Clean (white/blue), or describe your own style!';

const history = [
  { role: 'user',      content: 'build me a simple counter app' },
  { role: 'assistant', content: STYLE_Q },
];

const newUserMessage = 'Dark and sleek';
const enrichedNotes  = 'Domain: counter app. User chose: Dark and sleek (black/purple theme).';

let chunks = 0;
let totalLen = 0;
let startTime = Date.now();

console.log('=== Gemini Pool Output Diagnostic ===');
console.log('Sending 2nd-turn message:', JSON.stringify(newUserMessage));
console.log('History length:', history.length);
console.log('Enriched notes:', enrichedNotes);
console.log('');
console.log('─── Streaming output ───');

const onChunk = (text) => {
  chunks++;
  totalLen += text.length;
  // Print first 200 chars of each chunk for visibility
  if (chunks <= 5 || chunks % 20 === 0) {
    process.stdout.write(`[chunk ${chunks}, +${text.length}] ${text.slice(0, 120).replace(/\n/g, '↵')}\n`);
  }
};

const onDone = (fullText) => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`─── Done in ${elapsed}s — ${chunks} chunks, ${totalLen} chars ───`);
  console.log('');

  // Check for REPO_NAME
  const repoMatch = fullText.match(/REPO_NAME\s*:\s*([^\n]+)/i);
  console.log('REPO_NAME found:', repoMatch ? repoMatch[1].trim() : '❌ NOT FOUND');

  // Check for ```html block
  const hasHtmlOpen = /```html/i.test(fullText);
  console.log('```html block:  ', hasHtmlOpen ? '✅ FOUND' : '❌ NOT FOUND');

  // Check for closing ```
  const completeBlock = /```html[\s\S]*?```/i.test(fullText);
  console.log('Closing ```:    ', completeBlock ? '✅ FOUND' : '❌ NOT FOUND (truncated)');

  // Check for </html> (fallback trigger)
  const hasEndHtml = /<\/html>/i.test(fullText);
  console.log('</html> found:  ', hasEndHtml ? '✅ FOUND' : '❌ NOT FOUND');

  // checkForCode logic (from frontend)
  let htmlContent = null;
  const completeMatch = fullText.match(/```html\s*([\s\S]*?)```/i);
  if (completeMatch) htmlContent = completeMatch[1].trim();
  if (!htmlContent) {
    const truncatedMatch = fullText.match(/```html\s*([\s\S]*?<\/html>)/i);
    if (truncatedMatch) htmlContent = truncatedMatch[1].trim();
  }
  console.log('checkForCode:   ', htmlContent && htmlContent.length >= 50 ? `✅ WOULD SHOW DEPLOY (${htmlContent.length} chars of HTML)` : '❌ WOULD NOT SHOW DEPLOY');

  console.log('');
  console.log('─── First 500 chars of output ───');
  console.log(fullText.slice(0, 500));
  console.log('');
  console.log('─── Last 300 chars of output ───');
  console.log(fullText.slice(-300));
};

streamChat(newUserMessage, history, null, onChunk, onDone, enrichedNotes)
  .then(() => {
    console.log('');
    console.log('=== Diagnostic complete ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('');
    console.error('=== ERROR ===');
    console.error(err.message);
    if (err.response) {
      console.error('HTTP status:', err.response.status);
      console.error('Body:', JSON.stringify(err.response.data, null, 2).slice(0, 500));
    }
    process.exit(1);
  });

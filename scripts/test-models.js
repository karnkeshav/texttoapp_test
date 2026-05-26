'use strict';
const { GoogleGenAI } = require('@google/genai');

const key = process.env.GEMINI_API_KEY;
if (!key) { console.error('No GEMINI_API_KEY'); process.exit(1); }

const models = [
  'gemini-2.5-flash-preview-05-20',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.0-flash-exp',
  'gemini-2.5-flash-lite-preview-06-17',
];

const ai = new GoogleGenAI({ apiKey: key });

(async () => {
  for (const model of models) {
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: 'Reply with just the word: ok' }] }],
        config: { maxOutputTokens: 10 },
      });
      console.log(`✅ ${model.padEnd(40)} → ${(r.text || '').trim()}`);
    } catch (e) {
      const raw = e.message || String(e);
      const code = raw.match(/"code":(\d+)/)?.[1] || '?';
      const status = raw.match(/"status":"([^"]+)"/)?.[1] || 'unknown';
      const detail = raw.match(/"message":"([^"]{0,80})/)?.[1] || raw.slice(0, 80);
      console.log(`❌ ${model.padEnd(40)} → ${code} ${status}: ${detail}`);
    }
  }
})();

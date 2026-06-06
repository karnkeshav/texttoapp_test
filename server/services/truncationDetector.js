'use strict';

/**
 * Detects truncated output from AI model streams.
 * Used by all pools (Gemini, Groq, Cerebras, SambaNova) to identify
 * when a response was cut off mid-generation.
 */

function isStreamTruncated(text) {
  if (!text || text.length < 100) return true;

  // Unclosed code fences — every opening must have a closing
  const openFences  = (text.match(/^```\S*/gm) || []).length;
  const closeFences = (text.match(/^```\s*$/gm) || []).length;
  if (openFences > closeFences) return true;

  // HTML block present but </html> missing
  if (/```html/i.test(text) && !/<\/html>/i.test(text)) return true;

  // Go main.go present but file not closed
  const goBlocks = [...text.matchAll(/```go\s*([\s\S]*?)(?:```|$)/gi)];
  for (const block of goBlocks) {
    if (!block[0].endsWith('```')) return true;
  }

  // Python block present but not closed
  const pyBlocks = [...text.matchAll(/```python\s*([\s\S]*?)(?:```|$)/gi)];
  for (const block of pyBlocks) {
    if (!block[0].endsWith('```')) return true;
  }

  // Last non-empty line ends mid-expression
  const lines = text.trimEnd().split('\n').filter(l => l.trim());
  const lastLine = lines[lines.length - 1] || '';
  const isMidExpression =
    /[a-zA-Z0-9_`'"({[,\\]$/.test(lastLine) &&
    !lastLine.includes('```') &&
    !lastLine.trim().startsWith('//') &&
    !lastLine.trim().startsWith('#') &&
    !lastLine.trim().startsWith('*');
  if (isMidExpression) return true;

  return false;
}

module.exports = { isStreamTruncated };

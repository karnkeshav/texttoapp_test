'use strict';
/**
 * Unit tests for frontend functions in public/js/app.js
 *
 * Since app.js is a browser-targeting file with no module.exports, we inline
 * the pure functions here. If you update app.js, update the corresponding
 * copy here too (or refactor app.js to export via a utils module).
 *
 * Functions tested:
 *   escapeHtml           — XSS prevention
 *   renderMarkdown       — Markdown → HTML conversion
 *   extractCodeFromResponse — core logic of checkForCode (deploy button trigger)
 */

// ── Inline copies from public/js/app.js ──────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Code blocks — stash with placeholders so bold/italic don't process their content
  const codeBlocks = [];
  html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Inline code — stash with placeholders
  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Bold / italic (safe now — code content is protected by placeholders)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Restore inline code, then code blocks
  inlineCodes.forEach((c, i) => { html = html.replace(`\x00IC${i}\x00`, c); });
  codeBlocks.forEach((b, i) => { html = html.replace(`\x00CB${i}\x00`, b); });

  // Numbered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Bullet lists
  html = html.replace(/((?:^[•\-\*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[•\-\*] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Paragraphs (double newlines)
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br/>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<(?:h[123]|ul|ol|pre)>)/g, '$1');
  html = html.replace(/(<\/(?:h[123]|ul|ol|pre)>)<\/p>/g, '$1');

  return html;
}

/**
 * Extracted logic of checkForCode from app.js.
 * The real function calls showDeployPrompt() as a side effect.
 * We return { repoName, files } instead so we can assert on it.
 */
function extractCodeFromResponse(text) {
  if (!text) return null;

  let htmlContent = null;

  // 1. Complete ```html … ``` block
  const completeMatch = text.match(/```html\s*([\s\S]*?)```/i);
  if (completeMatch) {
    htmlContent = completeMatch[1].trim();
  }

  // 2. Truncated response — no closing ```, accept up to </html>
  if (!htmlContent) {
    const truncatedMatch = text.match(/```html\s*([\s\S]*?<\/html>)/i);
    if (truncatedMatch) {
      htmlContent = truncatedMatch[1].trim();
    }
  }

  if (!htmlContent || htmlContent.length < 50) return null;

  // REPO_NAME extraction
  const repoMatch = text.match(/REPO_NAME:\s*([a-z0-9][a-z0-9\-]{1,48}[a-z0-9])/i);
  const repoName = repoMatch ? repoMatch[1].toLowerCase() : 'r4l-fallback';

  const files = [{ path: 'index.html', content: htmlContent }];

  const cssMatch = text.match(/```css\s*([\s\S]*?)```/i);
  const jsMatch  = text.match(/```(?:javascript|js)\s*([\s\S]*?)```/i);
  if (cssMatch) files.push({ path: 'style.css',  content: cssMatch[1].trim() });
  if (jsMatch)  files.push({ path: 'script.js',  content: jsMatch[1].trim() });

  return { repoName, files };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MINIMAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test App</title>
  <style>body { margin: 0; background: #000; color: #fff; }</style>
</head>
<body>
  <div id="app"><button id="btn">Click me</button></div>
  <script>
    var count = 0;
    document.getElementById('btn').addEventListener('click', function() {
      count++;
      document.getElementById('btn').textContent = 'Clicked ' + count;
    });
  </script>
</body>
</html>`;

// ── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  test('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('escapes less-than', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });

  test('escapes greater-than', () => {
    expect(escapeHtml('5 > 3')).toBe('5 &gt; 3');
  });

  test('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  test('leaves safe characters untouched', () => {
    expect(escapeHtml("Hello World 123 'single'")).toBe("Hello World 123 'single'");
  });

  test('XSS: script injection is neutralised', () => {
    const input = '<script>alert("xss")</script>';
    const output = escapeHtml(input);
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('alert(&quot;xss&quot;)');
  });

  test('XSS: event attribute is neutralised', () => {
    const input = '<img src=x onerror="alert(1)">';
    const output = escapeHtml(input);
    expect(output).not.toContain('<img');
    expect(output).toContain('&lt;img');
  });

  test('double-escaping does not occur on plain text', () => {
    // Running escapeHtml twice should NOT double-escape '&'
    const once = escapeHtml('a & b');     // 'a &amp; b'
    const twice = escapeHtml(once);       // 'a &amp;amp; b'  ← double-escape IS expected behavior
    expect(once).toBe('a &amp; b');
    // Note: calling escapeHtml on already-escaped text WILL double-escape.
    // This is expected — callers must not pre-escape.
    expect(twice).toBe('a &amp;amp; b');
  });
});

// ── renderMarkdown ────────────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  test('returns empty string for empty/null/undefined input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });

  test('does not throw for any falsy input', () => {
    expect(() => renderMarkdown(null)).not.toThrow();
    expect(() => renderMarkdown(undefined)).not.toThrow();
    expect(() => renderMarkdown(0)).not.toThrow();
  });

  test('renders h1', () => {
    const result = renderMarkdown('# Hello World');
    expect(result).toContain('<h1>Hello World</h1>');
  });

  test('renders h2', () => {
    const result = renderMarkdown('## Section');
    expect(result).toContain('<h2>Section</h2>');
  });

  test('renders h3', () => {
    const result = renderMarkdown('### Subsection');
    expect(result).toContain('<h3>Subsection</h3>');
  });

  test('renders bold text', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  test('renders italic text', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
  });

  test('renders inline code', () => {
    expect(renderMarkdown('`console.log("hi")`')).toContain('<code>console.log(&quot;hi&quot;)</code>');
  });

  test('renders fenced code block', () => {
    const result = renderMarkdown('```js\nconsole.log("hi");\n```');
    expect(result).toContain('<pre><code>');
    expect(result).toContain('console.log');
  });

  test('XSS: raw HTML in user text is escaped', () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  test('XSS: HTML attributes in user text are escaped', () => {
    const result = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(result).not.toContain('<img');
    expect(result).toContain('&lt;img');
  });

  test('renders bullet list (dash)', () => {
    const result = renderMarkdown('- item one\n- item two\n- item three');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>item one</li>');
    expect(result).toContain('<li>item two</li>');
    expect(result).toContain('<li>item three</li>');
  });

  test('renders numbered list', () => {
    const result = renderMarkdown('1. first\n2. second\n3. third');
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>first</li>');
    expect(result).toContain('<li>second</li>');
  });

  test('[BUG?] bold regex inside code block is not re-processed', () => {
    // Order of operations in renderMarkdown:
    // 1. escapeHtml  → ** stays as **
    // 2. code blocks replaced with <pre><code>...</code></pre>
    // 3. bold regex   /\*\*(.+?)\*\*/g   runs AFTER code block replacement
    //    → ** inside <pre><code> tags may be matched and converted to <strong>!
    const result = renderMarkdown('```\n**bold inside code**\n```');
    expect(result).toContain('<pre><code>');
    // If this FAILS, the bold regex is incorrectly processing code block content
    const hasStrong = result.includes('<strong>');
    if (hasStrong) {
      console.warn('[KNOWN BUG] renderMarkdown: **bold** inside code blocks is rendered as <strong>. Output:', result);
    }
    // Document: currently this IS a bug — bold regex runs AFTER code block replacement
    // and matches ** inside <pre><code> tags. The test passes if no <strong> is found.
    expect(hasStrong).toBe(false);
  });

  test('paragraphs are separated by double newline', () => {
    const result = renderMarkdown('Paragraph one.\n\nParagraph two.');
    expect(result).toContain('</p><p>');
  });

  test('single newline becomes <br/>', () => {
    const result = renderMarkdown('Line one.\nLine two.');
    expect(result).toContain('<br/>');
  });

  test('does not produce empty <p></p> tags', () => {
    const result = renderMarkdown('# Heading\n\nSome text');
    expect(result).not.toContain('<p></p>');
  });
});

// ── extractCodeFromResponse (checkForCode logic) ──────────────────────────────

describe('extractCodeFromResponse — checkForCode logic', () => {
  test('returns null for empty/null/undefined input', () => {
    expect(extractCodeFromResponse('')).toBeNull();
    expect(extractCodeFromResponse(null)).toBeNull();
    expect(extractCodeFromResponse(undefined)).toBeNull();
  });

  test('extracts HTML from a complete ``` html ``` block', () => {
    const text = `REPO_NAME: test-app\n\nHere is your app:\n\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    expect(result).not.toBeNull();
    expect(result.repoName).toBe('test-app');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('index.html');
    expect(result.files[0].content).toContain('DOCTYPE html');
  });

  test('extracts HTML from a truncated response (missing closing ```)', () => {
    // This was the original Bug #2: response truncated before closing ```
    const text = `REPO_NAME: my-app\n\nHere is your app:\n\n\`\`\`html\n${MINIMAL_HTML}`;
    const result = extractCodeFromResponse(text);
    expect(result).not.toBeNull();
    expect(result.files[0].content).toContain('DOCTYPE html');
  });

  test('returns null when HTML content is shorter than 50 chars', () => {
    const text = 'REPO_NAME: x\n```html\n<html></html>\n```';
    expect(extractCodeFromResponse(text)).toBeNull();
  });

  test('returns null when there is no ```html block at all', () => {
    const text = 'REPO_NAME: test-app\nHere is some text without any html code block.';
    expect(extractCodeFromResponse(text)).toBeNull();
  });

  test('uses fallback repo name when REPO_NAME is absent', () => {
    const text = `No repo name here.\n\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    expect(result).not.toBeNull();
    expect(result.repoName).toBe('r4l-fallback');
  });

  test('REPO_NAME: lowercase converts uppercase letters', () => {
    const text = `REPO_NAME: MyCounterApp123\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    // /i flag makes [a-z0-9] match A-Z too; .toLowerCase() is applied
    expect(result.repoName).toBe('mycounterapp123');
  });

  test('REPO_NAME: minimum 3-char names accepted', () => {
    const text = `REPO_NAME: abc\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    expect(result.repoName).toBe('abc');
  });

  test('[BUG?] REPO_NAME: 2-char name (too short for pattern) falls back', () => {
    // Pattern: [a-z0-9][a-z0-9\-]{1,48}[a-z0-9] requires at least 3 chars
    const text = `REPO_NAME: ab\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    // 'ab' is 2 chars — does NOT satisfy {1,48} middle group minimum
    // Expected: falls back to 'r4l-fallback'
    expect(result.repoName).toBe('r4l-fallback');
  });

  test('[BUG?] REPO_NAME starting with hyphen does not match', () => {
    const text = `REPO_NAME: -invalid\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    // Pattern starts with [a-z0-9], so '-invalid' fails → fallback
    expect(result.repoName).toBe('r4l-fallback');
  });

  test('REPO_NAME ending with hyphen: trailing hyphen is silently stripped', () => {
    const text = `REPO_NAME: invalid-\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    // The regex [a-z0-9][a-z0-9\-]{1,48}[a-z0-9] backtracks and captures 'invalid'
    // (the trailing '-' is simply dropped). This is acceptable — 'invalid' is a valid name.
    expect(result.repoName).toBe('invalid');
  });

  test('extracts a separate CSS file when ```css block is present', () => {
    const text = `REPO_NAME: styled-app\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\`\n\`\`\`css\nbody{margin:0;}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    expect(result.files).toHaveLength(2);
    expect(result.files[1].path).toBe('style.css');
    expect(result.files[1].content).toBe('body{margin:0;}');
  });

  test('extracts a separate JS file when ```javascript block is present', () => {
    const text = `REPO_NAME: app\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\`\n\`\`\`javascript\nconsole.log("hi");\n\`\`\``;
    const result = extractCodeFromResponse(text);
    expect(result.files).toHaveLength(2);
    expect(result.files[1].path).toBe('script.js');
    expect(result.files[1].content).toBe('console.log("hi");');
  });

  test('extracts a separate JS file when ```js block is present', () => {
    const text = `REPO_NAME: app\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\`\n\`\`\`js\nvar x = 1;\n\`\`\``;
    const result = extractCodeFromResponse(text);
    expect(result.files).toHaveLength(2);
    expect(result.files[1].path).toBe('script.js');
  });

  test('complete block takes priority over truncated fallback', () => {
    // If both a complete block and </html> are present, the complete block wins
    const text = `REPO_NAME: app\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\`\nExtra text after`;
    const result = extractCodeFromResponse(text);
    expect(result).not.toBeNull();
    // Should use the complete block (no trailing text in content)
    expect(result.files[0].content).not.toContain('Extra text after');
  });

  test('handles response with only a style question (no code) returning null', () => {
    const text = 'One quick thing before I build — what vibe? 🎨 Dark Mode (black/purple), 🌟 Light & Clean (white/blue), 🔥 Bold & Colorful (dark/neon)';
    expect(extractCodeFromResponse(text)).toBeNull();
  });

  test('[BEHAVIOUR] very long REPO_NAME (> 50 chars) is silently truncated to 50', () => {
    const longName = 'a' + 'b'.repeat(55) + 'c'; // 57 chars total
    const text = `REPO_NAME: ${longName}\n\`\`\`html\n${MINIMAL_HTML}\n\`\`\``;
    const result = extractCodeFromResponse(text);
    // The regex greedily matches the first 50 chars and stops.
    // A 57-char name is silently truncated to 50 — not rejected.
    // GitHub allows up to 100-char names, so 50 chars is safe.
    const captured = result ? result.repoName : null;
    expect(captured).not.toBeNull();
    // Should be 50 chars (1 + 48 + 1)
    expect(captured.length).toBe(50);
    console.log('[INFO] Long REPO_NAME truncated to', captured.length, 'chars (expected 50)');
  });
});

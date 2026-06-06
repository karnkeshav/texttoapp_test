'use strict';
/**
 * Unit tests for the fullQualityPass changes in server/services/codeQuality.js
 *
 * Focus: the two new guards added to fix the "semantic repair hangs" bug:
 *   1. geminiStreamAvailable() — skips repair when all Gemini slots are cooling
 *   2. Promise.race timeout — aborts a stalled repair after REPAIR_TIMEOUT_MS
 *
 * Adversarial goals
 * ──────────────────────────────────────────────────────────────────────────────
 * • Verify repair is SKIPPED (not just slow) when Gemini is unavailable
 * • Verify timeout fires before pooledStream returns, not after
 * • Verify original text is returned on every abort path, not empty string
 * • Verify re-audit is NOT called when repair is skipped (no wasted quota)
 * • Verify re-audit IS called when repair succeeds
 * • Verify pooledGenerate failure in semanticAudit is non-fatal (PASS returned)
 * • Verify semanticRepair skips multi-file output without silently corrupting it
 * • Verify repair output < 200 chars falls back to original
 */

/* global describe, test, expect, vi, beforeEach, afterEach */
// describe/test/expect/vi are Vitest globals (globals:true in vitest.config.mjs)
// Do NOT require('vitest') — that fails in CJS mode.

// codeQuality.js uses `geminiPool.pooledGenerate` etc. (not destructured), so
// vi.spyOn(geminiPool, 'pooledGenerate') correctly intercepts every call.
const geminiPool = require('../../server/services/geminiPool');
const {
  semanticAudit,
  semanticRepair,
  fullQualityPass,
} = require('../../server/services/codeQuality');

// Convenience aliases — the actual spy is set up in beforeEach
let pooledGenerate, pooledStream, poolStatus;
beforeEach(() => {
  pooledGenerate = vi.spyOn(geminiPool, 'pooledGenerate');
  pooledStream   = vi.spyOn(geminiPool, 'pooledStream');
  poolStatus     = vi.spyOn(geminiPool, 'poolStatus');
});
afterEach(() => { vi.restoreAllMocks(); });

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_HTML = `REPO_NAME: test-app

\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Test</title></head>
<body><h1>Hello</h1></body>
</html>
\`\`\``;

const REPAIRED_HTML = `REPO_NAME: test-app

\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Fixed Test</title></head>
<body><h1>Hello (fixed)</h1></body>
</html>
\`\`\``;

const REQUIREMENTS = 'Build a simple hello world page with a heading.';
const API_KEY = 'fake-key';

/** poolStatus response: one build stream slot is free */
const poolStatusWithFreeSlot = () => [
  { slot: 1, sdk: 'new', model: 'gemini-2.5-flash', mode: 'stream',   tier: 'build', available: true,  dead: false, coolUntil: null },
  { slot: 3, sdk: 'new', model: 'gemini-2.5-flash', mode: 'stream',   tier: 'build', available: false, dead: false, coolUntil: '2026-06-05T22:00:00.000Z' },
  { slot: 5, sdk: 'new', model: 'gemini-3.5-flash', mode: 'generate', tier: 'build', available: true,  dead: false, coolUntil: null },
];

/** poolStatus response: all build stream slots are cooling */
const poolStatusAllCooling = () => [
  { slot: 1, sdk: 'new', model: 'gemini-2.5-flash', mode: 'stream', tier: 'build', available: false, dead: false, coolUntil: '2026-06-05T22:01:00.000Z' },
  { slot: 3, sdk: 'new', model: 'gemini-2.5-flash', mode: 'stream', tier: 'build', available: false, dead: false, coolUntil: '2026-06-05T22:01:00.000Z' },
  { slot: 5, sdk: 'new', model: 'gemini-3.5-flash', mode: 'stream', tier: 'build', available: false, dead: false, coolUntil: '2026-06-05T22:01:00.000Z' },
  { slot: 7, sdk: 'new', model: 'gemini-flash-latest', mode: 'stream', tier: 'build', available: false, dead: false, coolUntil: '2026-06-05T22:01:00.000Z' },
];

/** poolStatus response: all build stream slots are dead */
const poolStatusAllDead = () => [
  { slot: 1, mode: 'stream', tier: 'build', available: false, dead: true,  coolUntil: null },
  { slot: 3, mode: 'stream', tier: 'build', available: false, dead: true,  coolUntil: null },
];

// ── semanticAudit ─────────────────────────────────────────────────────────────

describe('semanticAudit', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('returns PASS when pooledGenerate responds with "PASS"', async () => {
    pooledGenerate.mockResolvedValueOnce('PASS');
    const result = await semanticAudit(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('returns PASS for case-insensitive "pass"', async () => {
    pooledGenerate.mockResolvedValueOnce('pass — the app looks good');
    const result = await semanticAudit(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result.passed).toBe(true);
  });

  test('returns FAIL with parsed issues when pooledGenerate returns FAIL list', async () => {
    pooledGenerate.mockResolvedValueOnce(
      'FAIL\n• Heading is missing\n• Contact form has no submit handler'
    );
    const result = await semanticAudit(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('Heading is missing');
    expect(result.issues).toContain('Contact form has no submit handler');
  });

  test('limits issues to max 5', async () => {
    const manyIssues = 'FAIL\n' + Array.from({ length: 10 }, (_, i) => `• Issue ${i + 1}`).join('\n');
    pooledGenerate.mockResolvedValueOnce(manyIssues);
    const result = await semanticAudit(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result.issues.length).toBeLessThanOrEqual(5);
  });

  test('is non-fatal — returns PASS when pooledGenerate throws', async () => {
    pooledGenerate.mockRejectedValueOnce(new Error('GEMINI_POOL_EXHAUSTED'));
    const result = await semanticAudit(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result.passed).toBe(true); // non-fatal: skip audit
    expect(result.issues).toHaveLength(0);
  });

  test('returns PASS early when requirements is empty string', async () => {
    const result = await semanticAudit(VALID_HTML, '', API_KEY);
    expect(result.passed).toBe(true);
    expect(pooledGenerate).not.toHaveBeenCalled();
  });

  test('returns PASS early when generatedText is empty string', async () => {
    const result = await semanticAudit('', REQUIREMENTS, API_KEY);
    expect(result.passed).toBe(true);
    expect(pooledGenerate).not.toHaveBeenCalled();
  });

  test('filters out very short issue lines (< 8 chars)', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• OK\n• A real issue that is long enough');
    const result = await semanticAudit(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result.issues).not.toContain('OK');
    expect(result.issues).toContain('A real issue that is long enough');
  });
});

// ── semanticRepair ────────────────────────────────────────────────────────────

describe('semanticRepair', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('returns repaired text when pooledStream succeeds', async () => {
    // Output must be >200 chars to pass the length guard in semanticRepair
    const body = '<p>Fixed!</p>' + 'x'.repeat(200);
    pooledStream.mockImplementationOnce(({ onDone }) => {
      onDone(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>T</title></head><body>${body}</body></html>`);
      return Promise.resolve();
    });
    const result = await semanticRepair(VALID_HTML, ['Missing heading'], REQUIREMENTS, API_KEY);
    expect(result).toContain('Fixed!');
  });

  test('returns original text when pooledStream throws', async () => {
    pooledStream.mockRejectedValueOnce(new Error('GEMINI_POOL_EXHAUSTED'));
    const result = await semanticRepair(VALID_HTML, ['issue'], REQUIREMENTS, API_KEY);
    expect(result).toBe(VALID_HTML);
  });

  test('returns original when repaired output is shorter than 200 chars', async () => {
    pooledStream.mockImplementationOnce(({ onDone }) => {
      onDone('<p>short</p>'); // < 200 chars
      return Promise.resolve();
    });
    const result = await semanticRepair(VALID_HTML, ['issue'], REQUIREMENTS, API_KEY);
    expect(result).toBe(VALID_HTML);
  });

  test('returns original unchanged for multi-file output (skips to preserve structure)', async () => {
    const multiFile = '```html\n<h1>page</h1>\n```\n\n```css\nbody{}\n```';
    const result = await semanticRepair(multiFile, ['issue'], REQUIREMENTS, API_KEY);
    expect(result).toBe(multiFile);
    expect(pooledStream).not.toHaveBeenCalled(); // no repair attempt
  });

  test('preserves REPO_NAME line in reconstructed output', async () => {
    pooledStream.mockImplementationOnce(({ onDone }) => {
      // Return 200+ chars of valid HTML (no fences)
      onDone('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>T</title></head><body>' + 'x'.repeat(200) + '</body></html>');
      return Promise.resolve();
    });
    const result = await semanticRepair(VALID_HTML, ['issue'], REQUIREMENTS, API_KEY);
    expect(result).toContain('REPO_NAME: test-app');
  });

  test('strips markdown fences from AI repair output (no double-fencing in body)', async () => {
    // semanticRepair wraps stripped HTML in ```html...``` once.
    // Verify: inner body has no nested ```html (i.e., fences were stripped before wrapping).
    const marker = 'UNIQUE_' + 'x'.repeat(200);
    pooledStream.mockImplementationOnce(({ onDone }) => {
      onDone(`\`\`\`html\n<!DOCTYPE html><html><head><meta charset="UTF-8"><title>T</title></head><body>${marker}</body></html>\n\`\`\``);
      return Promise.resolve();
    });
    const result = await semanticRepair(VALID_HTML, ['issue'], REQUIREMENTS, API_KEY);
    // The outer response wraps in ```html...``` — that is expected.
    // The inner body must NOT start with ```html again (no double fencing).
    const innerBody = result.replace(/^.*?```html\n/s, '').replace(/\n```\s*$/, '');
    expect(innerBody).not.toMatch(/^```html/);
    // And the marker (repaired content) must be present.
    expect(result).toContain(marker);
  });
});

// ── fullQualityPass ───────────────────────────────────────────────────────────

describe('fullQualityPass — audit passes immediately', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('returns original text without calling pooledStream when audit passes', async () => {
    pooledGenerate.mockResolvedValueOnce('PASS');
    poolStatus.mockReturnValue(poolStatusWithFreeSlot());
    const result = await fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result).toBe(VALID_HTML);
    expect(pooledStream).not.toHaveBeenCalled();
  });
});

describe('fullQualityPass — Gemini slots all cooling → skip repair', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('skips repair and returns original when no free stream slots', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• A critical issue');
    poolStatus.mockReturnValue(poolStatusAllCooling());
    const result = await fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result).toBe(VALID_HTML); // original returned
    expect(pooledStream).not.toHaveBeenCalled(); // no repair attempt
  });

  test('skips repair when all slots are dead', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• A verifiable issue detected here');
    poolStatus.mockReturnValue(poolStatusAllDead());
    const result = await fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result).toBe(VALID_HTML);
    expect(pooledStream).not.toHaveBeenCalled();
  });

  test('skips repair when poolStatus() throws', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• A verifiable issue detected here');
    poolStatus.mockImplementationOnce(() => { throw new Error('pool status unavailable'); });
    const result = await fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result).toBe(VALID_HTML);
    expect(pooledStream).not.toHaveBeenCalled();
  });

  test('does NOT call re-audit when repair is skipped (no wasted quota)', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• A verifiable issue detected here');
    poolStatus.mockReturnValue(poolStatusAllCooling());
    await fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    // pooledGenerate called once (audit) — NOT a second time (re-audit)
    expect(pooledGenerate).toHaveBeenCalledTimes(1);
  });
});

describe('fullQualityPass — Gemini available, repair succeeds', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('returns repaired text when repair succeeds', async () => {
    // Step 1: audit fails
    pooledGenerate.mockResolvedValueOnce('FAIL\n• Missing contact form');
    poolStatus.mockReturnValue(poolStatusWithFreeSlot());
    // Step 2: repair
    pooledStream.mockImplementationOnce(({ onDone }) => {
      onDone('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Fixed</title></head><body>' + 'x'.repeat(200) + '</body></html>');
      return Promise.resolve();
    });
    // Step 3: re-audit passes
    pooledGenerate.mockResolvedValueOnce('PASS');

    const result = await fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    expect(result).not.toBe(VALID_HTML); // repaired text returned
    expect(pooledGenerate).toHaveBeenCalledTimes(2); // audit + re-audit
    expect(pooledStream).toHaveBeenCalledTimes(1);   // one repair
  });

  test('returns repaired text even when re-audit fails (best-effort)', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• A verifiable issue detected here');
    poolStatus.mockReturnValue(poolStatusWithFreeSlot());
    pooledStream.mockImplementationOnce(({ onDone }) => {
      onDone('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>R</title></head><body>' + 'y'.repeat(200) + '</body></html>');
      return Promise.resolve();
    });
    pooledGenerate.mockResolvedValueOnce('FAIL\n• Still a verifiable issue here'); // re-audit still fails

    const result = await fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    // Should return the repaired text regardless
    expect(result).not.toBe(VALID_HTML);
  });
});

describe('fullQualityPass — repair timeout', () => {
  // vi.advanceTimersByTimeAsync flushes both timers AND pending microtasks,
  // which is required for the async Promise.race in fullQualityPass to settle.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('returns original text when repair exceeds timeout', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• A verifiable issue detected here');
    poolStatus.mockReturnValue(poolStatusWithFreeSlot());
    pooledStream.mockImplementationOnce(() => new Promise(() => {})); // never resolves

    const promise = fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    await vi.advanceTimersByTimeAsync(56_000); // async form flushes microtasks too
    const result = await promise;
    expect(result).toBe(VALID_HTML);
  }, 15_000);

  test('re-audit is NOT called after timeout (no wasted quota)', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• A verifiable issue detected here');
    poolStatus.mockReturnValue(poolStatusWithFreeSlot());
    pooledStream.mockImplementationOnce(() => new Promise(() => {}));

    const promise = fullQualityPass(VALID_HTML, REQUIREMENTS, API_KEY);
    await vi.advanceTimersByTimeAsync(56_000);
    await promise;
    // pooledGenerate called exactly once (audit) — NOT twice (no re-audit after timeout)
    expect(pooledGenerate).toHaveBeenCalledTimes(1);
  }, 15_000);
});

// ── Regression: original behaviour preserved ──────────────────────────────────

describe('fullQualityPass — regression (existing behaviour unchanged)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('passes enrichedNotes to semanticAudit prompt (requirements slice visible)', async () => {
    pooledGenerate.mockResolvedValueOnce('PASS');
    poolStatus.mockReturnValue(poolStatusWithFreeSlot());
    await fullQualityPass(VALID_HTML, 'my specific requirement text here', API_KEY);
    const auditPrompt = pooledGenerate.mock.calls[0][0].contents[0].parts[0].text;
    expect(auditPrompt).toContain('my specific requirement text here');
  });

  test('passes apiKey to all pool calls', async () => {
    pooledGenerate.mockResolvedValueOnce('FAIL\n• issue one here please');
    poolStatus.mockReturnValue(poolStatusWithFreeSlot());
    pooledStream.mockImplementationOnce(({ onDone }) => {
      onDone('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>T</title></head><body>' + 'z'.repeat(200) + '</body></html>');
      return Promise.resolve();
    });
    pooledGenerate.mockResolvedValueOnce('PASS');
    await fullQualityPass(VALID_HTML, REQUIREMENTS, 'my-api-key-value');
    for (const call of pooledGenerate.mock.calls) {
      expect(call[0].apiKey).toBe('my-api-key-value');
    }
  });
});

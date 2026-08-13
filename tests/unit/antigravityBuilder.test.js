import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import {
  buildWithAntigravity,
  verifyProject,
  extractFilesFromText,
  classifyAntigravityError
} from '../../server/services/antigravityBuilder.js';

const require = createRequire(import.meta.url);
const axios = require('axios');

describe('Building App Module — Antigravity Execution Engine', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractFilesFromText', () => {
    it('extracts files correctly from markdown code blocks with FILE headers', () => {
      const text = `
REPO_NAME: test-app

\`\`\`html
<!-- FILE: index.html -->
<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body><h1>Hello World</h1></body>
</html>
\`\`\`

\`\`\`javascript
// FILE: server.js
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT);
\`\`\`
      `;

      const files = extractFilesFromText(text);
      expect(files).toHaveLength(2);
      expect(files[0].path).toBe('index.html');
      expect(files[0].content).toContain('<h1>Hello World</h1>');
      expect(files[1].path).toBe('server.js');
      expect(files[1].content).toContain('process.env.PORT');
    });
  });

  describe('verifyProject', () => {
    it('verifies valid static app files', () => {
      const files = [
        {
          path: 'index.html',
          content: '<!DOCTYPE html><html><head><title>Test App</title></head><body><div id="app">Hello</div></body></html>'
        }
      ];
      const stack = { frontend: 'html', backend: 'none', type: 'static' };
      const res = verifyProject(files, stack);
      expect(res.passed).toBe(true);
    });

    it('flags missing package.json for nodejs backend', () => {
      const files = [
        {
          path: 'server.js',
          content: 'const express = require("express");'
        }
      ];
      const stack = { frontend: 'html', backend: 'nodejs', type: 'spa' };
      const res = verifyProject(files, stack);
      expect(res.passed).toBe(false);
      expect(res.issues.some(i => i.includes('package.json'))).toBe(true);
    });

    it('flags unclosed HTML tags', () => {
      const files = [
        {
          path: 'index.html',
          content: '<!DOCTYPE html><html><head><title>Test App</title></head><body><div>Unclosed div</body></html>'
        }
      ];
      const stack = { frontend: 'html', backend: 'none', type: 'static' };
      const res = verifyProject(files, stack);
      expect(res.passed).toBe(false);
      expect(res.issues.some(i => i.includes('div'))).toBe(true);
    });

    it('flags placeholder Lorem Ipsum text', () => {
      const files = [
        {
          path: 'index.html',
          content: '<!DOCTYPE html><html><head><title>Test App</title></head><body><p>Lorem ipsum dolor sit amet</p></body></html>'
        }
      ];
      const stack = { frontend: 'html', backend: 'none', type: 'static' };
      const res = verifyProject(files, stack);
      expect(res.passed).toBe(false);
      expect(res.issues.some(i => i.includes('Lorem Ipsum'))).toBe(true);
    });
  });

  describe('classifyAntigravityError', () => {
    it('classifies 401/403 as API_KEY_INVALID', () => {
      const err = { response: { status: 401, data: { error: { message: 'API key not valid' } } } };
      const res = classifyAntigravityError(err);
      expect(res.code).toBe('API_KEY_INVALID');
    });

    it('classifies 404 as MODEL_UNAVAILABLE', () => {
      const err = { response: { status: 404, data: { error: { message: 'Agent model not found' } } } };
      const res = classifyAntigravityError(err);
      expect(res.code).toBe('MODEL_UNAVAILABLE');
    });

    it('classifies 429 as RATE_LIMITED', () => {
      const err = { response: { status: 429, data: { error: { message: 'Quota exceeded' } } } };
      const res = classifyAntigravityError(err);
      expect(res.code).toBe('RATE_LIMITED');
    });

    it('classifies generic errors as BUILD_FAILED', () => {
      const err = { message: 'Connection reset' };
      const res = classifyAntigravityError(err);
      expect(res.code).toBe('BUILD_FAILED');
    });
  });

  describe('buildWithAntigravity', () => {
    it('executes successful build workflow and returns verified project result', async () => {
      const validOutput = `
REPO_NAME: sample-verified-app

\`\`\`html
<!-- FILE: index.html -->
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Verified App</title></head>
<body>
  <div id="root"><h1>Verified App</h1></div>
</body>
</html>
\`\`\`
      `;

      const spy = vi.spyOn(axios, 'post').mockResolvedValue({
        data: {
          id: 'interaction-12345',
          environment_id: 'env-67890',
          output: validOutput,
          status: 'completed',
          usage: { total_tokens: 500 }
        }
      });

      const statesEmitted = [];
      const onProgress = (state) => statesEmitted.push(state);

      const stack = { frontend: 'html', backend: 'none', type: 'static' };
      const result = await buildWithAntigravity('Build a simple verified landing page', stack, 'valid-api-key', { onProgress });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('https://generativelanguage.googleapis.com/v1beta/interactions?key=valid-api-key');
      expect(spy.mock.calls[0][1].environment).toEqual({ type: 'remote' });
      expect(spy.mock.calls[0][1].agent).toBe('antigravity-preview-05-2026');

      expect(result.repoName).toBe('sample-verified-app');
      expect(result.buildStatus).toBe('VERIFIED');
      expect(result.repairCount).toBe(0);
      expect(result.interactionId).toBe('interaction-12345');
      expect(result.environmentId).toBe('env-67890');
      expect(statesEmitted).toContain('PREPARING');
      expect(statesEmitted).toContain('BUILDING');
      expect(statesEmitted).toContain('TESTING');
      expect(statesEmitted).toContain('VERIFYING');
      expect(statesEmitted).toContain('COMPLETED');
    });

    it('triggers self-repair loop when initial build fails verification', async () => {
      const brokenOutput = `
REPO_NAME: repair-test-app

\`\`\`html
<!-- FILE: index.html -->
<!DOCTYPE html>
<html>
<head><title>Broken App</title></head>
<body>
  <div>Unclosed div tag
</body>
</html>
\`\`\`
      `;

      const fixedOutput = `
REPO_NAME: repair-test-app

\`\`\`html
<!-- FILE: index.html -->
<!DOCTYPE html>
<html>
<head><title>Fixed App</title></head>
<body>
  <div>Fixed div tag</div>
</body>
</html>
\`\`\`
      `;

      const spy = vi.spyOn(axios, 'post')
        .mockResolvedValueOnce({
          data: {
            id: 'interaction-1',
            output: brokenOutput,
            status: 'completed'
          }
        })
        .mockResolvedValueOnce({
          data: {
            id: 'interaction-2',
            output: fixedOutput,
            status: 'completed'
          }
        });

      const statesEmitted = [];
      const onProgress = (state) => statesEmitted.push(state);

      const stack = { frontend: 'html', backend: 'none', type: 'static' };
      const result = await buildWithAntigravity('Build landing page', stack, 'valid-api-key', { onProgress, maxRepairAttempts: 2 });

      expect(spy).toHaveBeenCalledTimes(2);
      expect(result.repairCount).toBe(1);
      expect(result.buildStatus).toBe('VERIFIED');
      expect(statesEmitted).toContain('DIAGNOSING');
      expect(statesEmitted).toContain('REPAIRING');
      expect(statesEmitted).toContain('REBUILDING');
    });

    it('preserves explicit technology decisions in request prompt', async () => {
      const validReactNodeOutput = [
        'REPO_NAME: react-node-app',
        '',
        '```json',
        '<!-- FILE: package.json -->',
        '{',
        '  "name": "app",',
        '  "version": "1.0.0",',
        '  "main": "server.js",',
        '  "scripts": { "start": "node server.js" },',
        '  "dependencies": { "express": "^4.18.2", "react": "^18.2.0" }',
        '}',
        '```',
        '',
        '```javascript',
        '// FILE: server.js',
        'const express = require("express");',
        'const app = express();',
        'const PORT = process.env.PORT || 3000;',
        'app.use(express.static("public"));',
        'app.listen(PORT);',
        '```',
        '',
        '```html',
        '<!-- FILE: public/index.html -->',
        '<!DOCTYPE html>',
        '<html>',
        '<head><title>React App</title></head>',
        '<body><div id="root"></div></body>',
        '</html>',
        '```'
      ].join('\n');

      const spy = vi.spyOn(axios, 'post').mockResolvedValue({
        data: {
          id: 'int-tech-1',
          output: validReactNodeOutput
        }
      });

      const stack = { frontend: 'react', backend: 'nodejs', type: 'spa' };
      const result = await buildWithAntigravity('Build dashboard app', stack, 'valid-api-key');

      const sentPrompt = spy.mock.calls[0][1].input;
      expect(sentPrompt).toContain('Frontend: react');
      expect(sentPrompt).toContain('Backend: nodejs');
      expect(result.repoName).toBe('react-node-app');
      expect(result.buildStatus).toBe('VERIFIED');
    });

    it('returns ARTIFACT_RETRIEVAL_FAILED hard failure when zero code files are extracted', async () => {
      const zeroFileOutput = `
Antigravity completed interaction but output contains no code blocks.
REPO_NAME: empty-app
`;

      vi.spyOn(axios, 'post').mockResolvedValue({
        data: {
          id: 'interaction-empty',
          output: zeroFileOutput,
          status: 'completed'
        }
      });

      const statesEmitted = [];
      const onProgress = (state) => statesEmitted.push(state);

      const stack = { frontend: 'html', backend: 'none', type: 'static' };
      const result = await buildWithAntigravity('Build empty app', stack, 'valid-api-key', { onProgress });

      expect(result.files).toHaveLength(0);
      expect(result.buildStatus).toBe('ARTIFACT_RETRIEVAL_FAILED');
      expect(result.verification.passed).toBe(false);
      expect(statesEmitted).toContain('BUILD_FAILED');
      expect(statesEmitted).not.toContain('COMPLETED');
    });

    it('retains initial valid files when self-repair encounters 429 rate limit', async () => {
      const initialOutputWithMinorIssue = `
REPO_NAME: rate-limit-test-app

\`\`\`html
<!-- FILE: index.html -->
<!DOCTYPE html>
<html>
<head><title>App</title></head>
<body>
  <div>Unclosed div
</body>
</html>
\`\`\`
      `;

      vi.spyOn(axios, 'post')
        .mockResolvedValueOnce({
          data: {
            id: 'interaction-1',
            output: initialOutputWithMinorIssue,
            status: 'completed'
          }
        })
        .mockRejectedValueOnce({
          response: { status: 429, data: { error: { message: 'Rate limit exceeded' } } },
          code: 'RATE_LIMITED'
        });

      const stack = { frontend: 'html', backend: 'none', type: 'static' };
      const result = await buildWithAntigravity('Build app', stack, 'valid-api-key', { maxRepairAttempts: 2 });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe('index.html');
      expect(result.buildStatus).toBe('REPAIR_BLOCKED');
    });
  });
});

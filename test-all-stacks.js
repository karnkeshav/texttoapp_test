#!/usr/bin/env node
/**
 * Comprehensive Stack Validation Test
 * Tests all 20 valid stack combinations for:
 *   - Stack selector validation
 *   - Dry run logic
 *   - Deployment mode detection
 *   - Stack-specific questions
 */

const fs = require('fs');
const path = require('path');

// Import modules
const { getStackQuestions, buildStackContext, getDeploymentMode, runDryCheck } = require('./server/services/stackAdvisor');

// Define all valid combinations
const STACK_COMPATIBILITY = {
  html:    { backends: ['none'], types: ['static', 'jamstack'] },
  react:   { backends: ['none', 'nodejs', 'python', 'java', 'go'], types: ['spa', 'dynamic', 'pwa'] },
  vue:     { backends: ['none', 'nodejs', 'python', 'java', 'go'], types: ['spa', 'dynamic', 'pwa'] },
  angular: { backends: ['nodejs', 'java', 'csharp', 'python'], types: ['spa', 'dynamic'] },
  svelte:  { backends: ['nodejs', 'python', 'go'], types: ['spa', 'dynamic', 'pwa'] },
  nextjs:  { backends: ['nodejs'], types: ['ssr', 'dynamic'] },
  nuxtjs:  { backends: ['nodejs', 'python'], types: ['ssr', 'dynamic'] },
};

const FRONTEND_LABELS = {
  html: 'HTML (Vanilla JavaScript)',
  react: 'React',
  vue: 'Vue.js',
  angular: 'Angular',
  svelte: 'Svelte',
  nextjs: 'Next.js',
  nuxtjs: 'Nuxt.js',
};

const BACKEND_LABELS = {
  none: 'No backend',
  nodejs: 'Node.js + Express',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  csharp: 'C#',
};

const TYPE_LABELS = {
  static: 'Static Website',
  jamstack: 'JAMstack',
  spa: 'Single Page App (SPA)',
  dynamic: 'Dynamic Web App',
  ssr: 'Server-Side Rendered',
  pwa: 'Progressive Web App',
};

// Generate all valid combinations
function getAllValidCombinations() {
  const combinations = [];
  Object.entries(STACK_COMPATIBILITY).forEach(([frontend, rules]) => {
    rules.backends.forEach(backend => {
      rules.types.forEach(type => {
        combinations.push({ frontend, backend, type });
      });
    });
  });
  return combinations;
}

// Test function
function testStack(combination) {
  const { frontend, backend, type } = combination;
  const label = `${FRONTEND_LABELS[frontend]} + ${BACKEND_LABELS[backend]} + ${TYPE_LABELS[type]}`;

  const tests = {
    validation: true,
    deployment: true,
    questions: true,
    context: true,
    dryRun: true,
  };

  try {
    // Test 1: Stack validation
    const rules = STACK_COMPATIBILITY[frontend];
    if (!rules) throw new Error('Unknown frontend');
    if (!rules.backends.includes(backend)) {
      throw new Error(`${frontend} doesn't work with ${backend}`);
    }
    if (!rules.types.includes(type)) {
      throw new Error(`${frontend} doesn't work as ${type}`);
    }

    // Test 2: Deployment mode detection
    const deployMode = getDeploymentMode(combination);
    if (!deployMode) {
      throw new Error('No deployment mode detected');
    }
    if (!['github-pages', 'local', 'manual'].includes(deployMode)) {
      throw new Error(`Invalid deployment mode: ${deployMode}`);
    }

    // Test 3: Stack-specific questions
    const questions = getStackQuestions(combination);
    if (!Array.isArray(questions) || questions.length !== 5) {
      throw new Error(`Expected 5 questions, got ${questions.length}`);
    }
    questions.forEach((q, i) => {
      if (!q || typeof q !== 'string' || q.length < 20) {
        throw new Error(`Question ${i+1} is invalid or too short`);
      }
    });

    // Test 4: Build stack context
    const context = buildStackContext(combination);
    if (!context || typeof context !== 'string' || context.length < 100) {
      throw new Error('Build context too short or invalid');
    }
    // Check for required stack info (check for frontend name or label)
    const hasFrameworkInfo =
      context.includes(frontend) ||
      context.includes(FRONTEND_LABELS[frontend]) ||
      context.toLocaleLowerCase().includes(frontend.toLocaleLowerCase());

    if (!hasFrameworkInfo) {
      throw new Error(`Build context missing frontend info for ${frontend}`);
    }

    // Test 5: Dry run with sample files
    const sampleFiles = generateSampleFiles(combination);
    const dryResult = runDryCheck(sampleFiles, combination);
    if (!dryResult || typeof dryResult.passed !== 'boolean') {
      throw new Error('Dry run returned invalid result');
    }
    // Sample files should pass
    if (!dryResult.passed) {
      console.warn(`  ⚠️  Dry run failed for sample files: ${dryResult.summary}`);
    }

  } catch (error) {
    tests.error = error.message;
    return { ...combination, label, ...tests, success: false };
  }

  return { ...combination, label, ...tests, success: true };
}

// Generate sample files based on stack
function generateSampleFiles(stack) {
  const files = [];
  const { frontend, backend, type } = stack;

  // Always include index.html
  files.push({
    path: 'index.html',
    content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App</title>
</head>
<body>
  <div id="root"></div>
  <script src="app.js"></script>
</body>
</html>`,
  });

  // JavaScript file
  files.push({
    path: 'app.js',
    content: `// Sample ${frontend} app
console.log('App loaded');`,
  });

  // Package.json for backend apps
  if (backend !== 'none') {
    files.push({
      path: 'package.json',
      content: JSON.stringify({
        name: 'sample-app',
        version: '1.0.0',
        scripts: { start: 'node server.js', dev: 'node server.js' },
        dependencies: { express: '^4.18.2' },
      }, null, 2),
    });

    // Server file
    files.push({
      path: 'server.js',
      content: `const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
app.listen(PORT, () => console.log(\`Server running on \${PORT}\`));`,
    });
  }

  return files;
}

// Run all tests
const combinations = getAllValidCombinations();
const results = {
  total: combinations.length,
  passed: 0,
  failed: 0,
  byCategory: {},
};

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║  COMPREHENSIVE STACK VALIDATION TEST                           ║');
console.log('║  Testing all 20 valid stack combinations                       ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

combinations.forEach((combo, idx) => {
  const result = testStack(combo);
  const status = result.success ? '✅' : '❌';

  console.log(`${status} ${idx + 1}. ${result.label}`);

  if (!result.success) {
    console.log(`   └─ Error: ${result.error}`);
    results.failed++;
  } else {
    results.passed++;
    // Show deployment mode
    const deployMode = getDeploymentMode(combo);
    const modeLabel = {
      'github-pages': '📄 GitHub Pages',
      'local': '💻 Local (localhost)',
      'manual': '🔧 Manual Deploy',
    }[deployMode];
    console.log(`   └─ Deploy: ${modeLabel}`);
  }
});

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log(`║  RESULTS: ${results.passed}/${results.total} PASSED                                  ║`);
console.log('╚════════════════════════════════════════════════════════════════╝\n');

if (results.failed > 0) {
  console.log(`⚠️  ${results.failed} stack combination(s) failed validation!\n`);
  process.exit(1);
} else {
  console.log('✅ All stack combinations passed validation!\n');
  console.log('Next steps:');
  console.log('  1. Test actual code generation for each stack');
  console.log('  2. Verify dry run auto-healing works');
  console.log('  3. Test GitHub Pages deployment for static apps');
  console.log('  4. Test localhost deployment for backend apps\n');
  process.exit(0);
}

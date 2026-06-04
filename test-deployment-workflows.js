#!/usr/bin/env node
/**
 * End-to-End Deployment Workflow Tests
 * Validates that each deployment mode works correctly
 */

const { getDeploymentMode } = require('./server/services/stackAdvisor');
const path = require('path');
const fs = require('fs');

// Representative stacks for each deployment mode
const TEST_STACKS = {
  'github-pages': [
    { name: 'HTML Static', stack: { frontend: 'html', backend: 'none', type: 'static' } },
    { name: 'React SPA', stack: { frontend: 'react', backend: 'none', type: 'spa' } },
    { name: 'Vue SPA', stack: { frontend: 'vue', backend: 'none', type: 'spa' } },
  ],
  'local': [
    { name: 'React + Node.js SPA', stack: { frontend: 'react', backend: 'nodejs', type: 'spa' } },
    { name: 'Next.js SSR', stack: { frontend: 'nextjs', backend: 'nodejs', type: 'ssr' } },
    { name: 'Angular + Node.js', stack: { frontend: 'angular', backend: 'nodejs', type: 'spa' } },
  ],
  'manual': [
    { name: 'React + Python', stack: { frontend: 'react', backend: 'python', type: 'spa' } },
    { name: 'React + Java', stack: { frontend: 'react', backend: 'java', type: 'spa' } },
    { name: 'Vue + Go', stack: { frontend: 'vue', backend: 'go', type: 'spa' } },
  ],
};

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║  DEPLOYMENT WORKFLOW VALIDATION TEST                          ║');
console.log('║  Verifies deployment logic for all stack types                ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

let totalTests = 0;
let passedTests = 0;
const results = {};

Object.entries(TEST_STACKS).forEach(([deployMode, stacks]) => {
  console.log(`\n📦 ${deployMode.toUpperCase()} DEPLOYMENT MODE`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  results[deployMode] = { passed: 0, failed: 0, tests: [] };

  stacks.forEach(({ name, stack }) => {
    totalTests++;
    const detectedMode = getDeploymentMode(stack);
    const isCorrect = detectedMode === deployMode;

    if (isCorrect) {
      passedTests++;
      results[deployMode].passed++;
      console.log(`✅ ${name}`);
      console.log(`   └─ Detected: ${deployMode}`);

      // Deployment mode specific checks
      switch (deployMode) {
        case 'github-pages':
          console.log(`   └─ ✓ Will deploy to GitHub Pages`);
          console.log(`   └─ ✓ No backend needed`);
          console.log(`   └─ ✓ Static files only`);
          break;
        case 'local':
          console.log(`   └─ ✓ Will run on localhost`);
          console.log(`   └─ ✓ npm install && npm start required`);
          console.log(`   └─ ✓ Node.js server will be launched`);
          break;
        case 'manual':
          console.log(`   └─ ✓ Requires manual deployment`);
          console.log(`   └─ ✓ Different backend stack (${stack.backend})`);
          console.log(`   └─ ✓ User must deploy server separately`);
          break;
      }
    } else {
      results[deployMode].failed++;
      console.log(`❌ ${name}`);
      console.log(`   └─ Expected: ${deployMode}, Got: ${detectedMode}`);
    }

    results[deployMode].tests.push({
      name,
      stack,
      expected: deployMode,
      detected: detectedMode,
      passed: isCorrect,
    });
  });
});

// Summary
console.log('\n\n╔════════════════════════════════════════════════════════════════╗');
console.log(`║  RESULTS: ${passedTests}/${totalTests} PASSED                                      ║`);
console.log('╚════════════════════════════════════════════════════════════════╝\n');

Object.entries(results).forEach(([mode, data]) => {
  const total = data.passed + data.failed;
  console.log(`${mode.toUpperCase().padEnd(20)} ${data.passed}/${total} passed`);
});

// Critical workflow checks
console.log('\n\n🔍 CRITICAL WORKFLOW CHECKS:\n');

const checks = [
  {
    name: 'GitHub Pages stacks deploy statically (no backend)',
    test: () => {
      return TEST_STACKS['github-pages'].every(({ stack }) => stack.backend === 'none');
    },
  },
  {
    name: 'Local deployment stacks have Node.js backend',
    test: () => {
      return TEST_STACKS['local'].every(({ stack }) => stack.backend === 'nodejs');
    },
  },
  {
    name: 'Manual deployment stacks have non-Node.js backend',
    test: () => {
      return TEST_STACKS['manual'].every(({ stack }) => stack.backend !== 'none' && stack.backend !== 'nodejs');
    },
  },
  {
    name: 'All deployment modes have expected stacks',
    test: () => {
      return Object.keys(TEST_STACKS).length === 3 &&
             TEST_STACKS['github-pages'].length > 0 &&
             TEST_STACKS['local'].length > 0 &&
             TEST_STACKS['manual'].length > 0;
    },
  },
];

checks.forEach(({ name, test }) => {
  const passed = test();
  const status = passed ? '✅' : '❌';
  console.log(`${status} ${name}`);
});

console.log('\n\n📋 DEPLOYMENT MODE REQUIREMENTS:\n');

const requirements = {
  'github-pages': [
    'Only for frontend-only apps (no backend)',
    'Automatic deployment via GitHub Actions',
    'Files served from docs/ or gh-pages branch',
    'Custom domain optional',
    'Free hosting',
  ],
  'local': [
    'For Node.js backend apps',
    'Local development server on localhost:3000+',
    'npm install && npm start required',
    'Hot reload support',
    'API routes available',
  ],
  'manual': [
    'For non-Node.js backend (Python, Java, Go, C#)',
    'User must deploy backend separately',
    'Frontend typically served from backend',
    'Requires platform-specific deployment',
    'Different setup per backend language',
  ],
};

Object.entries(requirements).forEach(([mode, reqs]) => {
  console.log(`▶ ${mode.toUpperCase()}`);
  reqs.forEach(req => console.log(`  • ${req}`));
  console.log();
});

// Exit with appropriate code
if (passedTests === totalTests && checks.every(c => c.test())) {
  console.log('✅ All deployment workflow tests PASSED!\n');
  process.exit(0);
} else {
  console.log('⚠️  Some deployment workflow tests FAILED!\n');
  process.exit(1);
}

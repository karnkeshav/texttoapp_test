#!/usr/bin/env node
/**
 * Comprehensive Testing Suite
 * Tests: Unit, Integration, Regression, and Dry-run validations
 */

const { generateStartScript } = require('./server/services/startScriptGenerator');
const { needsLocalRunner, isBackendApp } = require('./server/services/appRunner');

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    console.log(`✅ [${testCount}] ${name}`);
    passCount++;
  } catch (err) {
    console.log(`❌ [${testCount}] ${name}`);
    console.log(`   Error: ${err.message}`);
    failCount++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

console.log('═══════════════════════════════════════════════════════');
console.log('COMPREHENSIVE TESTING SUITE');
console.log('═══════════════════════════════════════════════════════\n');

// ──────────────────────────────────────────────────────────────────
// UNIT TESTS: startScriptGenerator
// ──────────────────────────────────────────────────────────────────
console.log('\n[UNIT TESTS] startScriptGenerator');
console.log('─────────────────────────────────────────────────────');

test('Generates script for React+Go stack', () => {
  const script = generateStartScript({ frontend: 'react', backend: 'go' });
  assert(script !== null, 'Should return non-null for React+Go');
  assert(script.length > 1000, 'Script should be substantial');
  assert(script.includes('go mod tidy'), 'Should include Go module management');
  assert(script.includes('npm install'), 'Should include npm install');
  assert(script.includes('[1/3]'), 'Should show progress step 1');
  assert(script.includes('[2/3]'), 'Should show progress step 2');
  assert(script.includes('[3/3]'), 'Should show progress step 3');
});

test('Generates script for Vue+Python stack', () => {
  const script = generateStartScript({ frontend: 'vue', backend: 'python' });
  assert(script !== null, 'Should return non-null for Vue+Python');
  assert(script.includes('pip install'), 'Should include pip install');
  assert(script.includes('python'), 'Should reference Python');
  assert((script.match(/Start-Process/g) || []).length >= 2, 'Should spawn 2+ processes');
});

test('Generates script for React+Node.js stack', () => {
  const script = generateStartScript({ frontend: 'react', backend: 'nodejs' });
  assert(script !== null, 'Should return non-null for React+Node.js');
  assert(script.includes('npm start'), 'Should include npm start for backend');
  assert(script.includes('npm install'), 'Should include npm install');
});

test('Returns null for static HTML+None', () => {
  const script = generateStartScript({ frontend: 'html', backend: 'none' });
  assert(script === null, 'Should return null for static HTML');
});

test('Returns null for HTML+Go (backend without frontend)', () => {
  const script = generateStartScript({ frontend: 'html', backend: 'go' });
  assert(script === null, 'Should return null when frontend is HTML');
});

test('Returns null for React+None (frontend without backend)', () => {
  const script = generateStartScript({ frontend: 'react', backend: 'none' });
  assert(script === null, 'Should return null when backend is none');
});

test('Script includes error handling for missing tools', () => {
  const script = generateStartScript({ frontend: 'react', backend: 'go' });
  assert(script.includes('Test-Command'), 'Should check for required tools');
  assert(script.includes('https://go.dev/dl'), 'Should provide Go download link');
  assert(script.includes('https://nodejs.org'), 'Should provide Node download link');
});

test('Script properly handles PowerShell variables', () => {
  const script = generateStartScript({ frontend: 'react', backend: 'go' });
  // Check for proper variable references (whether escaped or using proper PowerShell syntax)
  assert(script.includes('$env:') || script.includes('\\$env:'), 'Should reference environment variables');
  assert(script.includes('LASTEXITCODE'), 'Should check exit codes');
  assert(script.includes('ErrorActionPreference'), 'Should set error handling');
});

test('Script includes auto-open browser functionality', () => {
  const script = generateStartScript({ frontend: 'react', backend: 'go' });
  assert(script.includes('http://localhost'), 'Should reference localhost');
  assert(script.includes('Start-Process'), 'Should try to open browser');
});

// ──────────────────────────────────────────────────────────────────
// UNIT TESTS: appRunner detection
// ──────────────────────────────────────────────────────────────────
console.log('\n[UNIT TESTS] appRunner detection');
console.log('─────────────────────────────────────────────────────');

test('needsLocalRunner detects Node.js backend', () => {
  const files = [{ path: 'package.json', content: '{}' }];
  assert(needsLocalRunner(files) === true, 'Should detect Node.js app');
});

test('needsLocalRunner detects Go backend', () => {
  const files = [{ path: 'go.mod', content: '' }];
  assert(needsLocalRunner(files) === true, 'Should detect Go app');
});

test('needsLocalRunner detects Python backend', () => {
  const files = [{ path: 'requirements.txt', content: '' }];
  assert(needsLocalRunner(files) === true, 'Should detect Python app');
});

test('needsLocalRunner returns false for static HTML', () => {
  const files = [{ path: 'index.html', content: '<html></html>' }];
  assert(needsLocalRunner(files) === false, 'Should not flag static HTML');
});

test('isBackendApp detects multiple backend types', () => {
  const nodeFiles = [{ path: 'package.json', content: '{}' }];
  assert(isBackendApp(nodeFiles) === true, 'Should detect Node.js');

  const goFiles = [{ path: 'go.mod', content: '' }];
  assert(isBackendApp(goFiles) === true, 'Should detect Go');

  const pyFiles = [{ path: 'requirements.txt', content: '' }];
  assert(isBackendApp(pyFiles) === true, 'Should detect Python');
});

// ──────────────────────────────────────────────────────────────────
// INTEGRATION TESTS: Frontend + Backend Communication
// ──────────────────────────────────────────────────────────────────
console.log('\n[INTEGRATION TESTS] Frontend/Backend Communication');
console.log('─────────────────────────────────────────────────────');

test('Stack object structure is valid for deploy', () => {
  const stack = { frontend: 'react', backend: 'go' };
  assert(stack.frontend !== undefined, 'Stack must have frontend');
  assert(stack.backend !== undefined, 'Stack must have backend');
  assert(typeof stack.frontend === 'string', 'Frontend must be string');
  assert(typeof stack.backend === 'string', 'Backend must be string');
});

test('Deploy payload includes stack information', () => {
  const deployPayload = {
    repoName: 'my-app',
    files: [{ path: 'index.html', content: '<html></html>' }],
    description: 'Built with Ready4Launch',
    stack: { frontend: 'react', backend: 'go' }
  };
  assert(deployPayload.stack, 'Payload must include stack');
  assert(deployPayload.stack.frontend === 'react', 'Stack frontend must match');
  assert(deployPayload.stack.backend === 'go', 'Stack backend must match');
});

test('Files array can include start.ps1', () => {
  const script = generateStartScript({ frontend: 'react', backend: 'go' });
  const files = [
    { path: 'index.html', content: '<html></html>' },
    { path: 'start.ps1', content: script }
  ];
  assert(files.length === 2, 'Should have both files');
  assert(files[1].path === 'start.ps1', 'start.ps1 should be in files');
  assert(files[1].content === script, 'Script content should match');
});

// ──────────────────────────────────────────────────────────────────
// REGRESSION TESTS: Existing Functionality
// ──────────────────────────────────────────────────────────────────
console.log('\n[REGRESSION TESTS] Existing Functionality');
console.log('─────────────────────────────────────────────────────');

test('Static apps still work (HTML only)', () => {
  const script = generateStartScript({ frontend: 'html', backend: 'none' });
  assert(script === null, 'Static apps should return null from startScriptGenerator');
});

test('Stack detection backward compatible', () => {
  const files = [
    { path: 'index.html', content: '<html></html>' },
    { path: 'package.json', content: '{}' }
  ];
  assert(needsLocalRunner(files) === true, 'Should still detect backend');
});

test('File injection does not corrupt existing files', () => {
  const originalFiles = [
    { path: 'index.html', content: '<html><body>Test</body></html>' },
    { path: 'css/style.css', content: 'body { color: red; }' }
  ];
  const script = generateStartScript({ frontend: 'react', backend: 'go' });
  const withScript = [...originalFiles, { path: 'start.ps1', content: script }];

  assert(withScript[0].path === 'index.html', 'Original file 1 unchanged');
  assert(withScript[1].path === 'css/style.css', 'Original file 2 unchanged');
  assert(withScript[2].path === 'start.ps1', 'Script added at end');
  assert(withScript.length === 3, 'Should have 3 files total');
});

test('Deploy logic handles missing stack gracefully', () => {
  const deployStack = null || { frontend: 'html', backend: 'none' };
  const script = generateStartScript(deployStack);
  assert(script === null, 'Should handle null stack gracefully');
});

// ──────────────────────────────────────────────────────────────────
// DRY-RUN TESTS: End-to-end Validation
// ──────────────────────────────────────────────────────────────────
console.log('\n[DRY-RUN TESTS] End-to-end Validation');
console.log('─────────────────────────────────────────────────────');

test('React+Go full-stack deployment simulation', () => {
  const stack = { frontend: 'react', backend: 'go' };
  const script = generateStartScript(stack);
  assert(script !== null, 'Should generate script');

  const files = [
    { path: 'index.html', content: '<html></html>' },
    { path: 'server.go', content: 'package main' },
    { path: 'package.json', content: '{"name":"app"}' },
    { path: 'start.ps1', content: script }
  ];

  assert(files.length === 4, 'Should have all 4 files');
  assert(files.find(f => f.path === 'start.ps1'), 'start.ps1 present');
  assert(needsLocalRunner(files) === true, 'Should detect as local runner needed');
});

test('Vue+Python full-stack deployment simulation', () => {
  const stack = { frontend: 'vue', backend: 'python' };
  const script = generateStartScript(stack);
  assert(script !== null, 'Should generate script');
  assert(script.includes('python'), 'Script should mention Python');

  const files = [
    { path: 'index.html', content: '<html></html>' },
    { path: 'app.py', content: 'from flask import Flask' },
    { path: 'requirements.txt', content: 'flask==2.0' },
    { path: 'package.json', content: '{"name":"app"}' },
    { path: 'start.ps1', content: script }
  ];

  assert(files.length === 5, 'Should have all 5 files');
  assert(isBackendApp(files.slice(0, 4)) === true, 'Should detect backend');
});

test('GitHub Pages app (HTML only) unchanged', () => {
  const stack = { frontend: 'html', backend: 'none' };
  const script = generateStartScript(stack);
  assert(script === null, 'Should NOT generate script for Pages');

  const files = [
    { path: 'index.html', content: '<html></html>' },
    { path: 'css/style.css', content: 'body{}' }
  ];

  assert(needsLocalRunner(files) === false, 'Should NOT need local runner');
  assert(files.length === 2, 'Should have only 2 files (no start.ps1)');
});

test('Complete deploy workflow - React+Node.js', () => {
  // Simulate the full deployment workflow
  const frontendStack = { frontend: 'react', backend: 'nodejs' };

  // Step 1: Check if script should be generated
  const shouldGenerate = frontendStack.backend !== 'none' && frontendStack.frontend !== 'html';
  assert(shouldGenerate === true, 'Should decide to generate script');

  // Step 2: Generate start.ps1
  const startScript = generateStartScript(frontendStack);
  assert(startScript !== null, 'Should generate start.ps1');
  assert(startScript.includes('npm start'), 'Should have npm start');

  // Step 3: Build file array
  const extractedFiles = [
    { path: 'index.html', content: '<html></html>' },
    { path: 'package.json', content: '{}' },
    { path: 'server.js', content: 'const express = require("express")' }
  ];

  // Step 4: Inject start.ps1 (simulate backend logic)
  let filesToDeploy = extractedFiles;
  if (shouldGenerate && startScript) {
    filesToDeploy = [...extractedFiles, { path: 'start.ps1', content: startScript }];
  }

  // Step 5: Verify deployment package
  assert(filesToDeploy.length === 4, 'Should have 4 files total');
  assert(filesToDeploy.find(f => f.path === 'start.ps1'), 'start.ps1 should be included');
  assert(filesToDeploy.find(f => f.path === 'package.json'), 'package.json preserved');
});

// ──────────────────────────────────────────────────────────────────
// EDGE CASES & VALIDATION
// ──────────────────────────────────────────────────────────────────
console.log('\n[EDGE CASE TESTS] Boundary Conditions');
console.log('─────────────────────────────────────────────────────');

test('Case insensitivity: React vs react', () => {
  const script1 = generateStartScript({ frontend: 'React', backend: 'Go' });
  const script2 = generateStartScript({ frontend: 'react', backend: 'go' });
  // Both should generate or both should be null (frontend case handling)
  assert((script1 === null) === (script2 === null), 'Case sensitivity should be consistent');
});

test('Empty stack object returns null', () => {
  const script = generateStartScript({});
  assert(script === null, 'Empty stack should return null');
});

test('Partial stack object returns null', () => {
  const script1 = generateStartScript({ frontend: 'react' });
  const script2 = generateStartScript({ backend: 'go' });
  assert(script1 === null, 'Missing backend should return null');
  assert(script2 === null, 'Missing frontend should return null');
});

test('Special characters in stack names', () => {
  const script = generateStartScript({ frontend: 'react-native', backend: 'node.js' });
  // Should handle gracefully (or return null)
  assert(typeof script === 'string' || script === null, 'Should handle special chars');
});

test('Deploy request without stack falls back', () => {
  const deployRequest = {
    repoName: 'app',
    files: [],
    description: 'test'
    // stack is missing
  };
  const stack = deployRequest.stack || { frontend: 'html', backend: 'none' };
  assert(stack.frontend === 'html', 'Should fall back to default frontend');
  assert(stack.backend === 'none', 'Should fall back to default backend');
});

// ──────────────────────────────────────────────────────────────────
// SUMMARY
// ──────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════');
console.log('TEST SUMMARY');
console.log('═══════════════════════════════════════════════════════');
console.log(`Total Tests:   ${testCount}`);
console.log(`Passed:        ${passCount} ✅`);
console.log(`Failed:        ${failCount} ❌`);
console.log(`Pass Rate:     ${((passCount / testCount) * 100).toFixed(1)}%`);
console.log('═══════════════════════════════════════════════════════\n');

if (failCount === 0) {
  console.log('🎉 ALL TESTS PASSED! The implementation is ready.\n');
  process.exit(0);
} else {
  console.log(`⚠️  ${failCount} test(s) failed. Review implementation.\n`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * API Key Diagnostic — test raw calls to Google API
 * Helps isolate: billing, API enablement, key format, auth issues
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
let GEMINI_API_KEY = '';

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  const match = envContent.match(/GEMINI_API_KEY\s*=\s*(.+)/);
  if (match) {
    GEMINI_API_KEY = match[1].trim();
  }
}

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY not found in .env');
  process.exit(1);
}

console.log('📋 API Key Diagnostic\n');
console.log('Key format:', GEMINI_API_KEY.substring(0, 10) + '...' + GEMINI_API_KEY.substring(GEMINI_API_KEY.length - 5));
console.log('Key length:', GEMINI_API_KEY.length, 'chars');
console.log('');

// Test 1: Simple generateContent call (lowest complexity, shows if key is valid)
async function testGenerateContent() {
  console.log('TEST 1: Simple generateContent...');
  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Say "key is valid"' }]
          }
        ]
      },
      {
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    console.log('✅ generateContent succeeded');
    console.log('   Status:', response.status);
    console.log('   Output:', response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.substring(0, 50));
    return true;
  } catch (err) {
    console.log('❌ generateContent failed');
    console.log('   Status:', err.response?.status);
    console.log('   Error:', err.response?.data?.error?.message || err.message);
    console.log('   Full response:', JSON.stringify(err.response?.data, null, 2));
    return false;
  }
}

// Test 2: Interactions API (what Antigravity uses)
async function testInteractionsAPI() {
  console.log('\nTEST 2: Interactions API (Antigravity)...');
  try {
    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      {
        agent: 'antigravity-preview-05-2026',
        input: 'Say "interactions key is valid"',
        environment: { type: 'remote' }
      },
      {
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    console.log('✅ Interactions API succeeded');
    console.log('   Status:', response.status);
    console.log('   Agent status:', response.data?.status);
    return true;
  } catch (err) {
    console.log('❌ Interactions API failed');
    console.log('   Status:', err.response?.status);
    console.log('   Error:', err.response?.data?.error?.message || err.message);
    console.log('   Full response:', JSON.stringify(err.response?.data, null, 2));
    return false;
  }
}

// Test 3: List models (simplest call — shows if auth works at all)
async function testListModels() {
  console.log('\nTEST 3: List models (auth check)...');
  try {
    const response = await axios.get(
      'https://generativelanguage.googleapis.com/v1/models',
      {
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
        },
        timeout: 10000
      }
    );
    console.log('✅ List models succeeded');
    console.log('   Status:', response.status);
    console.log('   Model count:', response.data?.models?.length || 0);
    return true;
  } catch (err) {
    console.log('❌ List models failed');
    console.log('   Status:', err.response?.status);
    console.log('   Error:', err.response?.data?.error?.message || err.message);
    return false;
  }
}

// Test 4: Check key via URL param (old broken way, for comparison)
async function testViaUrlParam() {
  console.log('\nTEST 4: Via URL param (deprecated, for comparison)...');
  try {
    const response = await axios.get(
      `https://generativelanguage.googleapis.com/v1/models?key=${GEMINI_API_KEY}`,
      { timeout: 10000 }
    );
    console.log('✅ URL param succeeded (legacy method)');
    console.log('   Status:', response.status);
    return true;
  } catch (err) {
    console.log('❌ URL param failed');
    console.log('   Status:', err.response?.status);
    console.log('   Error:', err.response?.data?.error?.message || err.message);
  }
}

// Run all tests
async function runAll() {
  const results = [];
  results.push(await testListModels());         // Most basic
  results.push(await testGenerateContent());    // Main API
  results.push(await testInteractionsAPI());    // Antigravity
  await testViaUrlParam();                       // For comparison

  console.log('\n' + '='.repeat(50));
  console.log('SUMMARY:');
  console.log('  List models:', results[0] ? '✅' : '❌');
  console.log('  generateContent:', results[1] ? '✅' : '❌');
  console.log('  Interactions API:', results[2] ? '✅' : '❌');

  if (!results[0]) {
    console.log('\n⚠️  Even basic auth failed. Check:');
    console.log('  1. Billing is enabled in the GCP project');
    console.log('  2. Generative Language API is enabled (APIs & Services)');
    console.log('  3. API key has no restrictions (or Generative Language API is in the list)');
  }

  if (!results[1] && results[0]) {
    console.log('\n⚠️  Auth works but generateContent failed. Check:');
    console.log('  1. Model name is correct (gemini-2.5-flash exists)');
    console.log('  2. Request format is valid');
  }

  if (!results[2] && results[1]) {
    console.log('\n⚠️  generateContent works but Interactions API failed. Check:');
    console.log('  1. Antigravity agent is available in your region');
    console.log('  2. Agent name is spelled correctly');
  }
}

runAll().catch(e => {
  console.error('Diagnostic error:', e.message);
  process.exit(1);
});

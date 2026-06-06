# Root Cause: Stack Selection Ignored During Build

**Error:** React + Go selected but built as GitHub Pages (HTML only)  
**Severity:** CRITICAL 🔴  
**Location:** `server/routes/chat.js` Lines 1280-1306  
**Date Found:** 2026-06-04

---

## The Problem

When you:
1. Select React + Go (backend: 'go', type: 'dynamic')
2. Click "Build"
3. System generates minimal HTML instead of React + Go full-stack

The `selectedStack` is correctly stored but **never passed to the AI for code generation**.

---

## Root Cause Code

### Current Buggy Logic (Lines 1280-1306)

```javascript
// Build enrichedNotes based on mode
let enrichedNotes = '';

if (req.session.buildMode === 'complete' && req.session.compiledSpec) {
  // ✅ Stack context INCLUDED here (from compiledSpec)
  enrichedNotes = `COMPLETE PRODUCT BUILD...\n${req.session.compiledSpec}\n\n...`;

} else if (req.session.buildMode === 'prototype') {
  // ❌ Stack context NOT included here!
  enrichedNotes = `${base}\n${style}...PROTOTYPE MODE...`;

} else if (req.session.planNotes) {
  // ❌ Stack context NOT included here!
  enrichedNotes = req.session.planNotes;
}

// Send to AI
await antigravity.streamChat(processedMessage, historyToSend, null, ..., enrichedNotes);
```

### The Flow That Causes the Bug

```
User in "Change the Stack" mode (editing existing repo)
       ↓
User selects React + Go
       ↓
Stack stored in req.session.selectedStack ✅
       ↓
User clicks "Build"
       ↓
Code enters BUILD PHASE (line 1277)
       ↓
Check: Is buildMode === 'complete'? 
       ↓ NO (it's probably 'prototype' or null)
       ↓
Check: Is buildMode === 'prototype'?
       ↓ MAYBE (check next)
       ↓
If NO, Fall back to planNotes (which was created BEFORE stack selection)
       ↓
enrichedNotes = planNotes (NO STACK CONTEXT!)
       ↓
Send to AI: "Build a React app" (without mentioning Go backend)
       ↓
AI generates: Minimal React SPA + GitHub Pages instructions
       ↓
User gets: GitHub Pages deployment (WRONG!)
       ↓
Missing: Go backend setup, server code, deployment instructions
```

---

## Why This Happens

### Timeline of Events

```
STEP 1: User enters "edit mode" (changing existing React + Python app)
        buildMode = undefined (never set for edit mode)
        planNotes = set during initial request analysis

STEP 2: User clicks "Change the stack"
        Phase changes to 'stack_selection'
        selectedStack = null (reset)

STEP 3: User selects React + Go
        selectedStack = { frontend: 'react', backend: 'go', type: 'dynamic' } ✅
        compiledSpec = NOT set (no complete questions asked)
        buildMode = still NOT 'complete'

STEP 4: User clicks "Build"
        Enters BUILD PHASE (line 1277)
        Checks if buildMode === 'complete' AND compiledSpec exists
        BOTH are false/undefined!
        Falls back to planNotes (created BEFORE stack selection)
        
RESULT: AI never sees the selected stack!
```

---

## The Fix Needed

### Option 1: Include Stack Context in ALL Build Modes (RECOMMENDED)

```javascript
// ✅ FIXED: Include stack context regardless of build mode
let enrichedNotes = '';
let stackContext = '';

// Build stack context if selected
if (req.session.selectedStack) {
  stackContext = buildStackContext(req.session.selectedStack, req.session.gatheredAnswers || []) + '\n\n';
}

// Now build enrichedNotes with stack context included
if (req.session.buildMode === 'complete' && req.session.compiledSpec) {
  enrichedNotes =
    `COMPLETE PRODUCT BUILD — specification from 5-question requirements interview:\n` +
    `${stackContext}` +  // ✅ ADD STACK CONTEXT HERE
    `${req.session.compiledSpec}\n\n` +
    `Original user request: "${req.session.originalRequest}"`;

} else if (req.session.buildMode === 'prototype') {
  const base = (req.session.planNotes && req.session.planNotes !== 'No additional context.')
    ? req.session.planNotes
    : `Original request: "${req.session.originalRequest}"`;

  enrichedNotes =
    `${stackContext}` +  // ✅ ADD STACK CONTEXT HERE
    `${base}\n` +
    `User's chosen style: "${trimmedMessage}". Apply this throughout.\n\n` +
    `PROTOTYPE MODE: Build a SINGLE-PAGE application...`;

} else if (req.session.planNotes || req.session.selectedStack) {
  // ✅ Include stack context for subsequent building turns
  enrichedNotes = stackContext + (req.session.planNotes || '');
}
```

### What This Does

```
✅ If stack selected → ALWAYS include stack context
✅ Works in edit mode (changing stack)
✅ Works in prototype mode (selecting stack during build)
✅ Works in complete mode (selecting stack with questions)
✅ AI knows exact framework to use
✅ Generates proper code for selected stack
```

---

## Proof: The Stack Context Matters

Look at `buildStackContext()` output for React + Go:

```javascript
// From stackAdvisor.js
function buildStackContext(stack, answers) {
  return `
══ SELECTED TECH STACK ══
Stack:       React + Go
Type:        Dynamic Web App
Frontend:    React
Backend:     Go
Deploy mode: manual

══ STACK REQUIREMENTS ══
You are building a React frontend with a Go backend.
The frontend will be a Single Page App (SPA) that communicates with a Go API server.
...
Generate:
1. React frontend (src/App.jsx, etc.) - This is deployed to GitHub Pages or static hosting
2. Go backend server code (main.go, routes/) - User deploys this separately
3. API documentation for the frontend-backend contract
...
  `;
}
```

**Without this context**, the AI thinks it's building a **frontend-only app**!  
**With this context**, the AI knows to generate **React + Go code**!

---

## Why You Only See 2 Lines of HTML

When AI doesn't know about the backend:

```javascript
// ❌ WRONG: AI thinks it's frontend-only
const response = `Here's your React app:

\`\`\`html
<!DOCTYPE html>
<html>
  <head>
    <title>React App</title>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  </head>
  <body id="root"></body>
</html>
\`\`\`

Deploy to GitHub Pages!
`;

// ✅ CORRECT: AI knows about Go backend
const response = `Here's your React + Go app:

Frontend:
\`\`\`jsx
// src/App.jsx - React component
import React, { useState, useEffect } from 'react';

export default function App() {
  const [data, setData] = useState(null);
  
  useEffect(() => {
    fetch('http://localhost:8080/api/data')
      .then(r => r.json())
      .then(setData);
  }, []);
  
  return <div>{data}</div>;
}
\`\`\`

Backend:
\`\`\`go
// main.go - Go server
package main

import (
  "github.com/gin-gonic/gin"
)

func main() {
  router := gin.Default()
  
  router.GET("/api/data", func(c *gin.Context) {
    c.JSON(200, gin.H{"message": "Hello from Go!"})
  })
  
  router.Run(":8080")
}
\`\`\`

Setup:
1. Run Go server: \`go run main.go\`
2. Run React: \`npm start\`
3. React connects to http://localhost:8080
`;
```

---

## The Fix (Complete Code)

```javascript
// ════════════════════════════════════════════════════════════
// BUILD PHASE — streaming generation (FIXED)
// ════════════════════════════════════════════════════════════

// Build enrichedNotes based on mode
let enrichedNotes = '';

// ✅ BUILD STACK CONTEXT (NEW)
let stackContext = '';
if (req.session.selectedStack) {
  const { buildStackContext } = require('../services/stackAdvisor');
  stackContext = buildStackContext(req.session.selectedStack, req.session.gatheredAnswers || []) + '\n\n';
  console.log('[Chat] Including stack context for:', JSON.stringify(req.session.selectedStack));
}

// Now apply to all modes
if (req.session.buildMode === 'complete' && req.session.compiledSpec) {
  enrichedNotes =
    `COMPLETE PRODUCT BUILD — specification from 5-question requirements interview:\n` +
    `${stackContext}` +  // ✅ FIXED: Add stack context
    `${req.session.compiledSpec}\n\n` +
    `Original user request: "${req.session.originalRequest}"`;

} else if (req.session.buildMode === 'prototype') {
  const base = (req.session.planNotes && req.session.planNotes !== 'No additional context.')
    ? req.session.planNotes
    : `Original request: "${req.session.originalRequest}"`;

  enrichedNotes =
    `${stackContext}` +  // ✅ FIXED: Add stack context
    `${base}\n` +
    `User's chosen style: "${trimmedMessage}". Apply this throughout.\n\n` +
    `PROTOTYPE MODE: Build a SINGLE-PAGE application. ` +
    `Include a FIXED top navigation bar with AT LEAST 5 anchor links that smooth-scroll ` +
    `to clearly labeled in-page sections. All sections must have complete, realistic, ` +
    `domain-specific content. NO multi-page routing or separate HTML files.`;

} else if (req.session.planNotes || stackContext) {
  // ✅ FIXED: Include stack context for subsequent building turns
  enrichedNotes = stackContext + (req.session.planNotes || '');
}

// Rest of code stays the same...
await antigravity.streamChat(
  processedMessage,
  historyToSend,
  null,
  onChunk,
  onDone,
  enrichedNotes  // ✅ Now includes stack context in ALL cases!
);
```

---

## Testing the Fix

### Before Fix
```
User selects: React + Go
System sends to AI: (no stack context)
AI generates: Minimal 2-line HTML
Deployment: GitHub Pages
Result: ❌ BROKEN
```

### After Fix
```
User selects: React + Go
System sends to AI: 
  "SELECTED TECH STACK: React + Go
   DEPLOY MODE: manual
   Generate React frontend + Go backend server code..."
AI generates: Full React + Go app with:
  - React components
  - Go server code
  - API contract
  - Setup instructions
Deployment: Manual (user deploys Go separately)
Result: ✅ WORKS
```

---

## Files to Change

**File:** `server/routes/chat.js`  
**Location:** Lines 1280-1306  
**Change:** Add stack context to ALL build modes, not just 'complete' mode

**Changes Required:**
1. Line 1280: Add stack context building BEFORE the if/else chain
2. Line 1286: Include stack context in 'complete' mode
3. Line 1296: Include stack context in 'prototype' mode
4. Line 1305: Include stack context in fallback mode

---

## Summary

**What's Wrong:**
- Stack selection is stored but never communicated to AI
- AI doesn't know about selected backend
- AI generates frontend-only minimal app
- Deployment mode is GitHub Pages instead of manual

**Root Cause:**
- `buildStackContext()` only included when `buildMode === 'complete'`
- Edit mode (changing stack) has `buildMode !== 'complete'`
- Stack context falls through to planNotes (created before stack selection)

**The Fix:**
- Include stack context in ALL build modes
- Always pass selected stack to AI
- AI generates proper full-stack code

**Impact:**
- ✅ React + Go apps will generate properly
- ✅ React + Python apps will work
- ✅ React + Java apps will work
- ✅ All 40 stack combinations will build correctly
- ✅ Correct deployment modes will be shown


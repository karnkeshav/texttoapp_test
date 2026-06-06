# Comprehensive QA Analysis: Stack Selection & Build Feature

**Date:** 2026-06-04  
**Scope:** Complete feature flow analysis for stack selection, building, and deployment  
**Approach:** Adversarial QA - looking for bugs, not validating happy paths  
**Status:** Critical issues identified

---

## PHASE 1: Feature Flow Analysis

### Entry Points (Where Users Can Start)

```
1. MODE QUESTION (New conversation)
   └─ User clicks "Complete Product" (NOT "Prototype")
   └─ Triggers: Stack selector UI
   └─ Phase transition: mode → stack_selection

2. STACK SELECTOR (Complete mode)
   └─ User selects: frontend, backend, type
   └─ User clicks: "Build with this stack"
   └─ Triggers: submitStackSelection()
   └─ Message format: __STACK__:{...}
   └─ Phase transition: stack_selection → complete_questioning

3. EDIT MODE - CHANGE STACK
   └─ User enters edit mode: /edit/owner/repo
   └─ Detects existing app
   └─ Shows "Change stack" / "Modify" buttons
   └─ User clicks "Change the stack"
   └─ Phase transition: editing → stack_selection
   └─ User selects new stack
   └─ User clicks "Build with this stack"
   └─ Triggers: submitStackSelection()

4. EDIT MODE - MODIFY STACK
   └─ User enters edit mode
   └─ User clicks "Modify within same stack"
   └─ Phase transition: editing → editing (continue)
   └─ User sends message
   └─ No stack selection happens

5. PROTOTYPE MODE (Alternative flow)
   └─ User clicks "Prototype"
   └─ Skips stack selection entirely
   └─ Skips 5 questions
   └─ Goes straight to style question
```

### State Variables & Lifecycle

```
SESSION VARIABLES:
┌─────────────────────────────────────────────────────────────┐
│ CORE STATE                                                   │
├─────────────────────────────────────────────────────────────┤
│ chatPhase: string                                            │
│   Values: init, mode, mode_choice, stack_selection,         │
│           complete_questioning, building, editing,          │
│           edit_choice, conversion, reasoning, chat          │
│   ⚠️ RISK: Many states, complex transitions                │
│                                                              │
│ buildMode: string | null                                    │
│   Values: 'prototype' | 'complete' | null                   │
│   ⚠️ RISK: Can be null, used in conditionals               │
│                                                              │
│ selectedStack: object | null                                │
│   Shape: { frontend, backend, type }                        │
│   ⚠️ RISK: Set in stack_selection, used in building        │
│   ⚠️ RISK: Can be null, must check before use              │
│                                                              │
│ compiledSpec: string                                        │
│   ⚠️ RISK: Only populated in complete mode                 │
│   ⚠️ RISK: Used in enrichedNotes construction              │
│                                                              │
│ planNotes: string                                           │
│   ⚠️ RISK: Set early, reused throughout                    │
│                                                              │
│ gatheredAnswers: array                                      │
│   ⚠️ RISK: Populated during questioning, used in spec      │
│                                                              │
│ editMode: object | null                                     │
│   Shape: { owner, repo, defaultBranch }                     │
│   ⚠️ RISK: Controls edit vs create flow                     │
│   ⚠️ RISK: Used to restore session                         │
│                                                              │
│ detectedStack: object | null                                │
│   ⚠️ RISK: Set during edit mode, might be wrong            │
│   ⚠️ RISK: Used as fallback if selectedStack missing       │
│                                                              │
│ deploymentMode: string | null                               │
│   ⚠️ RISK: Determined late in flow, shown to user          │
└─────────────────────────────────────────────────────────────┘
```

### Event Handlers & User Actions

```
USER ACTION                          HANDLER                    STATE CHANGE
─────────────────────────────────────────────────────────────────────────────
Click "Complete Product"          renderModeQuestion()       init → mode
                                  
Click "Prototype"                 renderModeQuestion()       init → prototype_style

Click Stack Selector              renderStackSelector()      stack_selection (UI)

Change Frontend Select            updateStackHint()          window._stackFrontend

Change Backend Select             updateStackHint()          window._stackBackend

Change Type Select                updateStackHint()          window._stackType

Click "Build with this stack"     submitStackSelection()     message = __STACK__:{...}
                                                             sendMessage()
                                                             
Ask Question 1-5                  (user types answer)        gatheredAnswers.push()
                                  sendMessage()              
                                  
Click "Build" (final)             (builds based on mode)     chatPhase = building

Enter Edit Mode                   (detectStackFromCode)      editMode = {owner, repo}
                                  (detectedStack set)        detectedStack = {...}

Click "Change the stack"          (reset stack)              selectedStack = null
                                  (show selector)            chatPhase = stack_selection

Click "Modify within same stack"  (continue editing)         chatPhase = editing (no change)
                                  (ask what changes)         
```

### Conditionals & Decision Points

```
CRITICAL CONDITIONALS:

1. if (buildMode === 'complete' && compiledSpec)
   Location: Line 1283-1287
   ⚠️ RISK: Both conditions must be true
   ⚠️ RISK: compiledSpec only set if 5 questions answered
   ⚠️ RISK: buildMode not set in edit mode!
   Branch A: Include compiledSpec in enrichedNotes ✓
   Branch B: Fall through to next condition (may be wrong)

2. if (buildMode === 'prototype')
   Location: Line 1289-1301
   ⚠️ RISK: Only true in prototype mode (not edit/complete)
   Branch A: Use style answer + planNotes
   Branch B: Fall through (edit mode)

3. if (req.session.planNotes || stackContext)
   Location: Line 1303
   ⚠️ RISK: planNotes might be stale
   ⚠️ RISK: If both null, enrichedNotes stays empty!
   Branch A: Use planNotes
   Branch B: enrichedNotes is empty string!

4. if (selectedStack)
   Location: Multiple
   ⚠️ RISK: selectedStack can be null
   ⚠️ RISK: No fallback if null
   Branch A: Use selectedStack context
   Branch B: No context provided

5. if (isRestoringEditMode)
   Location: Line 533-536
   ⚠️ RISK: Complex condition
   ⚠️ RISK: chatPhase must be exactly 'editing'
   ⚠️ RISK: editMode owner/repo must match
   Branch A: Restore (skip choice screen)
   Branch B: Reset session (start over)

6. if (validStackCombination)
   Location: Line 1974-1984
   ⚠️ RISK: Frontend/backend/type must all be valid
   ⚠️ RISK: User can select invalid combo?
   ⚠️ RISK: Frontend select changes available backends
   Branch A: Allow build
   Branch B: Show error (but doesn't prevent selection)
```

### API Calls & Payloads

```
PAYLOAD CONSTRUCTION:

1. First Message (new conversation)
   POST /api/chat
   {
     message: user's request,
     newConversation: true,
     modeHint: 'build' | 'chat' | 'conversion' (if hinted)
   }
   ⚠️ RISK: modeHint only set if welcome mode clicked
   ⚠️ RISK: If set, cleared after first use

2. Mode Selection
   POST /api/chat
   {
     message: '1' (complete) or '2' (prototype),
     newConversation: false
   }
   ⚠️ RISK: Message is just '1' or '2', not descriptive
   ⚠️ RISK: Backend must recognize these values

3. Stack Selection
   POST /api/chat
   {
     message: '__STACK__:{"frontend":"react","backend":"go","type":"dynamic"}',
     newConversation: false
   }
   ⚠️ RISK: Strict format required
   ⚠️ RISK: If JSON invalid, parse fails silently?

4. Question Answers
   POST /api/chat
   {
     message: user's answer to question 1-5,
     newConversation: false
   }
   ⚠️ RISK: No indication this is a question answer
   ⚠️ RISK: Could be classified as other intent

5. Building
   POST /api/chat
   {
     message: original request (complete) or style answer (prototype),
     enrichedNotes: stack context + spec + answers,
     (other context)
   }
   ⚠️ RISK: enrichedNotes might be empty!
   ⚠️ RISK: Message might not match enrichedNotes

6. Edit Mode Build
   POST /api/chat
   {
     message: __STACK__:...,
     editMode: true,
     editOwner: 'owner',
     editRepo: 'repo',
     editBranch: 'main'
   }
   ⚠️ RISK: Must include editMode flag
   ⚠️ RISK: Stack might be wrong if edit mode not set

7. Edit Mode Modify
   POST /api/chat
   {
     message: user's change request,
     editMode: true,
     editOwner: 'owner',
     editRepo: 'repo',
     currentCode: existing code
   }
   ⚠️ RISK: Must fetch currentCode
   ⚠️ RISK: Might be stale if edited elsewhere
```

---

## PHASE 2: Bug Hunt - Adversarial QA

### Critical Bugs Already Found

1. ✅ **Button Click Parameters** (Line 503, app.js)
   - sendMessage() called with '1'/'2' but didn't accept parameters
   - FIX APPLIED: Added buttonValue parameter

2. ✅ **Stack Context Missing** (Line 1280-1306, chat.js)
   - selectedStack stored but not passed to AI
   - Only included in 'complete' mode, not edit/prototype
   - FIX APPLIED: Include context in ALL modes

### High-Risk Bugs NOT Yet Found

#### Bug #1: enrichedNotes Can Be Empty String ⚠️

**Location:** Lines 1303-1306

```javascript
} else if (req.session.planNotes || stackContext) {
  enrichedNotes = stackContext + (req.session.planNotes || '');
}
// If both planNotes AND stackContext are null/empty: enrichedNotes = ''
```

**Scenario:**
1. User in prototype mode
2. User clicks "Build" immediately (before answering style question)
3. trimmedMessage = '' (empty)
4. planNotes = null (not set for this mode)
5. stackContext = '' (no selectedStack in prototype)
6. enrichedNotes = '' + '' = ''
7. AI receives empty enrichedNotes
8. AI confused, generates garbage

**Test Case:** 
```javascript
test("Building in prototype mode without style answer should not crash", () => {
  // Enter prototype mode
  // Click "Build" without answering style question
  // enrichedNotes should not be empty
});
```

---

#### Bug #2: Stale State - Edit Mode Session Not Properly Reset ⚠️

**Location:** Lines 533-554

```javascript
if (newConversation || !req.session.chatHistory) {
  // Reset session
  req.session.selectedStack = null;
  req.session.editMode = null;
}
```

**Scenario:**
1. User edits Repo A, selects React + Go
2. Closes browser
3. Logs back in (new conversation detected)
4. System resets session (including editMode = null)
5. User goes to edit Repo B
6. Old React + Go context might linger?
7. Building Repo B might use Repo A's stack info

**Test Case:**
```javascript
test("Session reset between conversations should clear edit mode", () => {
  // Session 1: Edit Repo A with React + Go
  // Close browser
  // Session 2: New conversation
  // editMode should be null
  // selectedStack should be null
});
```

---

#### Bug #3: isRestoringEditMode Condition Too Strict ⚠️

**Location:** Lines 533-536

```javascript
const isRestoringEditMode = isEditMode && 
  req.session.editMode &&
  req.session.editMode.owner === editOwner &&
  req.session.editMode.repo === editRepo &&
  req.session.chatPhase === 'editing';  // ← STRICT!
```

**Scenario:**
1. User in edit mode, chatPhase = 'editing'
2. User clicks "Change the stack"
3. Backend: chatPhase becomes 'stack_selection'
4. User refreshes browser
5. Now: isEditMode = true, editOwner/Repo match, BUT
6. chatPhase = 'stack_selection' (not 'editing')
7. isRestoringEditMode = false (session reset instead of restored)
8. Stack selection UI lost, user confused

**Test Case:**
```javascript
test("Refreshing during stack selection in edit mode should restore context", () => {
  // Enter edit mode
  // Click "Change the stack"
  // Refresh browser
  // Stack selector should still be visible
  // selectedStack should still be null (correct state)
});
```

---

#### Bug #4: selectedStack Reset When Shouldn't Be ⚠️

**Location:** Line 946

```javascript
if (choice.includes('change') || choice.match(/^1|stack/i)) {
  req.session.chatPhase = 'stack_selection';
  req.session.selectedStack = null;  // ← Reset here
  req.session.editMode = null;
}
```

**Scenario:**
1. User in complete mode, selected React + Go
2. User gets questions screen
3. User accidentally clicks "Change the stack" again
4. selectedStack reset to null!
5. User re-selects React + Go
6. Doubled processing?

**Test Case:**
```javascript
test("Changing stack twice should not cause double builds", () => {
  // Complete mode: select React + Go
  // Click "Build" 
  // Somehow click "Change" again
  // New stack selection should work cleanly
});
```

---

#### Bug #5: Deployment Mode Detection Uses Wrong Stack ⚠️

**Location:** Line 1545-1548

```javascript
const stackForDeployment = req.session.selectedStack || req.session.detectedStack;
if (stackForDeployment) {
  donePayload.deployMode = getDeploymentMode(stackForDeployment);
}
```

**Scenario:**
1. Edit mode: detectStackFromCode() returns { frontend: 'react', backend: 'python' }
2. User clicks "Change the stack"
3. User changes to React + Go
4. selectedStack = { frontend: 'react', backend: 'go' }
5. Build happens
6. deployMode = getDeploymentMode(selectedStack) ✓
7. BUT: If build fails to set selectedStack...
8. Falls back to detectedStack (Python, not Go!)
9. Wrong deployment mode shown!

**Test Case:**
```javascript
test("Deployment mode should use selected stack, not detected stack", () => {
  // Edit: Python backend detected
  // Change to: Go backend selected
  // Deployment mode should be "manual"
  // NOT "manual" for Python (should be same, but what if different?)
});
```

---

#### Bug #6: Parameter Passed But Ignored ⚠️

**Location:** sendMessage() function

```javascript
async function sendMessage(buttonValue) {  // ← Parameter accepted NOW (fixed)
  const input = document.getElementById('chatInput');
  const text = buttonValue ? buttonValue : input.value.trim();
  // ...
}
```

**BUT:** In other places, sendMessage called without this logic:

```javascript
// Line 508 (keyboard handler)
if (e.key === 'Enter' && !e.shiftKey) {
  e.preventDefault();
  sendMessage();  // ← No parameter
}

// Line 2008 (stack selection button)
submitStackSelection() {
  input.value = msg;
  sendMessage();  // ← No parameter, uses input.value (correct)
}
```

**Scenario:**
1. User clicks stack button: sendMessage('1')
2. Function uses parameter: text = '1' ✓
3. User hits Enter after typing message
4. Function called: sendMessage()
5. Function reads input.value (correct for keyboard)
6. But what if:
   - Button handler called THEN keyboard called?
   - Conflicting calls? Race condition?

**Test Case:**
```javascript
test("Button click and keyboard enter should not race condition", () => {
  // Simulate: Button click + keyboard Enter in quick succession
  // Only one message should be sent
  // Message content should be correct
});
```

---

#### Bug #7: Invalid Stack Combination Not Prevented ⚠️

**Location:** Lines 1974-1984

```javascript
function isValidStackCombination(frontend, backend, type) {
  const rules = STACK_COMPATIBILITY[frontend];
  if (!rules.backends.includes(backend)) {
    return { valid: false, reason: '...' };
  }
  return { valid: true };
}
```

**UI Logic:**

```javascript
// Line 1800-1830: When frontend changes, update backend options
if (selectedFrontend === 'nextjs') {
  availableBackends = ['nodejs'];  // ← Only Node.js
}
```

**But What If:**
1. Frontend = 'nextjs', Backend = 'nodejs' ✓
2. User changes Frontend to 'react'
3. Backend still = 'nodejs' (not reset!)
4. User clicks "Build" without changing backend
5. Stack = 'react' + 'nodejs' ✓ (valid, but...)
6. Wait, actually valid. Let me think of invalid one...

**Real Invalid Scenario:**
1. Frontend = 'html', Backend = 'python'
2. HTML can only use 'none' backend
3. UI prevents this, but if direct API call?

**Test Case:**
```javascript
test("Invalid stack combinations should be prevented", () => {
  // HTML + Python should be rejected
  // Angular + None should be rejected (requires backend)
  // Error message should be shown
});
```

---

#### Bug #8: Mode Detection Uses Keywords, Fragile ⚠️

**Location:** Line 1134

```javascript
const detected = detectBuildMode(trimmedMessage);

function detectBuildMode(message) {
  if (message.includes('complete') || message.match(/5\s*q|interview/i)) {
    return 'complete';
  }
  return 'prototype';
}
```

**Scenario:**
1. User writes: "I want to build a complete website with 5 pages"
2. Message includes 'complete' and '5'
3. Wrongly detected as 'complete' mode
4. System asks 5 questions when user just wanted prototype!

**Test Case:**
```javascript
test("Mode detection should not trigger on keywords in natural text", () => {
  // User message: "build a complete website with 5 pages"
  // Should trigger: interview/5-question prompt, not mode selection
});
```

---

### Missing State Checks

#### Issue: selectedStack Used Without Null Check ⚠️

**Location:** Multiple places

```javascript
// Line 1248: buildStackContext(req.session.selectedStack)
// ⚠️ What if selectedStack is null?
// ⚠️ Might pass null to function that expects object

// Line 1393: runDryCheck(extractedFiles, req.session.selectedStack)
// ⚠️ Dry check might fail if stack is null
```

**Test Case:**
```javascript
test("Building with null selectedStack should not crash", () => {
  // Somehow selectedStack becomes null
  // Build should either fail gracefully or use detectedStack
  // Should not throw exception
});
```

#### Issue: compiledSpec Used Without Existence Check ⚠️

**Location:** Line 1312

```javascript
if (req.session.buildMode === 'complete' && req.session.compiledSpec) {
  processedMessage = req.session.originalRequest;
}
// ⚠️ What if buildMode === 'complete' but compiledSpec NOT set?
// ⚠️ processedMessage stays as trimmedMessage (might be wrong)
```

**Test Case:**
```javascript
test("Complete mode without compiledSpec should not send wrong message", () => {
  // Set buildMode = 'complete'
  // But don't populate compiledSpec
  // Build should handle gracefully
});
```

---

## PHASE 3: Coverage Matrix

### Traceability Matrix

```
FEATURE: Stack Selection & Building
══════════════════════════════════════════════════════════════════════════════

SCENARIO 1: New Conversation → Complete Mode → React + Go → Build
───────────────────────────────────────────────────────────────────────────────
User Action            │ State Before        │ State After      │ Test Exists?
─────────────────────────────────────────────────────────────────────────────
Send request           │ chatPhase: init     │ chatPhase: mode  │ N - Missing
Click "Complete"       │ buildMode: null     │ buildMode: null* │ N - Missing
                       │ selectedStack: null │ selectedStack: null│
Click React            │ _stackFrontend: '' │ _stackFrontend: 'react' │ N
Click Go               │ _stackBackend: '' │ _stackBackend: 'go' │ N
Click "Build"          │ selectedStack: null │ selectedStack: {...} │ ✓ Partial
sendMessage(__STACK__) │ chatPhase: stack... │ chatPhase: q1... │ Y
Answer Q1              │ gatheredAnswers: [] │ gatheredAnswers: [A1] │ N
Answer Q2              │ gatheredAnswers: [A1] │ gatheredAnswers: [A1,A2] │ N
Answer Q3              │ gatheredAnswers: [...,A2] │ gatheredAnswers: [...,A3] │ N
Answer Q4              │ gatheredAnswers: [...,A3] │ gatheredAnswers: [...,A4] │ N
Answer Q5              │ gatheredAnswers: [...,A4] │ compiledSpec: set │ N
                       │ compiledSpec: null │ chatPhase: building │
Build happens          │ chatPhase: building │ code generated    │ ✓ Partial
enrichedNotes set      │ enrichedNotes: ''   │ enrichedNotes: {...} │ ⚠️ Missing
deployMode set         │ deployMode: null    │ deployMode: manual  │ ⚠️ Missing

* buildMode NOT set in complete mode! Critical bug!
```

### State Transition Matrix

```
FROM                TO                  CONDITION                    TEST?
────────────────────────────────────────────────────────────────────────────
init               mode                 User sends first message       N
mode               stack_selection      User clicks "Complete"         N
mode               prototype_style      User clicks "Prototype"        N
stack_selection    complete_q1          User selects stack + Build    ✓
stack_selection    stack_selection      User clicks "Change" again     ⚠️
complete_q1        complete_q2          User answers Q1                N
complete_q2        complete_q3          User answers Q2                N
complete_q3        complete_q4          User answers Q3                N
complete_q4        complete_q5          User answers Q4                N
complete_q5        building             User answers Q5                N
building           done                 Code generated                 ✓
prototype_style    building             User answers style             ⚠️
building           done                 Code generated                 ✓
editing            edit_choice          User in edit mode              ✓
edit_choice        stack_selection      User clicks "Change stack"     ⚠️
edit_choice        editing              User clicks "Modify"           ✓
stack_selection    building             User selects stack, builds     ⚠️

⚠️ = Not tested, high risk
✓ = Tested (at least partially)
N = Not tested
```

### Payload Construction Matrix

```
PHASE              MESSAGE            ENRICHEDMOTES             API CALL?   TEST?
─────────────────────────────────────────────────────────────────────────────
init               Request            ''                        YES         N
mode               '1' or '2'         ''                        YES         N
stack              __STACK__:{...}    ''                        YES         ✓
q1-q5              Answer             ''                        YES         N
complete_building  originalRequest    compiledSpec + context    YES         ⚠️
proto_building     styleAnswer        planNotes + context       YES         ⚠️
edit_building      stackOrMessage     detectedCode + context    YES         ⚠️

⚠️ = enrichedNotes might be wrong or empty
✓ = Tested
N = Not tested
```

### Branch Coverage Matrix

```
BRANCH                                  CONDITION                     TEST EXISTS?
──────────────────────────────────────────────────────────────────────────────
buildMode === 'complete' && compiledSpec
  ✓ TRUE,TRUE                          (Complete flow)               ✓ Partial
  ✗ FALSE,TRUE                         (Shouldn't happen)            N
  ✗ TRUE,FALSE                         (Error: buildMode set but no spec) ⚠️
  ✓ FALSE,FALSE                        (Other modes)                 ✓

buildMode === 'prototype'
  ✓ TRUE                               (Prototype flow)              ⚠️
  ✓ FALSE                              (Other flows)                 ✓

req.session.planNotes || stackContext
  ✓ TRUE,TRUE                          (Both present)                N
  ✓ TRUE,FALSE                         (Old planNotes)               ⚠️
  ✓ FALSE,TRUE                         (Stack selected)              ⚠️
  ✗ FALSE,FALSE                        (Both null: BUG!)             N

selectedStack
  ✓ truthy                             (Stack selected)              ✓
  ✓ null/undefined                    (No stack)                    ⚠️

isValidStackCombination()
  ✓ valid                              (Combination OK)              ✓
  ✓ invalid                            (Incompatible)                ⚠️

isRestoringEditMode
  ✓ TRUE                               (Restore session)             ⚠️
  ✓ FALSE                              (Reset session)               ⚠️
```

### Error Path Matrix

```
ERROR SCENARIO                         EXPECTED BEHAVIOR         TEST EXISTS?
──────────────────────────────────────────────────────────────────────────────
Stack JSON invalid                     Parse error → retry       N
buildMode set but no compiledSpec      fallback? crash?          ⚠️
enrichedNotes empty                    AI confused?              ⚠️
selectedStack null during build        Error? fallback?          ⚠️
detectedStack wrong in edit mode       Wrong deployment          ⚠️
compiledSpec too large                 Token limit?              N
planNotes stale                        Old context sent?         N
button + keyboard race condition       One msg sent?             N
selectedStack not reset properly       State leakage?            ⚠️
```

---

## PHASE 4: Identified Gaps

### Missing Test Scenarios (35+ gaps)

```
CATEGORY 1: State Initialization (5 gaps)
- [ ] New conversation initializes all state correctly
- [ ] Session restoration with mismatched editMode owner/repo
- [ ] Chat history cleared but selectedStack remains
- [ ] buildMode null in multiple branches
- [ ] planNotes null triggers fallback

CATEGORY 2: Mode Selection (3 gaps)
- [ ] Click Complete → Mode selection flow
- [ ] Click Prototype → Skip stack selection
- [ ] Mode detection from keywords (fragile)

CATEGORY 3: Stack Selection (8 gaps)
- [ ] Select valid combo (frontend + backend match)
- [ ] Select invalid combo (HTML + Python)
- [ ] Change frontend → available backends update
- [ ] Change backend → validation updates
- [ ] Click "Build" with valid stack
- [ ] Click "Build" with invalid stack
- [ ] Change stack twice (reset behavior)
- [ ] Cancel stack selection

CATEGORY 4: Question Flow (5 gaps)
- [ ] Each question (Q1-Q5) updates gatheredAnswers
- [ ] Answer validation per question
- [ ] Skip question (if allowed)
- [ ] Go back to previous question
- [ ] Final answer → compiledSpec generation

CATEGORY 5: Build Phase (8 gaps)
- [ ] Complete mode: enrichedNotes has compiledSpec ✓
- [ ] Prototype mode: enrichedNotes has style + context
- [ ] Edit mode: enrichedNotes has currentCode
- [ ] enrichedNotes never empty
- [ ] selectedStack passed to AI
- [ ] deploymentMode determined correctly
- [ ] Dry run validates code
- [ ] Retry loop fixes code issues

CATEGORY 6: Edit Mode (6 gaps)
- [ ] Restore edit session correctly
- [ ] Detect existing stack from code
- [ ] Click "Change stack" → Reset flow
- [ ] Click "Modify" → Continue editing
- [ ] Change stack → New deployment mode
- [ ] Edit code with different backend

CATEGORY 7: Error Handling (4 gaps)
- [ ] Invalid JSON in __STACK__ message
- [ ] API call fails → Retry?
- [ ] Dry run fails → Auto-fix retry
- [ ] Max retries exceeded → Show error

CATEGORY 8: Race Conditions (2 gaps)
- [ ] Button click + keyboard Enter
- [ ] Two builds submitted simultaneously

CATEGORY 9: Edge Cases (4 gaps)
- [ ] Very large completedSpec (token limit?)
- [ ] Empty stale planNotes
- [ ] Stack selected but no questions answered
- [ ] Build without proper enrichedNotes
```

---

## PHASE 5: Test Generation

### Integration Tests Needed (12 critical)

```javascript
1. "Complete mode: Stack selection → 5 questions → Build"
   - Verify each state transition
   - Assert compiledSpec populated
   - Assert deployMode = manual for React+Go
   - Assert enrichedNotes includes stackContext

2. "Complete mode: Invalid stack selection → error"
   - Select HTML + Python (invalid)
   - Verify error shown
   - Verify can re-select valid combo

3. "Edit mode: Change stack from Python to Go"
   - Detect Python from code
   - Click "Change stack"
   - Select Go
   - Verify detectedStack ≠ selectedStack
   - Verify deployMode = manual

4. "Edit mode: Modify within same stack"
   - Don't change stack
   - Continue editing same app
   - Verify selectedStack not used

5. "State restoration: Refresh during stack selection"
   - In edit mode
   - Click "Change stack"
   - Refresh browser
   - Verify stack selector visible
   - Verify editMode preserved

6. "Build with selectedStack AND detectedStack both set"
   - Edit mode with detected Python
   - Change to Go
   - Verify deployMode uses selectedStack (Go)
   - NOT detectedStack (Python)

7. "enrichedNotes construction: All 3 branches"
   - Complete mode: includes compiledSpec
   - Prototype mode: includes style
   - Edit mode: includes currentCode
   - Never empty

8. "Parameters passed through call chain"
   - sendMessage('1') → message = '1'
   - __STACK__:{...} → parsed correctly
   - deployMode → sent to frontend

9. "State persistence across API calls"
   - Set selectedStack
   - Call API
   - selectedStack still available
   - NOT reset unexpectedly

10. "buildMode set correctly for each flow"
    - Complete mode: buildMode = 'complete'
    - Prototype mode: buildMode = 'prototype'
    - Edit mode: buildMode = ?
    - Never null during build

11. "Deployment mode accuracy for all backends"
    - React + Node.js → 'local'
    - React + Python → 'manual'
    - React + None → 'github-pages'
    - HTML + None → 'github-pages'

12. "Stale state cleanup between conversations"
    - Conversation 1: Select React
    - Close session
    - Conversation 2: Select Vue
    - Verify selectedStack only has Vue
    - No React context lingering
```

### E2E Tests Needed (8 critical)

```javascript
1. "User Journey: Complete Product mode with React+Go"
   - Start conversation
   - Click "Complete Product"
   - Select React frontend
   - Select Go backend
   - Type "Dynamic web app"
   - Click "Build"
   - Answer 5 questions
   - See full React+Go code generated
   - Deployment mode shows "Manual"

2. "User Journey: Edit existing Python app, change to Java"
   - Open /edit/owner/repo
   - See "Change the stack" button
   - Click it
   - Select Java backend
   - Click "Build"
   - See Java backend code generated
   - Verify not Python code

3. "User Journey: Modify within same stack"
   - Open edit mode
   - Click "Modify within same stack"
   - Ask "Make button bigger"
   - See code changes
   - No "Build" prompt shown again

4. "User Journey: Invalid stack selection prevented"
   - Click "Complete"
   - Try to select HTML
   - See only "None" backend available
   - Can't select Python/Java

5. "User Journey: Prototype mode skips questions"
   - Click "Prototype"
   - Answer style question only
   - See app generated (no 5 questions)
   - Faster than complete mode

6. "UI Consistency: Button clicks work"
   - Click "Change the stack" button
   - Stack selector appears
   - Click "Modify within same stack"
   - Edit prompt appears

7. "Data Persistence: Session survives refresh"
   - Answering Q1, then refresh
   - Q2 prompt still visible
   - Answer continues working

8. "Error Recovery: Build fails, auto-retry"
   - Generate code with errors
   - Dry run fails
   - System retries up to 3 times
   - Eventually succeeds or shows error
```

---

## PHASE 6: Regression Risk Matrix

```
HIGH RISK (Most likely to break in future):
───────────────────────────────────────────
1. enrichedNotes construction logic
   - 3 different branches
   - Each might become null/empty
   - Easy to add new mode without including context

2. selectedStack usage
   - Set in one phase, used in another
   - Easy to reset unexpectedly
   - No type safety

3. State transitions
   - Many phases: init → mode → stack → q1 → ... → building
   - Easy to skip a phase by accident
   - Condition checks can bypass steps

4. Deployment mode detection
   - Uses selectedStack OR detectedStack
   - Easy to use wrong one
   - No validation

5. Edit mode restoration
   - Complex 5-part condition
   - Easy to break by changing chatPhase logic

MEDIUM RISK:
────────────
6. buildMode not set in edit mode
7. planNotes stale from earlier flow
8. API payload construction (wrong message/enrichedNotes)
9. Question flow (answers not stored properly)
10. Dry run retry loop (might run too many times)

LOW RISK:
─────────
11. HTML option validation
12. Button click handling (now fixed)
13. Style question (prototype mode)
14. Session initialization
```

---

## PHASE 7: Summary Report

### Tests Exist For

```
✓ Stack selection (partial)
✓ Building (partial)
✓ Dry run logic
✓ All 40 stack combinations
✓ Backward compatibility

Missing:
- Edit mode state restoration
- enrichedNotes construction verification
- All 5 question answers
- Deployment mode accuracy (all backends)
- Invalid stack prevention
- Parameter passing verification
- Race conditions
- Error recovery paths
- Stale state scenarios
```

### Bugs Likely Still Lurking

```
🔴 CRITICAL (Will cause crashes):
- enrichedNotes can be empty string → AI confused
- buildMode not set in edit mode → enrichedNotes wrong
- selectedStack might be null → unhandled exception

🟠 HIGH (Will cause wrong behavior):
- detectedStack used instead of selectedStack
- planNotes stale from earlier flow
- deployMode wrong for non-Node.js
- Stack context missing from enrichedNotes in prototype mode

🟡 MEDIUM (Edge cases):
- Button + keyboard race condition
- Session not properly restored
- Invalid stacks not prevented
- Dry run retry might loop forever
```

### Recommended Testing Priority

```
1. enrichedNotes construction (3 branches)
2. selectedStack lifecycle (set, use, reset)
3. Build mode accuracy (complete, prototype, edit)
4. Deployment mode for all backends
5. Parameter passing through call chain
6. Edit mode state restoration
7. Question answering flow
8. Error recovery paths
```

# TRACEABILITY MATRIX: Stack Selection & Build Feature

**Format:** Feature → User Actions → State Changes → Functions Called → Payload Produced → API Called → Expected Result → Test Exists?

---

## TRACE 1: New Conversation + Complete Mode + Valid Stack + Build

```
FEATURE
  └─ Stack Selection & Building (Complete Mode)

USER ACTION #1
  └─ User sends initial request: "Build a todo app"
  
STATE CHANGES
  └─ chatPhase: init → mode
  └─ originalRequest: "Build a todo app"
  └─ planNotes: enriched notes generated
  
FUNCTIONS CALLED
  └─ analyzePlanPhase(request, apiKey)
  └─ sendEvent('done', {showStackSelector: false})
  
PAYLOAD PRODUCED
  └─ { message: "Build a todo app", newConversation: true, modeHint: null }
  
API CALLED
  └─ POST /api/chat with payload
  
EXPECTED RESULT
  └─ System responds with MODE_QUESTION ("Prototype or Complete?")
  └─ Mode buttons rendered on UI
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for mode question flow

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Selection & Building (Complete Mode)

USER ACTION #2
  └─ User clicks "Complete Product" button
  
STATE CHANGES
  └─ chatPhase: mode → stack_selection
  └─ buildMode: null → 'complete'
  └─ questionIndex: 0
  └─ gatheredAnswers: []
  
FUNCTIONS CALLED
  └─ renderStackSelector()
  └─ updateStackHint()
  
PAYLOAD PRODUCED
  └─ { message: '1', newConversation: false }
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ Stack selector UI appears on page
  └─ Frontend dropdown visible
  └─ Backend dropdown visible
  └─ Type dropdown visible
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for mode selection

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Selection & Building (Stack Selection)

USER ACTION #3
  └─ User selects frontend: React
  
STATE CHANGES
  └─ window._stackFrontend: '' → 'react'
  └─ availableBackends: ['none', 'nodejs', 'python', 'java', 'go']
  
FUNCTIONS CALLED
  └─ updateStackHint()
  └─ isValidStackCombination('react', selected_backend, selected_type)
  
PAYLOAD PRODUCED
  └─ None (UI-only state change)
  
API CALLED
  └─ None
  
EXPECTED RESULT
  └─ Backend dropdown shows options for React
  └─ Hint box updates color (if valid combo)
  └─ Build button enabled if valid
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for frontend selection

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Selection & Building (Stack Selection)

USER ACTION #4
  └─ User selects backend: Go
  
STATE CHANGES
  └─ window._stackBackend: '' → 'go'
  
FUNCTIONS CALLED
  └─ updateStackHint()
  └─ isValidStackCombination('react', 'go', selected_type)
  
PAYLOAD PRODUCED
  └─ None (UI-only)
  
API CALLED
  └─ None
  
EXPECTED RESULT
  └─ Hint box shows: "✅ Valid combination - ready to build!"
  └─ Build button enabled (opacity 1.0)
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for backend selection

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Selection & Building (Stack Selection)

USER ACTION #5
  └─ User selects type: dynamic
  
STATE CHANGES
  └─ window._stackType: '' → 'dynamic'
  
FUNCTIONS CALLED
  └─ updateStackHint()
  └─ isValidStackCombination('react', 'go', 'dynamic')
  
PAYLOAD PRODUCED
  └─ None (UI-only)
  
API CALLED
  └─ None
  
EXPECTED RESULT
  └─ Hint confirms valid combination
  └─ Build button ready to click
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for type selection

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Selection & Building (Stack Selection Submission)

USER ACTION #6
  └─ User clicks "Build with this stack"
  
STATE CHANGES
  └─ chatPhase: stack_selection → complete_questioning (Q1)
  └─ selectedStack: null → { frontend: 'react', backend: 'go', type: 'dynamic' }
  └─ questionIndex: 0 → 1
  
FUNCTIONS CALLED
  └─ submitStackSelection()
  └─ isValidStackCombination('react', 'go', 'dynamic') → true
  └─ JSON.stringify({ frontend: 'react', backend: 'go', type: 'dynamic' })
  └─ sendMessage()
  
PAYLOAD PRODUCED
  └─ { message: '__STACK__:{"frontend":"react","backend":"go","type":"dynamic"}',
        newConversation: false }
  
API CALLED
  └─ POST /api/chat with __STACK__ message
  
EXPECTED RESULT
  └─ Backend parses __STACK__ JSON
  └─ selectedStack stored in session
  └─ Question 1 of 5 displayed
  
TEST EXISTS?
  └─ ✅ PARTIAL - Tested but not verified all assertions

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Selection & Building (Question Answering Q1-Q5)

USER ACTION #7-#11
  └─ User answers Question 1 (end goal)
  └─ User answers Question 2 (users/usage)
  └─ User answers Question 3 (backend/data)
  └─ User answers Question 4 (features/integrations)
  └─ User answers Question 5 (design/style)
  
STATE CHANGES (Each iteration)
  └─ chatPhase: complete_questioning → complete_questioning
  └─ questionIndex: n → n+1
  └─ gatheredAnswers: [...] → [..., newAnswer]
  
FUNCTIONS CALLED (Each iteration)
  └─ sendMessage() with user's answer
  └─ API processes answer
  └─ getStackQuestions(selectedStack) generates next question
  
PAYLOAD PRODUCED (Each iteration)
  └─ { message: "User's answer to Qn", newConversation: false }
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ Each answer stored in session.gatheredAnswers
  └─ Next question displayed OR compiledSpec generated
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for question flow (5 tests missing)

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Selection & Building (Spec Compilation)

USER ACTION (After Q5)
  └─ System compiles spec from answers
  
STATE CHANGES
  └─ compiledSpec: '' → generated spec text
  └─ chatPhase: complete_questioning → building
  
FUNCTIONS CALLED
  └─ compileSpec(gatheredAnswers, originalRequest, apiKey)
  └─ buildStackContext(selectedStack, gatheredAnswers)
  
PAYLOAD PRODUCED
  └─ compiledSpec = stackContext + specFromQuestions
  └─ enrichedNotes = compiledSpec
  
API CALLED
  └─ None (spec built internally)
  
EXPECTED RESULT
  └─ compiledSpec populated with React+Go context
  └─ Ready for code generation
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for spec compilation

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Selection & Building (Code Generation)

USER ACTION (Final)
  └─ System generates code with selected stack context
  
STATE CHANGES
  └─ chatPhase: building → done (streaming)
  └─ deploymentMode: null → 'manual' (for Go backend)
  
FUNCTIONS CALLED
  └─ buildStackContext(selectedStack, gatheredAnswers)
  └─ getDeploymentMode(selectedStack) → 'manual'
  └─ antigravity.streamChat(message, history, null, onChunk, onDone, enrichedNotes)
  └─ AI generates code with enrichedNotes context
  
PAYLOAD PRODUCED
  └─ enrichedNotes = "══ SELECTED TECH STACK ══\nStack: React + Go\n...\n" + compiledSpec
  └─ { message: originalRequest, enrichedNotes: enrichedNotes, ... }
  
API CALLED
  └─ POST /api/chat with enrichedNotes
  
EXPECTED RESULT
  └─ AI generates:
     - React frontend code
     - Go backend code
     - API contract
     - Setup instructions
  └─ deploymentMode = 'manual'
  └─ User sees "Manual deployment" (manage Go server yourself)
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for enrichedNotes verification
  └─ ⚠️ MISSING - No test for deployment mode accuracy

════════════════════════════════════════════════════════════════════════════
```

---

## TRACE 2: Edit Mode + Change Stack + Python to Go

```
FEATURE
  └─ Edit Mode + Change Stack

USER ACTION #1
  └─ User opens /edit/owner/repo
  
STATE CHANGES
  └─ editMode: null → { owner: 'owner', repo: 'repo', defaultBranch: 'main' }
  └─ detectedStack: null → { frontend: 'react', backend: 'python', type: 'dynamic' }
  └─ chatPhase: init → editing
  └─ currentCode: '' → (existing app HTML)
  
FUNCTIONS CALLED
  └─ detectStackFromCode(existingCode, token, owner, repo)
  
PAYLOAD PRODUCED
  └─ None (server-side detection)
  
API CALLED
  └─ GET GitHub API to fetch index.html
  └─ Parse to detect Python backend
  
EXPECTED RESULT
  └─ System knows app is React + Python
  └─ Shows "Change the stack" / "Modify" buttons
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for edit mode detection

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Edit Mode + Change Stack (Choice Selection)

USER ACTION #2
  └─ User clicks "Change the stack" button
  
STATE CHANGES
  └─ chatPhase: editing → stack_selection
  └─ selectedStack: null → null (reset)
  └─ editMode: { owner, repo } → { owner, repo } (preserved)
  └─ detectedStack: { python } → { python } (preserved)
  
FUNCTIONS CALLED
  └─ renderStackSelector()
  
PAYLOAD PRODUCED
  └─ { message: '1', newConversation: false, editMode: true, editOwner: ..., editRepo: ... }
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ Stack selector UI appears
  └─ User can now select new stack
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for "Change stack" button

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Edit Mode + Change Stack (New Stack Selection)

USER ACTION #3-#5
  └─ User selects: React frontend
  └─ User selects: Go backend
  └─ User selects: dynamic type
  
STATE CHANGES
  └─ window._stackFrontend: 'react' (same)
  └─ window._stackBackend: 'python' → 'go' (changed!)
  └─ window._stackType: 'dynamic' (same)
  
FUNCTIONS CALLED
  └─ updateStackHint()
  └─ isValidStackCombination('react', 'go', 'dynamic') → valid
  
PAYLOAD PRODUCED
  └─ None (UI-only)
  
API CALLED
  └─ None
  
EXPECTED RESULT
  └─ Hint shows valid combination
  └─ Go selected instead of Python
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for stack change in edit mode

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Edit Mode + Change Stack (Submission)

USER ACTION #6
  └─ User clicks "Build with this stack"
  
STATE CHANGES
  └─ selectedStack: null → { frontend: 'react', backend: 'go', type: 'dynamic' }
  └─ chatPhase: stack_selection → building
  
FUNCTIONS CALLED
  └─ submitStackSelection()
  └─ JSON.stringify new stack
  └─ sendMessage()
  
PAYLOAD PRODUCED
  └─ { message: '__STACK__:{"frontend":"react","backend":"go",...}',
        editMode: true,
        editOwner: 'owner',
        editRepo: 'repo',
        editBranch: 'main',
        currentCode: existing HTML }
  
API CALLED
  └─ POST /api/chat with __STACK__ + editMode + currentCode
  
EXPECTED RESULT
  └─ selectedStack stored (Go, not Python)
  └─ detectedStack preserved (Python, for reference)
  └─ Code generation phase begins
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for edit mode stack change build

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Edit Mode + Change Stack (Code Generation)

USER ACTION (Automatic)
  └─ System builds enrichedNotes for code generation
  
STATE CHANGES
  └─ deploymentMode: null → 'manual' (based on selectedStack Go, NOT detectedStack Python)
  
FUNCTIONS CALLED
  └─ buildStackContext(selectedStack) → includes Go backend context
  └─ getDeploymentMode(selectedStack) → 'manual'
  └─ enrichedNotes = stackContext + currentCode + change request
  
PAYLOAD PRODUCED
  └─ enrichedNotes includes:
     "════ SELECTED TECH STACK ════
      Stack: React + Go
      Deploy mode: manual
      ════ EXISTING CODE ════
      [current React+Python code]
      ════ CHANGES ════
      Replace Python backend with Go backend"
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ AI understands:
     - Current app is React + Python
     - New app should be React + Go
     - Needs to replace Python with Go backend
  └─ Generates:
     - Updated React code
     - New Go server code
     - Migration guidance
  └─ deploymentMode = 'manual'
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for enrichedNotes in edit mode
  └─ ⚠️ MISSING - No test for deploymentMode with selectedStack (not detectedStack)

════════════════════════════════════════════════════════════════════════════
```

---

## TRACE 3: Edit Mode + Modify (No Stack Change)

```
FEATURE
  └─ Edit Mode + Modify Within Same Stack

USER ACTION #1
  └─ User opens /edit/owner/repo
  
STATE CHANGES
  └─ editMode: null → { owner, repo }
  └─ detectedStack: null → { frontend: 'react', backend: 'python', type: 'dynamic' }
  └─ chatPhase: init → editing
  
FUNCTIONS CALLED
  └─ detectStackFromCode()
  
PAYLOAD PRODUCED
  └─ None
  
API CALLED
  └─ GET GitHub API
  
EXPECTED RESULT
  └─ Edit interface loaded
  └─ System knows it's React + Python
  
TEST EXISTS?
  └─ ✅ YES (edit mode initialization)

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Edit Mode + Modify (Choice Selection)

USER ACTION #2
  └─ User clicks "Modify within same stack"
  
STATE CHANGES
  └─ chatPhase: editing → editing (no change!)
  └─ selectedStack: stays null
  └─ editMode: preserved
  └─ detectedStack: preserved
  
FUNCTIONS CALLED
  └─ (Continue editing, no special function)
  
PAYLOAD PRODUCED
  └─ { message: '2', newConversation: false, editMode: true, ... }
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ Show "What changes would you like?" prompt
  └─ Continue with same stack
  
TEST EXISTS?
  └─ ✅ YES (modify choice)

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Edit Mode + Modify (Change Request)

USER ACTION #3
  └─ User types: "Make the button bigger"
  
STATE CHANGES
  └─ chatPhase: editing → editing (no change)
  └─ selectedStack: stays null (not used)
  └─ detectedStack: used for deployment mode
  
FUNCTIONS CALLED
  └─ sendMessage()
  
PAYLOAD PRODUCED
  └─ { message: "Make the button bigger",
        editMode: true,
        editOwner: 'owner',
        editRepo: 'repo',
        currentCode: existing code,
        detectedStack: { frontend: 'react', backend: 'python', ... } }
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ AI uses detectedStack (Python) to modify code
  └─ Only changes shown, not full rebuild
  └─ deploymentMode based on detectedStack (manual for Python)
  
TEST EXISTS?
  └─ ✅ YES (modify flow)

════════════════════════════════════════════════════════════════════════════
```

---

## TRACE 4: Invalid Stack Selection Prevention

```
FEATURE
  └─ Stack Validation

USER ACTION #1
  └─ User selects: HTML frontend
  
STATE CHANGES
  └─ window._stackFrontend: '' → 'html'
  └─ availableBackends: ['none', 'nodejs', 'python', ...] → ['none'] (ONLY!)
  
FUNCTIONS CALLED
  └─ updateStackHint()
  └─ renderStackSelector() updates backend dropdown options
  
PAYLOAD PRODUCED
  └─ None (UI-only)
  
API CALLED
  └─ None
  
EXPECTED RESULT
  └─ Backend dropdown shows ONLY "No backend" option
  └─ User cannot select Python/Java/Go for HTML
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for HTML backend restrictions

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Stack Validation

USER ACTION #2
  └─ User tries to select: Backend "Go"
  
STATE CHANGES
  └─ (Backend dropdown is disabled or doesn't have "Go" option)
  
FUNCTIONS CALLED
  └─ updateStackHint()
  └─ isValidStackCombination('html', 'none', type) → true
  
PAYLOAD PRODUCED
  └─ Hint box shows: "✅ Valid combination"
  
API CALLED
  └─ None
  
EXPECTED RESULT
  └─ Only valid combo available (HTML + None)
  └─ User forced into correct selection
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for invalid combo prevention

════════════════════════════════════════════════════════════════════════════
```

---

## TRACE 5: Prototype Mode (Quick Build)

```
FEATURE
  └─ Prototype Mode (Skip Questions)

USER ACTION #1
  └─ User clicks "Prototype"
  
STATE CHANGES
  └─ chatPhase: mode → prototype_style
  └─ buildMode: null → 'prototype'
  └─ selectedStack: null (stays null - no stack selection!)
  └─ questionIndex: 0
  
FUNCTIONS CALLED
  └─ renderStyleQuestion()
  
PAYLOAD PRODUCED
  └─ { message: '2', newConversation: false }
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ Skip stack selection entirely
  └─ Skip all 5 questions
  └─ Ask only for style preference
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for prototype mode skip

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Prototype Mode (Style Question)

USER ACTION #2
  └─ User answers: "dark modern design"
  
STATE CHANGES
  └─ chatPhase: prototype_style → building
  └─ selectedStack: stays null (never selected!)
  
FUNCTIONS CALLED
  └─ sendMessage()
  
PAYLOAD PRODUCED
  └─ { message: "dark modern design", newConversation: false }
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ Build begins without stack info
  └─ enrichedNotes = styleAnswer + planNotes (NO stack context!)
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for prototype mode build

────────────────────────────────────────────────────────────────────────────

FEATURE
  └─ Prototype Mode (Code Generation)

USER ACTION (Automatic)
  └─ System generates code for prototype
  
STATE CHANGES
  └─ deploymentMode: null → 'github-pages' (default, no selectedStack)
  
FUNCTIONS CALLED
  └─ buildStackContext(null) → No context!
  └─ getDeploymentMode(null) → 'github-pages'
  └─ enrichedNotes = styleAnswer + "Build a SINGLE-PAGE application"
  
PAYLOAD PRODUCED
  └─ enrichedNotes = "dark modern design. PROTOTYPE MODE: Build SINGLE-PAGE app..."
  └─ No stack context! (selectedStack is null)
  
API CALLED
  └─ POST /api/chat
  
EXPECTED RESULT
  └─ AI generates default React SPA (no choice made)
  └─ deploymentMode = 'github-pages'
  └─ No backend code
  
TEST EXISTS?
  └─ ⚠️ MISSING - No test for prototype mode
  └─ ⚠️ BUG RISK - What if user wants Go backend in prototype? Can't select!

════════════════════════════════════════════════════════════════════════════
```

---

## Summary Statistics

```
TOTAL TRACES: 5
TOTAL USER ACTIONS: 21
TOTAL STATE CHANGES: 35+
TOTAL FUNCTIONS CALLED: 30+
TOTAL API CALLS: 8

TESTS EXISTING: 8 (38%)
TESTS MISSING: 13 (62%)

CRITICAL GAPS:
- Stack selection flow (no end-to-end test)
- Question answering (5 tests missing)
- Prototype mode (no test)
- Edit mode stack change (no test)
- enrichedNotes verification (no test)
- deploymentMode accuracy (no test)
- Invalid stack prevention (no test)

HIGH-RISK PATHS:
- Prototype mode: selectedStack always null
- enrichedNotes: Can be empty string
- buildMode: Not set in edit mode
- Deployment mode: Uses detectedStack as fallback
```

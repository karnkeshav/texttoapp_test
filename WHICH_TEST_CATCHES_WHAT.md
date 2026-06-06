# Which Test Type Catches Which Errors?

## The Button Error Case Study

**Error:** `onclick="sendMessage('1')"` but function is `sendMessage()` with no parameters

---

## Test Type vs Error Caught

| Test Type | Would Catch? | Why/Why Not |
|-----------|--------------|------------|
| **Smoke Tests** | ❌ NO | Only checks if code loads, not behavior |
| **Unit Tests** | ⚠️ MAYBE | Only if you test `sendMessage(buttonValue)` specifically |
| **Functional Tests** | ⚠️ MAYBE | Only if you test button click behavior |
| **E2E Tests** | ✅ **YES** | Tests full user workflows including button clicks |
| **UAT Tests** | ✅ **YES** | Tests business requirement "buttons must work" |
| **Integration Tests** | ⚠️ MAYBE | Only if you test HTML → JavaScript integration |
| **Black Box Tests** | ✅ **YES** | Tests external behavior "do buttons work?" |
| **Dry Run Tests** | ❌ NO | Only checks code quality, not behavior |

---

## What Each Test Type Should Catch

### ✅ Smoke Tests
Catches: Syntax errors, missing files, code won't load  
Misses: Logic errors, parameter issues, UI problems

### ✅ Unit Tests
Catches: Function logic errors, return value errors  
Should catch: Parameter handling (`sendMessage('1')`)  
Misses: UI interaction, integration issues

### ✅ Functional Tests
Catches: Feature logic errors, workflow problems  
Should catch: Button click response  
Misses: External behavior, integration

### ✅ E2E Tests (Real Browser)
**Should catch: Button errors, parameter issues, UI problems**  
Why: Tests complete workflow with actual browser interaction  
But ours didn't because: Tests were simulated, not real browser

### ✅ UAT Tests
**Should catch: Business requirement failures**  
Why: "Buttons must work" is a business requirement  
But ours didn't because: Only checked requirement was "defined," not "implemented"

### ✅ Integration Tests
**Should catch: HTML onclick → JavaScript interaction problems**  
Why: Tests how HTML and JavaScript components work together  
But ours didn't because: Focused on backend integration, not frontend

### ✅ Black Box Tests (Real Browser)
**Should catch: User-facing behavior issues**  
Why: Tests external behavior without code knowledge  
But ours didn't because: Tests were mocked, not real UI

### ✅ Dry Run Tests
Catches: Performance issues, memory leaks, infinite loops  
Misses: Behavioral issues, UI problems

---

## The Error Matrix

```
Error Type              | Unit | E2E | UAT | Integration | Black Box
─────────────────────────────────────────────────────────────────────
Syntax Error           |  ✅  |  ✅ |  ✅ |     ✅      |    ✅
Logic Error            |  ✅  |  ✅ |  ✅ |     ✅      |    ✅
Parameter Error        |  ⚠️  |  ✅ |  ✅ |     ✅      |    ✅
UI Button Error        |  ❌  |  ✅ |  ✅ |     ⚠️      |    ✅
Integration Error      |  ❌  |  ✅ |  ✅ |     ✅      |    ✅
Workflow Error         |  ❌  |  ✅ |  ✅ |     ❌      |    ✅
Performance Error      |  ❌  |  ❌ |  ❌ |     ❌      |    ❌
```

**For Button Error:** Should catch in E2E (if real browser) + UAT + Black Box (if real browser)

---

## Why Our Tests Missed It

### The Problem

We tested **backend logic** but the error was in **frontend interaction**

```
Backend (Node.js)              Frontend (Browser)
✅ Tested heavily              ❌ Not tested
✅ Stack detection works       ❌ Buttons don't work
✅ Type detection works        ❌ onclick handler broken
✅ All backends work           ❌ sendMessage() parameter issue
```

### The Gap

```
Our E2E Tests:
const workflow = new WorkflowSimulator();
workflow.clickModifyStack(); // ✅ Works in simulation
// But didn't test actual HTML button click!

Our Black Box Tests:
const system = new BlackBoxSystem();
system.handleButtonClickAndRespond('1'); // ✅ Mocked response
// But didn't test real browser UI!

Our Unit Tests:
// Only tested detectStack() logic
// Didn't test sendMessage(buttonValue) parameters
```

### The Lesson

**Real browser tests catch UI errors. Simulated tests don't.**

```
Simulated E2E:
✅ Tests business logic
❌ Doesn't test actual UI
❌ Doesn't test parameter passing
❌ Doesn't test DOM events

Real Browser E2E (Playwright/Puppeteer):
✅ Tests business logic
✅ Tests actual UI
✅ Tests parameter passing
✅ Tests DOM events
✅ Would have CAUGHT the button error!
```

---

## The Right Tool for Each Job

| Problem | Tool | Why |
|---------|------|-----|
| Logic error in function | Unit Test | Fast, isolated |
| Components don't work together | Integration Test | Tests interactions |
| User can't use the UI | E2E Test (Real Browser) | Simulates actual usage |
| Business requirement fails | UAT Test | Tests requirements |
| Code is slow | Dry Run Test | Measures performance |
| External behavior broken | Black Box Test (Real Browser) | Tests from outside |

**For Button Error:** Need **E2E with real browser** or **Black Box with real browser**

---

## Quick Reference: Which Test Catches What

```
┌────────────────────────────────────────────────────────┐
│ SYNTAX ERROR (code won't run)                          │
├────────────────────────────────────────────────────────┤
│ Caught by: Smoke Tests ✅                              │
│ Won't slip through: No, because code doesn't load     │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ LOGIC ERROR (function returns wrong value)             │
├────────────────────────────────────────────────────────┤
│ Caught by: Unit Tests, E2E Tests ✅                   │
│ Won't slip through: Probably not                      │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ PARAMETER ERROR (function called with wrong params)    │
├────────────────────────────────────────────────────────┤
│ Caught by: Unit Tests (if specific), E2E ✅           │
│ Won't slip through: Only if unit test wasn't written  │
│                                                        │
│ ⚠️ THIS IS WHAT HAPPENED TO US ⚠️                    │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ UI BUTTON ERROR (onclick handler doesn't work)         │
├────────────────────────────────────────────────────────┤
│ Caught by: E2E (Real Browser), Black Box (Real) ✅    │
│ Won't slip through: Only if tests are simulated ❌    │
│                                                        │
│ ⚠️ THIS IS WHAT HAPPENED TO US ⚠️                    │
│ (Our E2E and Black Box tests were simulated)         │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ INTEGRATION ERROR (components don't work together)     │
├────────────────────────────────────────────────────────┤
│ Caught by: Integration Tests, E2E Tests ✅            │
│ Won't slip through: Only if integration test missing  │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│ WORKFLOW ERROR (user can't complete action)           │
├────────────────────────────────────────────────────────┤
│ Caught by: E2E Tests (Real Browser), UAT ✅           │
│ Won't slip through: Only if E2E tests are simulated  │
│                                                        │
│ ⚠️ THIS IS WHAT HAPPENED TO US ⚠️                    │
└────────────────────────────────────────────────────────┘
```

---

## The Solution: Add Real Browser Tests

### What We Need

```javascript
// test-e2e-browser-real.js
// Using Playwright (real browser automation)

const { chromium } = require('playwright');

test('Button sends correct message value', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Go to actual page
  await page.goto('http://localhost:3000/edit/owner/repo');
  
  // Click actual button
  const button = await page.$('text=Change the stack');
  await button.click();
  
  // Verify actual behavior
  const response = await page.waitForResponse(
    r => r.url().includes('/api/chat')
  );
  const data = await response.json();
  
  // ✅ THIS WOULD HAVE CAUGHT THE ERROR
  expect(data.message).toBe('1');
  
  await browser.close();
});
```

**This test would have immediately caught the button error!**

---

## Summary

**Question:** Which test catches the button error?  
**Answer:** 
- ✅ **E2E Tests** (if using real browser, not simulation)
- ✅ **Black Box Tests** (if using real browser, not simulation)  
- ✅ **Unit Tests** (if you specifically test `sendMessage(buttonValue)`)
- ✅ **UAT Tests** (if verifying "buttons work" requirement)

**Why it wasn't caught:**
- ❌ Our E2E tests were **simulated** (WorkflowSimulator)
- ❌ Our Black Box tests were **mocked** (BlackBoxSystem)
- ❌ Our Unit tests **didn't test sendMessage() parameters**
- ❌ Our UAT tests checked **requirement was defined**, not **implemented**

**How to prevent this in the future:**
1. **Add real browser tests** using Playwright/Puppeteer
2. **Add parameter validation tests** in unit tests
3. **Test HTML onclick handlers** in integration tests
4. **Use actual browser automation**, not simulation


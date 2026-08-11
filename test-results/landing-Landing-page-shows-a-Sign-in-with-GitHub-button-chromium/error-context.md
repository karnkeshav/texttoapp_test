# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: landing.spec.js >> Landing page >> shows a "Sign in with GitHub" button
- Location: tests\e2e\landing.spec.js:18:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('a[href="/auth/github"]').first()
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('a[href="/auth/github"]').first()

```

```yaml
- navigation:
  - text: ⚡ AppBuilder
  - link "Features":
    - /url: "#capabilities"
  - link "How it works":
    - /url: "#how-it-works"
  - link "Packages":
    - /url: "#packages"
  - link "Sign In":
    - /url: /auth/google
    - img
    - text: Sign In
- text: Text-to-App Engine · Powered by Google Gemini AI
- heading "Give Your Ideas Wings. Build Your Custom App in 60 Seconds." [level=1]
- paragraph: No Code Required. No Developer. No Server. Just type what you want — and watch it come to life.
- link "Sign In with Google to Start Building":
  - /url: /auth/google
  - img
  - text: Sign In with Google to Start Building
- link "See what others are building ↓":
  - /url: "#use-cases"
- text: ✓ No technical skills needed ✓ Live app in under 60 seconds ✓ Your code, your property, forever AppBuilder — Text-to-App Engine Build a bank branch performance dashboard for our AGM meeting — regions, metrics, and a red/amber/green status. Excellent! A What you can do
- heading "Four Powerful Capabilities. One Platform." [level=2]
- paragraph: Your AppBuilder account unlocks everything below — analyse, convert, reason, and build — all from plain English conversation.
- text: 🔍 Analyse Images & Documents
- paragraph: Upload any image, PDF, spreadsheet, or report. Ask questions, extract insights, summarise, translate, or describe — instantly.
- text: "Example prompt: \"Analyse this 40-page contract and list every clause that puts us at risk.\" ✓ Images, PDFs, CSV, JSON ✓ Up to 10 MB per file ✓ Ask any follow-up question 📄 Premium Document Conversion"
- paragraph: Generate board-ready reports, professional decks, and structured spreadsheets in seconds. Every document formatted like a consultant prepared it.
- text: "Example prompt: \"Write a Q3 board report and convert it to a McKinsey-style PowerPoint, an Excel summary, and a signed-off Word document.\" ✓ Word, Excel, PowerPoint, PDF ✓ Professional consultant formatting ✓ Instant download 🧠 AI Research & Reasoning"
- paragraph: Deep reasoning for complex problems. Solve equations, research topics, draft proposals, analyse case studies — with a level of depth that rivals expert consultants.
- text: "Example prompt: \"Analyse the pros and cons of entering the Indian EV market in 2025, with a SWOT breakdown and competitor landscape.\" ✓ Strategic analysis & planning ✓ Academic & research support ✓ Maths, logic & reasoning 🚀 Build & Deploy Web Applications"
- paragraph: The centrepiece. Describe any software in plain English — our Text-to-App Engine designs, codes, and deploys a live, fully functional web application. No developer needed.
- text: "Example prompt: \"Build me an employee shift-scheduling tool with a live roster, export to Excel, and SMS reminders.\" ✓ Responsive, production-ready design ✓ Free GitHub Pages hosting — your own repo, live URL, free forever ✓ Edit, update & redeploy anytime 💡"
- strong: "Smart context switching:"
- text: Switch seamlessly between app building, document analysis, conversion, and research within one conversation. AppBuilder understands your intent and routes automatically. Text-to-App Engine
- heading "From Every Discipline. Every Dream." [level=2]
- paragraph:
  - text: From the classroom to the boardroom, and across every discipline imaginable — whether you are pursuing a Bachelor of Arts, mastering Medicine, navigating Law, finishing an MBA, engineering the future, or leading an enterprise. If you can imagine it, you can build it. Stop dreaming about the perfect software and start using it. You don't need a developer, a server, or a single line of code.
  - strong: Just type what you want, and our Text-to-App Engine instantly designs, codes, and deploys a live, fully functional web application.
- heading "What Will You Bring to Life Today?" [level=3]
- text: 🏦
- heading "Corporate & Operations" [level=4]
- paragraph: An AGM of a bank tracking regional metrics, or a railway employee streamlining complex shift and cargo schedules.
- text: 🏢
- heading "Founders & Agencies" [level=4]
- paragraph: Launch a fully functional SaaS dashboard, a client onboarding portal, or an automated lead-generation tool.
- text: 🛠️
- heading "Local Business & Services" [level=4]
- paragraph: A plumbing contractor's automated booking system, or a local bakery's live inventory and delivery form.
- text: 🎓
- heading "Students & Educators" [level=4]
- paragraph: An interactive study vault for your Master's thesis, a custom flashcard app for medical school, or a collaborative workspace for your engineering cohort.
- text: 🏡
- heading "Personal & Household" [level=4]
- paragraph: A dedicated home-maker organising family schedules and budgets, or your personal Indo-Chinese recipe hub.
- text: 🌐
- heading "Online Presence" [level=4]
- paragraph: A photographer's portfolio, a consultant's personal brand site, a startup's waitlist page — live and shareable in under a minute.
- img
- text: See How AppBuilder Works ▶
- paragraph: Video walkthrough coming soon. Subscribe to be notified when we go live.
- text: 🔒
- heading "Your Ideas, Completely Secured" [level=3]
- paragraph:
  - text: Why do we ask you to sign in? Your generated apps are your intellectual property. We use
  - strong: Google Authentication
  - text: to instantly create a private, encrypted workspace. Your code, your data, and your live links are securely saved and accessible only to you.
- link "⚡ Sign In securely with Google to Start Building":
  - /url: /auth/google
  - img
  - text: ⚡ Sign In securely with Google to Start Building
- paragraph: Launch your first app today. No credit card required to sign in.
- text: The Process
- heading "How the Text-to-App Engine Works" [level=2]
- paragraph: From your idea to a live application — in four steps, under sixty seconds.
- text: 01 🔑
- heading "Sign in with Google" [level=3]
- paragraph: One click creates your private, encrypted workspace. Your builds, your data, accessible only to you — secured by Google.
- text: 02 💬
- heading "Describe your application" [level=3]
- paragraph: Type what you need in plain English. Our engine asks intelligent follow-up questions to understand exactly what you want to build.
- text: 03 ⚡
- heading "The engine builds it" [level=3]
- paragraph: AppBuilder designs the UI, writes the code, handles the logic, and assembles a complete, production-ready web application — automatically.
- text: 04 🚀
- heading "It goes live instantly" [level=3]
- paragraph: Click publish. Your app gets a live URL you can share immediately. Edit it, improve it, rebuild it — as many times as you want.
- text: Pricing
- heading "Choose Your AppBuilder Plan" [level=2]
- paragraph: One-time software purchase. No hidden fees. Own your code forever.
- img
- strong: "Our recommendation:"
- text: Start with the
- emphasis: Test Drive
- text: if you want proof first. Move to
- emphasis: Professional Builder
- text: for the most complete, hands-off experience. Choose
- emphasis: Standard Builder
- text: if you're technical and want full ownership. DIY & Technical Standard Builder ₹ 5,000 One-Time Payment · Yours forever
- paragraph: Best for technical users who want complete control and zero ongoing costs.
- list:
  - listitem: ✓ Full lifetime access to the AppBuilder platform
  - listitem:
    - text: ✓
    - strong: Bring Your Own API Key
    - text: — use your Google Gemini API key (build 7–10 apps/day on the free tier, unlimited on paid)
  - listitem: ✓ Connect your GitHub account — hosting on GitHub Pages is yours at no cost
  - listitem: ✓ Premium Document Conversion — Word, Excel, PowerPoint, PDF with consultant-grade formatting
  - listitem: ✓ AI analysis, research, and reasoning — unlimited
  - listitem: ✓ Full source code ownership
- link "Get Started →":
  - /url: /auth/google
- text: ⭐ Most Popular Managed & Effortless Professional Builder ₹ 5,099 initial + ₹99 / month · Managed hosting included
- paragraph: Best for businesses, agencies & non-technical users who want an instant, professional live link — no setup, ever.
- list:
  - listitem: ✓ Everything in Standard Builder
  - listitem:
    - text: ✓
    - strong: We host it for you
    - text: — instant, secure
    - emphasis: .pages.dev
    - text: URL the second you click publish
  - listitem: ✓ Zero technical setup — no GitHub, no configuration, nothing
  - listitem:
    - text: ✓
    - strong: Bring Your Own API Key
    - text: or upgrade to our enterprise key
  - listitem: ✓ Premium Document Studio — McKinsey-style PowerPoint, board-ready Word reports, structured Excel
  - listitem: ✓ Priority email support
  - listitem: ✓ Unlimited apps & deploys
- link "Start Building →":
  - /url: /auth/google
- text: Zero Risk 5-Day Test Drive ₹ 1,999 One-Time Setup · 5-day full experience
- paragraph: Want to see the magic before managing your own API keys? Let us handle everything.
- list:
  - listitem:
    - text: ✓ We provide the software, our
    - strong: enterprise API key
    - text: ", and our premium hosting"
  - listitem:
    - text: ✓ Generate up to
    - strong: 10 complete applications per day
    - text: for 5 days
  - listitem: ✓ Premium Document Conversion included — Word, Excel, PowerPoint, PDF
  - listitem: ✓ All apps stay live during your trial period
  - listitem:
    - text: ★
    - strong: "Buyback Guarantee:"
    - text: Love it? Transition to Standard Builder (₹5,000) or Professional Builder (₹5,099 + ₹99/mo) — your setup fee is credited
- link "Enquire Now →":
  - /url: mailto:keshav.karn@gmail.com?subject=AppBuilder Test Drive&body=Hi, I'm interested in the 5-Day Test Drive (₹1,999). Please get me started.
- paragraph: "All plans include: AI analysis, document conversion, reasoning & research capabilities · GST applicable · Prices in Indian Rupees"
- heading "The AppBuilder Promise" [level=2]
- text: ⚡
- strong: Zero Coding
- text: You type. We build. No exceptions. 🔗
- strong: Instant Live Links
- text: Shareable URLs the moment you hit publish. ♾️
- strong: Yours to Keep Forever
- text: Full source code ownership. No lock-in. 📑
- strong: Premium Documents
- text: Word, Excel & PowerPoint that look consultant-made.
- contentinfo:
  - text: ⚡ AppBuilder
  - paragraph: Build apps · Analyse anything · Convert documents · Powered by Google Gemini
  - link "Sign In with Google":
    - /url: /auth/google
    - img
    - text: Sign In with Google
```

# Test source

```ts
  1  | // @ts-check
  2  | import { test, expect } from '@playwright/test';
  3  | 
  4  | /**
  5  |  * Landing page (public, no auth required) E2E tests.
  6  |  */
  7  | test.describe('Landing page', () => {
  8  |   test('loads with a 200 status', async ({ page }) => {
  9  |     const response = await page.goto('/');
  10 |     expect(response.status()).toBe(200);
  11 |   });
  12 | 
  13 |   test('has correct title', async ({ page }) => {
  14 |     await page.goto('/');
  15 |     await expect(page).toHaveTitle(/Ready4Launch/i);
  16 |   });
  17 | 
  18 |   test('shows a "Sign in with GitHub" button', async ({ page }) => {
  19 |     await page.goto('/');
  20 |     // There are multiple /auth/github links on the page (nav, hero, cards, footer).
  21 |     // Use .first() so the assertion targets the nav button without strict-mode violation.
  22 |     const githubBtn = page.locator('a[href="/auth/github"]').first();
> 23 |     await expect(githubBtn).toBeVisible();
     |                             ^ Error: expect(locator).toBeVisible() failed
  24 |   });
  25 | 
  26 |   test('unauthenticated visit to /app redirects away', async ({ page }) => {
  27 |     await page.goto('/app');
  28 |     // Should redirect to / (not /app) because the session is not authenticated
  29 |     await expect(page).not.toHaveURL(/\/app$/);
  30 |   });
  31 | 
  32 |   test('/auth/status returns authenticated:false for new session', async ({ request }) => {
  33 |     const res = await request.get('/auth/status');
  34 |     expect(res.status()).toBe(200);
  35 |     const data = await res.json();
  36 |     expect(data.authenticated).toBe(false);
  37 |   });
  38 | });
  39 | 
```
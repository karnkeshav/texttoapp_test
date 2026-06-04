'use strict';
/**
 * stackAdvisor.js
 *
 * Owns everything stack-specific for the Complete Product flow:
 *   - Question sets per stack (5 tailored questions replacing generic Q1-Q5)
 *   - Deployment mode (GitHub Pages vs localhost vs manual)
 *   - System-prompt injection (tells the AI which tech to use)
 *   - Dry-run validation (checks generated files before deploy)
 */

// ── Stack labels ─────────────────────────────────────────────────
const FRONTEND_LABELS = {
  html:     'HTML / CSS / Vanilla JS',
  react:    'React (CDN — no build step)',
  vue:      'Vue.js (CDN — no build step)',
  angular:  'Angular',
  svelte:   'Svelte',
  nextjs:   'Next.js',
  nuxtjs:   'Nuxt.js',
};

const BACKEND_LABELS = {
  none:     'No backend',
  nodejs:   'Node.js + Express',
  python:   'Python (FastAPI / Flask)',
  java:     'Java (Spring Boot)',
  csharp:   'C# (.NET)',
  php:      'PHP (Laravel)',
  go:       'Go',
  ruby:     'Ruby on Rails',
  rust:     'Rust',
};

const TYPE_LABELS = {
  static:   'Static Website',
  dynamic:  'Dynamic Web App',
  spa:      'Single Page App (SPA)',
  ssr:      'Server-Side Rendered (SSR)',
  pwa:      'Progressive Web App (PWA)',
  jamstack: 'JAMstack',
};

function getStackLabel(stack) {
  const fe = FRONTEND_LABELS[stack.frontend] || stack.frontend;
  const be = stack.backend && stack.backend !== 'none'
    ? ` + ${BACKEND_LABELS[stack.backend] || stack.backend}`
    : '';
  const ty = TYPE_LABELS[stack.type]
    ? ` [${TYPE_LABELS[stack.type]}]`
    : '';
  return `${fe}${be}${ty}`;
}

// ── Deployment mode ───────────────────────────────────────────────
/**
 * Returns 'github-pages' | 'local' | 'manual'
 * - github-pages: deployed to GitHub Pages (runs in browser)
 * - local: auto-launched via appRunner on localhost
 * - manual: needs developer setup (Python, Java etc.)
 */
function getDeploymentMode(stack) {
  const { frontend, backend, type } = stack;

  // Any real backend → local or manual
  if (backend && backend !== 'none') {
    if (backend === 'nodejs') return 'local';
    return 'manual'; // Python, Java, Go etc. need local dev environment
  }

  // SSR frameworks → local (need npm run dev)
  if (frontend === 'nextjs' || frontend === 'nuxtjs') return 'local';

  // Angular/Svelte → need build step → local
  if (frontend === 'angular' || frontend === 'svelte') return 'local';

  // React/Vue CDN, static HTML/CSS, PWA → GitHub Pages
  return 'github-pages';
}

// ── Tailored question sets ────────────────────────────────────────
/**
 * Returns 5 questions tailored to the chosen stack.
 * Each question is a markdown string (matches the existing COMPLETE_QUESTIONS style).
 */
function getStackQuestions(stack) {
  const { frontend, backend, type } = stack;
  const hasBackend = backend && backend !== 'none';
  const label = getStackLabel(stack);

  // ── Q1: always about the end goal / core job-to-be-done ──────────
  const q1 = `You've chosen **${label}**. Let's build this properly. 🎯

**Question 1 of 5 — End goal & core features:**
What does the user accomplish when they finish using this app?
- What's the main job-to-be-done? (e.g. "track expenses", "book appointments", "chat in real time")
- What are the 2–3 features that absolutely must work at launch?
- Is there any specific data or content the app needs to display or manage?`;

  // ── Q2: always about the users ────────────────────────────────────
  const q2 = `**Question 2 of 5 — Your users & usage context:**
Who will use this app, and how?
- Who is the target user? (e.g. "students aged 16–22", "small business owners", "internal team of 8")
- How often will they use it? (daily, occasionally, one-time)
- Mobile-first, desktop-first, or both?`;

  // ── Q3: stack-specific (data / state / backend design) ───────────
  let q3;
  if (hasBackend && backend === 'nodejs') {
    q3 = `**Question 3 of 5 — Backend & data design (Node.js + Express):**
- What data does the server need to store or manage? (users, products, posts…)
- Database preference: **MongoDB** (flexible JSON), **PostgreSQL** (relational), **SQLite** (lightweight, no setup), or in-memory only?
- Do users need to log in? (JWT auth, session-based, or no auth)
- Any REST API endpoints you already have in mind? (e.g. GET /api/posts, POST /api/users)`;
  } else if (hasBackend && backend === 'python') {
    q3 = `**Question 3 of 5 — Backend & data design (Python):**
- Framework preference: **FastAPI** (modern, async, auto-docs) or **Flask** (simple, minimal)?
- What data models do you need? (e.g. User, Product, Order — list the main ones)
- Database: **SQLite** (zero setup), **PostgreSQL**, **MongoDB**, or in-memory?
- Authentication required? (JWT, session, OAuth, or none)`;
  } else if (hasBackend) {
    q3 = `**Question 3 of 5 — Backend & data design (${BACKEND_LABELS[backend] || backend}):**
- What data does the server need to store or manage?
- Do users need to log in? What roles/permissions are needed?
- Any specific APIs or services to integrate with? (email, payments, file storage)
- How many concurrent users do you expect? (helps decide architecture)`;
  } else if (frontend === 'react' || frontend === 'vue') {
    q3 = `**Question 3 of 5 — State & data (${FRONTEND_LABELS[frontend]}):**
- Does the app need to persist data between sessions? (localStorage, sessionStorage, none)
- Will any data come from an external API? If so, which one?
- State management preference: **Context API + hooks** (simple), or **Redux/Pinia** (complex state)?
- Do you need routing (multiple pages/views)? If so, list the main routes.`;
  } else if (frontend === 'nextjs' || frontend === 'nuxtjs') {
    q3 = `**Question 3 of 5 — Data & rendering strategy (${FRONTEND_LABELS[frontend]}):**
- Will you fetch data at build time (SSG), request time (SSR), or client-side?
- Any API routes needed? What data do they return?
- Do you need a CMS or markdown-based content? (blog posts, documentation)
- Authentication? (NextAuth, Clerk, or custom)`;
  } else {
    q3 = `**Question 3 of 5 — Data & interactivity:**
- Does the app need to save or load any data? (localStorage, external API, none)
- What interactive elements are needed? (forms, modals, filters, real-time updates)
- Should any content be dynamic (fetched from an API) or is everything static?`;
  }

  // ── Q4: tech features (auth, integrations, performance) ─────────
  let q4;
  if (hasBackend) {
    q4 = `**Question 4 of 5 — Features & integrations:**
List any of these you need (say "none" for what doesn't apply):
- 🔐 **Authentication** — sign up / log in (email, Google OAuth, GitHub OAuth)
- 📧 **Email** — confirmation emails, notifications, contact forms
- 💳 **Payments** — checkout, subscriptions (Stripe, Razorpay)
- 📁 **File uploads** — images, documents, exports
- ⚡ **Real-time** — live chat, notifications (WebSockets)
- 🌐 **Third-party APIs** — maps, weather, social media, etc.`;
  } else if (type === 'pwa') {
    q4 = `**Question 4 of 5 — PWA features:**
- Should the app work **offline**? What content must be available without internet?
- Push notifications needed? What events trigger them?
- Home screen installation — should it look like a native app (full screen, no browser UI)?
- Any background sync required? (sync data when back online)`;
  } else {
    q4 = `**Question 4 of 5 — Technical requirements:**
Any specific requirements? (Say "none" for what doesn't apply)
- 🔐 Login / user accounts
- 💾 Save & load data (localStorage or external API)
- 📤 Export / download (CSV, PDF, image)
- 🔔 Notifications or alerts
- 🎨 Specific UI library (Tailwind, Bootstrap, Material UI, or custom)
- ♿ Accessibility requirements (WCAG, screen reader support)`;
  }

  // ── Q5: design & brand ───────────────────────────────────────────
  const q5 = `**Question 5 of 5 — Design, style & feel:**
Last one — help me get the visuals right:
- **Colour palette**: dark theme, light theme, or specific colours/brand? (hex codes welcome)
- **Design mood**: minimal & clean, bold & energetic, corporate, playful, luxury?
- **Typography**: modern sans-serif (Inter, Poppins), classic serif, monospace?
- **Any references**: name a site or app whose design you love (even rough ideas help)
- **Brand name/logo**: should any specific name or logo appear?`;

  return [q1, q2, q3, q4, q5];
}

// ── Build stack context for the AI ───────────────────────────────
/**
 * Builds the stack-specific section injected into enrichedNotes
 * so the AI generates the right technology.
 */
function buildStackContext(stack, answers) {
  const label       = getStackLabel(stack);
  const deployMode  = getDeploymentMode(stack);
  const hasBackend  = stack.backend && stack.backend !== 'none';

  const lines = [
    `══ SELECTED TECH STACK ══`,
    `Stack:       ${label}`,
    `Type:        ${TYPE_LABELS[stack.type] || stack.type}`,
    `Frontend:    ${FRONTEND_LABELS[stack.frontend] || stack.frontend}`,
    `Backend:     ${BACKEND_LABELS[stack.backend] || 'None'}`,
    `Deploy mode: ${deployMode}`,
    '',
    `══ STACK REQUIREMENTS ══`,
  ];

  // Framework-specific instructions
  if (stack.frontend === 'html') {
    lines.push(
      `• Generate vanilla HTML + JavaScript (no frameworks)`,
      `• Structure: Separate index.html, css/style.css, and js/app.js files`,
      `• Use plain JavaScript: DOM APIs, event listeners, fetch() for AJAX`,
      `• No external dependencies except Google Fonts for typography`,
      `• All styles in CSS file (no inline <style> blocks)`,
      `• All scripts in JS file (no inline <script> blocks — only <script src="js/app.js"></script> in HTML)`,
    );
  } else if (stack.frontend === 'react') {
    lines.push(
      `• Generate React 18 with JSX syntax (via CDN, no build step)`,
      `• REQUIRED: Load React, ReactDOM, and Babel from CDN for JSX transpilation`,
      `  - <script src="https://unpkg.com/react@18/umd/react.development.js"></script>`,
      `  - <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>`,
      `  - <script src="https://unpkg.com/babel-standalone@7/babel.min.js"></script>`,
      `• REQUIRED: Use <script type="text/babel"> for all React component code`,
      `• Use modern React hooks: useState, useEffect, useContext, useReducer`,
      `• Components: function App() { return (<JSX>); } — NOT class components`,
      `• JSX syntax is REQUIRED: Use <Component />, <div>, etc., not React.createElement()`,
    );
  } else if (stack.frontend === 'vue') {
    lines.push(
      `• Use Vue 3 via CDN`,
      `• Load: <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>`,
      `• Use Composition API (setup(), ref(), computed(), onMounted())`,
      `• Single-file component style is fine in the browser context`,
    );
  } else if (stack.frontend === 'nextjs') {
    lines.push(
      `• Generate a complete Next.js 14 project (App Router)`,
      `• package.json with: "dev": "next dev", "build": "next build", "start": "next start"`,
      `• Use TypeScript (tsconfig.json included)`,
      `• app/ directory structure (not pages/)`,
      `• Tailwind CSS unless user specified otherwise`,
    );
  } else if (stack.frontend === 'nuxtjs') {
    lines.push(
      `• Generate a complete Nuxt 3 project`,
      `• package.json with: "dev": "nuxt dev", "build": "nuxt build", "start": "nuxt start"`,
      `• Use Composition API (<script setup lang="ts">)`,
      `• auto-imports enabled (no need to import ref, computed etc.)`,
    );
  } else if (stack.frontend === 'angular') {
    lines.push(
      `• Generate a complete Angular 17 project structure`,
      `• Use standalone components (no NgModule where possible)`,
      `• package.json with: "start": "ng serve", "build": "ng build"`,
    );
  } else if (stack.frontend === 'svelte') {
    lines.push(
      `• Generate a complete SvelteKit project`,
      `• package.json with: "dev": "vite dev", "build": "vite build"`,
      `• Use .svelte files with <script>, <style>, template sections`,
    );
  }

  if (hasBackend) {
    if (stack.backend === 'nodejs') {
      lines.push(
        ``,
        `• Backend: Node.js + Express (CommonJS — require/module.exports)`,
        `• server.js is the entry point: const PORT = process.env.PORT || 3000`,
        `• package.json "start": "node server.js"`,
        `• app.use(express.static('public')) to serve the frontend`,
        `• All API routes return JSON via res.json()`,
      );
    } else if (stack.backend === 'python') {
      lines.push(
        ``,
        `• Backend: Python — use FastAPI (preferred) or Flask`,
        `• requirements.txt must list ALL dependencies`,
        `• Entry: main.py or app.py`,
        `• Include: README with "pip install -r requirements.txt && python main.py"`,
      );
    } else {
      lines.push(``, `• Backend: ${BACKEND_LABELS[stack.backend]} — follow standard conventions`);
    }
  }

  if (stack.type === 'pwa') {
    lines.push(
      ``,
      `• PWA requirements: manifest.json, service-worker.js for offline support`,
      `• Add <link rel="manifest" href="/manifest.json"> to HTML`,
      `• Register service worker in main JS file`,
    );
  }

  if (deployMode === 'github-pages') {
    lines.push(``, `• This app deploys to GitHub Pages — no server required, all client-side`);
  } else if (deployMode === 'local') {
    lines.push(``, `• This app runs on localhost — the user will npm install && npm start (or equivalent)`);
  }

  if (answers && answers.length) {
    lines.push(``, `══ USER REQUIREMENTS ══`);
    answers.forEach(({ q, a }, i) => {
      const label = q.match(/\*\*(Question \d+ of 5[^*]+)\*\*/)?.[1] || `Answer ${i+1}`;
      lines.push(`${label}: ${a}`);
    });
  }

  return lines.join('\n');
}

// ── Dry-run validation ────────────────────────────────────────────
/**
 * Checks generated files for obvious problems before deploy.
 * @param {Array<{path:string, content:string}>} files
 * @param {object} stack
 * @returns {{ passed: boolean, issues: string[], summary: string }}
 */
function runDryCheck(files, stack) {
  const issues = [];

  if (!files || files.length === 0) {
    return { passed: false, issues: ['No files were generated'], summary: '❌ No files generated' };
  }

  const paths = files.map(f => f.path);
  const hasBackend = stack && stack.backend && stack.backend !== 'none';

  // Check: HTML files have valid structure
  const htmlFiles = files.filter(f => f.path.endsWith('.html'));
  for (const hf of htmlFiles) {
    if (!hf.content.includes('<!DOCTYPE') && !hf.content.includes('<html')) {
      issues.push(`${hf.path}: missing <!DOCTYPE html> or <html> tag`);
    }
    if (!hf.content.includes('</html>') && !hf.content.includes('</body>')) {
      issues.push(`${hf.path}: appears to be truncated (no closing tags)`);
    }
  }

  // Check: package.json is valid JSON and has start script
  const pkgFile = files.find(f => f.path === 'package.json');
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content);
      if (!pkg.scripts?.start && !pkg.scripts?.dev) {
        issues.push('package.json: missing "start" or "dev" script');
      }
    } catch {
      issues.push('package.json: invalid JSON — cannot be parsed');
    }
  } else if (hasBackend && stack.backend === 'nodejs') {
    issues.push('Missing package.json for Node.js app');
  }

  // Check: server.js exists for Node.js apps
  if (hasBackend && stack.backend === 'nodejs') {
    const hasServer = paths.some(p => p === 'server.js' || p === 'index.js' || p === 'app.js');
    if (!hasServer) issues.push('Missing server entry file (server.js / index.js)');
  }

  // Check: React CDN files include Babel and React scripts
  if (stack?.frontend === 'react' && !pkgFile) {
    const hasReact = htmlFiles.some(f => f.content.includes('react') || f.content.includes('React'));
    if (!hasReact) issues.push('React CDN scripts appear to be missing from HTML');
  }

  // Check: no obviously empty files
  for (const f of files) {
    if (f.content.trim().length < 20) {
      issues.push(`${f.path}: suspiciously short (${f.content.trim().length} chars)`);
    }
  }

  const passed  = issues.length === 0;
  const summary = passed
    ? `✅ Dry run passed — ${files.length} file${files.length !== 1 ? 's' : ''} generated (${paths.join(', ')})`
    : `⚠️ Dry run found ${issues.length} issue${issues.length !== 1 ? 's' : ''}`;

  return { passed, issues, summary };
}

module.exports = {
  getStackLabel,
  getStackQuestions,
  getDeploymentMode,
  buildStackContext,
  runDryCheck,
  FRONTEND_LABELS,
  BACKEND_LABELS,
  TYPE_LABELS,
};

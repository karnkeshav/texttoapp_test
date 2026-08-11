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
  const { frontend, backend } = stack;
  if (backend && backend !== 'none') {
    // 'local' is attempted for every backend now — server/services/localRunCommands.js
    // has a real launch command for each of these. Java/C# need a JDK/.NET
    // toolchain present on the host to actually succeed; if it isn't, Run
    // Locally surfaces a clear "command not found" error rather than never
    // offering the option at all.
    return 'local';
  }
  if (frontend === 'nextjs' || frontend === 'nuxtjs') return 'local';
  if (frontend === 'angular' || frontend === 'svelte') return 'local';
  return 'github-pages';
}

function getRunCommand(stack) {
  switch (stack.backend) {
    case 'nodejs':  return 'npm install && npm start';
    case 'go':      return 'go run .';
    case 'python':  return 'pip install -r requirements.txt && python main.py';
    case 'ruby':    return 'bundle install && ruby app.rb';
    case 'php':     return 'php -S localhost:8080';
    case 'rust':    return 'cargo run';
    case 'java':    return 'mvn spring-boot:run  (or ./gradlew bootRun)';
    case 'csharp':  return 'dotnet run';
    default:        return null;
  }
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
Select any of these you need (reply with numbers e.g. 1, 4 or say "none"):
1. 🔐 **Authentication** — sign up / log in (email, Google OAuth, GitHub OAuth)
2. 📧 **Email** — confirmation emails, notifications, contact forms
3. 💳 **Payments** — checkout, subscriptions (Stripe, Razorpay)
4. 📁 **File uploads** — images, documents, exports
5. ⚡ **Real-time** — live chat, notifications (WebSockets)
6. 🌐 **Third-party APIs** — maps, weather, social media, etc.`;
  } else if (type === 'pwa') {
    q4 = `**Question 4 of 5 — PWA features:**
Select any of these you need (reply with numbers e.g. 1, 3):
1. **Offline support** — cache content for offline use
2. **Push notifications** — alert users when app updates
3. **Native app feel** — full screen without browser UI
4. **Background sync** — sync data when connection returns`;
  } else {
    q4 = `**Question 4 of 5 — Technical requirements:**
Select any of these you need (reply with numbers e.g. 1, 3 or say "none"):
1. 🔐 Login / user accounts
2. 💾 Save & load data (localStorage or external API)
3. 📤 Export / download (CSV, PDF, image)
4. 🔔 Notifications or alerts
5. 🎨 Specific UI library (Tailwind, Bootstrap, Material UI, or custom)
6. ♿ Accessibility requirements (WCAG, screen reader support)`;
  }

  // ── Q5: design & brand ───────────────────────────────────────────
  const q5 = `**Question 5 of 5 — Design, style & feel:**
Last one — help me get the visuals right:
1. **Colour palette**: dark theme, light theme, or specific colours/brand? (hex codes welcome)
2. **Design mood**: minimal & clean, bold & energetic, corporate, playful, luxury?
3. **Typography**: modern sans-serif (Inter, Poppins), classic serif, monospace?
4. **Any references**: name a site or app whose design you love (even rough ideas help)
5. **Brand name/logo**: should any specific name or logo appear?`;

  return [q1, q2, q3, q4, q5];
}

// ── Build stack context for the AI ───────────────────────────────
/**
 * Builds the stack-specific section injected into enrichedNotes
 * so the AI generates the right technology.
 */
function buildStackContext(stack, answers) {
  // 🔴 BUG FIX #2: Validate all required stack fields exist
  if (!stack || !stack.frontend || !stack.backend || !stack.type) {
    console.warn('[buildStackContext] Invalid stack:', stack);
    return '';
  }

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
    } else if (stack.backend === 'go') {
      lines.push(
        ``,
        `• Backend: Go, standard library net/http (or a minimal router)`,
        `• Entry: main.go at repo root, package main`,
        `• Read port from: os.Getenv("PORT") — default to 8080 if unset`,
        `• go.mod at root declaring the module`,
        `• http.FileServer to serve the public/ directory for the frontend`,
      );
    } else if (stack.backend === 'ruby') {
      lines.push(
        ``,
        `• Backend: Ruby, Sinatra (preferred for a single small app) or Rails`,
        `• Entry: app.rb at repo root`,
        `• Read port from: ENV['PORT'] — e.g. set :port, ENV['PORT'] || 4567`,
        `• Gemfile listing all dependencies`,
        `• Serve the public/ directory for the frontend (Sinatra does this by default from ./public)`,
      );
    } else if (stack.backend === 'php') {
      lines.push(
        ``,
        `• Backend: PHP, plain (no framework needed for a small app)`,
        `• Entry: index.php at repo root — the local runner uses PHP's built-in server (php -S), which controls the port directly, so do NOT hardcode a port anywhere`,
        `• composer.json only if you actually use a dependency`,
      );
    } else if (stack.backend === 'rust') {
      lines.push(
        ``,
        `• Backend: Rust, actix-web or axum (pick one, keep dependencies minimal)`,
        `• Entry: src/main.rs`,
        `• Read port from: std::env::var("PORT") — default to 8080 if unset`,
        `• Cargo.toml at root declaring all dependencies`,
      );
    } else if (stack.backend === 'java') {
      lines.push(
        ``,
        `• Backend: Java, Spring Boot`,
        `• Use Maven: pom.xml at root with spring-boot-starter-web, and the standard src/main/java/... layout`,
        `• Do NOT hardcode server.port in application.properties — the local runner passes --server.port on the command line, which overrides it`,
        `• Put frontend files in src/main/resources/static/ — Spring Boot serves that directory automatically with no extra code`,
      );
    } else if (stack.backend === 'csharp') {
      lines.push(
        ``,
        `• Backend: C#, ASP.NET Core minimal API`,
        `• A single .csproj at repo root (net8.0, Microsoft.NET.Sdk.Web) plus Program.cs`,
        `• Do NOT hardcode a URL/port in Program.cs — the local runner sets ASPNETCORE_URLS, which controls the port`,
        `• Put frontend files in wwwroot/ and call app.UseStaticFiles() — ASP.NET Core serves that directory automatically`,
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
  const { frontend, backend } = stack || {};

  // Validate JSON in package.json if present
  files.forEach(f => {
    if (f.path === 'package.json') {
      try {
        JSON.parse(f.content);
      } catch (e) {
        issues.push('Invalid JSON syntax in package.json');
      }
    }
  });

  // Check for HTML truncation across all html files
  files.forEach(f => {
    if (f.path.endsWith('.html')) {
      if (!/<\/html>/i.test(f.content) || !/<\/body>/i.test(f.content)) {
        issues.push(`${f.path}: HTML truncated — missing closing </html> tag`);
      }
    }
  });

  // Frontend validation
  if (frontend && frontend !== 'html') {
    const hasIndexHtml = files.some(f => f.path.endsWith('index.html'));

    if (!hasIndexHtml) {
      issues.push(`Frontend framework requires index.html in public/ or root`);
    }

    // Auto-heal hardcoded localhost URLs in JS/HTML files
    files.forEach(f => {
      if (f.path.endsWith('.js') || f.path.endsWith('.html')) {
        if (/http:\/\/(?:localhost|127\.0\.0\.1):\d+/i.test(f.content)) {
          f.content = f.content.replace(/http:\/\/(?:localhost|127\.0\.0\.1):\d+/gi, '');
          console.log(`[DryRun Auto-Heal] Stripped hardcoded localhost URL in ${f.path}`);
        }
      }
    });

    // Auto-heal Babel external src anti-pattern
    files.forEach(f => {
      if (f.path.endsWith('index.html')) {
        const babelMatch = f.content.match(/<script\s+type=["']text\/babel["'][^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/i);
        if (babelMatch) {
          const srcPath = babelMatch[1];
          const localFile = files.find(file => file.path === srcPath || file.path === 'public/' + srcPath || file.path.endsWith(srcPath));
          if (localFile && localFile.content) {
            f.content = f.content.replace(babelMatch[0], `<script type="text/babel">\n${localFile.content}\n</script>`);
            console.log(`[DryRun Auto-Heal] Inlined ${srcPath} into index.html <script type="text/babel">`);
          } else if (!srcPath.startsWith('http')) {
            issues.push(`Babel scripts must be inline (no src= attribute) — use <script type="text/babel">code...</script>`);
          }
        }
      }
    });

    // Framework-specific CDN checks (only for CDN/no-backend apps)
    if ((!backend || backend === 'none')) {
      if (frontend === 'react') {
        const indexFile = files.find(f => f.path.endsWith('index.html'));
        if (indexFile && !/react/i.test(indexFile.content)) {
          issues.push(`React SPA requires React CDN scripts in index.html`);
        }
      } else if (frontend === 'vue') {
        const indexFile = files.find(f => f.path.endsWith('index.html'));
        if (indexFile && !/vue/i.test(indexFile.content)) {
          issues.push(`Vue SPA requires Vue CDN script in index.html`);
        }
      }
    }
  }

  // Backend validation — check for required files based on backend type
  if (backend && backend !== 'none') {
    switch (backend.toLowerCase()) {
      case 'go':
        if (!files.some(f => f.path === 'go.mod' || f.path === 'go.sum')) {
          issues.push('Go backend requires go.mod at root');
        }
        if (!files.some(f => f.path === 'main.go' || f.path.endsWith('.go'))) {
          issues.push('Go backend requires at least one .go file at root');
        }
        // For React+Go: check that main.go serves public/
        if (frontend && frontend === 'react') {
          const hasPublicDir = files.some(f => f.path.startsWith('public/'));
          if (!hasPublicDir) {
            issues.push('React+Go requires frontend files in public/ directory');
          }
          const mainGoFile = files.find(f => f.path === 'main.go');
          if (mainGoFile && !mainGoFile.content.includes('public')) {
            issues.push('main.go must serve public/ directory as static files');
          }
        }
        break;

      case 'python':
        if (!files.some(f => f.path === 'main.py' || f.path === 'app.py' || f.path === 'server.py')) {
          issues.push('Python backend requires main.py, app.py, or server.py at root');
        }
        if (!files.some(f => f.path === 'requirements.txt')) {
          issues.push('Python backend requires requirements.txt for dependencies');
        }
        // For React+Python: check that main.py serves public/
        if (frontend && frontend === 'react') {
          const hasPublicDir = files.some(f => f.path.startsWith('public/'));
          if (!hasPublicDir) {
            issues.push('React+Python requires frontend files in public/ directory');
          }
          const mainPyFile = files.find(f => f.path === 'main.py' || f.path === 'app.py' || f.path === 'server.py');
          if (mainPyFile && !mainPyFile.content.includes('public')) {
            issues.push('Python backend must serve public/ directory as static files');
          }
        }
        break;

      case 'nodejs':
        const pkgFile = files.find(f => f.path === 'package.json');
        if (!pkgFile) {
          issues.push('Node.js backend requires package.json at root');
        } else {
          try {
            const pkg = JSON.parse(pkgFile.content);
            if (!pkg.scripts) pkg.scripts = {};
            if (!pkg.scripts.start && !pkg.scripts.dev) {
              const serverFile = files.find(f => f.path === 'server.js' || f.path === 'index.js' || f.path === 'app.js')?.path || 'server.js';
              pkg.scripts.start = `node ${serverFile}`;
              pkgFile.content = JSON.stringify(pkg, null, 2);
              console.log(`[DryRun Auto-Heal] Added "start": "node ${serverFile}" to package.json`);
            }
          } catch (e) {
            // Invalid JSON caught above
          }
        }
        if (!files.some(f => f.path === 'server.js' || f.path === 'index.js' || f.path === 'app.js')) {
          issues.push('Node.js backend requires server.js, index.js, or app.js at root');
        }
        break;

      case 'ruby':
        if (!files.some(f => f.path === 'Gemfile')) {
          issues.push('Ruby backend requires Gemfile at root');
        }
        if (!files.some(f => f.path === 'app.rb' || f.path === 'server.rb')) {
          issues.push('Ruby backend requires app.rb or server.rb at root');
        }
        break;

      case 'php':
        if (!files.some(f => f.path === 'index.php')) {
          issues.push('PHP backend requires index.php at root');
        }
        // composer.json is optional — the local runner only installs it if present,
        // and a dependency-free PHP app (served via `php -S`) never needs one.
        break;

      case 'rust':
        if (!files.some(f => f.path === 'Cargo.toml')) {
          issues.push('Rust backend requires Cargo.toml at root');
        }
        if (!files.some(f => f.path === 'src/main.rs')) {
          issues.push('Rust backend requires src/main.rs');
        }
        break;

      case 'java':
        if (!files.some(f => f.path === 'pom.xml') && !files.some(f => f.path === 'build.gradle' || f.path === 'build.gradle.kts')) {
          issues.push('Java backend requires pom.xml (Maven) or build.gradle (Gradle) at root');
        }
        break;

      case 'csharp':
        if (!files.some(f => f.path.endsWith('.csproj'))) {
          issues.push('C# backend requires a .csproj file at root');
        }
        break;
    }
  }

  // Truncation check — mismatched fences mean truncated output
  for (const f of files) {
    const opens  = (f.content.match(/^```\S*/gm) || []).length;
    const closes = (f.content.match(/^```\s*$/gm) || []).length;
    if (opens > closes) {
      issues.push(`${f.path}: output appears truncated (${opens} opening fences, ${closes} closing)`);
    }
  }

  const passed = issues.length === 0;
  const summary = passed
    ? `✅ All checks passed`
    : `⚠️ ${issues.length} issue${issues.length !== 1 ? 's' : ''} found`;

  return { passed, issues, summary };
}

module.exports = {
  getStackLabel,
  getStackQuestions,
  getDeploymentMode,
  getRunCommand,
  buildStackContext,
  runDryCheck,
  FRONTEND_LABELS,
  BACKEND_LABELS,
  TYPE_LABELS,
};

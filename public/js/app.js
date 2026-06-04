/* ── Ready4Launch chat interface ──────────────────────────────────── */

let isStreaming = false;
let isNewConversation = true;
// Track which welcome-card mode the user clicked (null = unset / 'build' / 'convert' / 'chat').
// Sent to the backend on the FIRST message so intent routing is always accurate.
let _welcomeMode = null;
const pendingFiles = new Map(); // fileId → { repoName, files }
let fileIdCounter = 0;
let _userAuthenticated = false; // set by loadUser(); controls welcome card visibility

// ── Deploy mode — always GitHub Pages ────────────────────────────
// All deployment goes through GitHub Pages. Cloudflare has been removed.
let deployMode = 'github';

// ── Edit mode state ───────────────────────────────────────────────
let editModeActive = null; // null | { owner, repo }

// ── Attachment state ──────────────────────────────────────────────
// pendingAttachment: null | { fileName, mimeType, data (base64), sizeLabel, isImage }
let pendingAttachment = null;

function openAttachPicker() {
  document.getElementById('attachInput').click();
}

function handleAttachmentSelected(input) {
  const file = input.files[0];
  if (!file) return;

  // 10 MB cap
  if (file.size > 10 * 1024 * 1024) {
    alert('File too large — maximum 10 MB.');
    input.value = '';
    return;
  }

  const isImage = file.type.startsWith('image/');
  const sizeLabel = file.size < 1024
    ? `${file.size} B`
    : file.size < 1024 * 1024
    ? `${(file.size / 1024).toFixed(1)} KB`
    : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;

  const reader = new FileReader();
  reader.onload = (e) => {
    // Strip the data-URI prefix to get raw base64
    const dataUrl = e.target.result;
    const base64  = dataUrl.split(',')[1];

    pendingAttachment = { fileName: file.name, mimeType: file.type, data: base64, sizeLabel, isImage, dataUrl };
    renderAttachPreview();
    document.getElementById('attachBtn').classList.add('has-file');
  };
  reader.readAsDataURL(file);

  // Reset so the same file can be re-selected if removed and re-added
  input.value = '';
}

function renderAttachPreview() {
  if (!pendingAttachment) return;
  const strip = document.getElementById('attachPreviewStrip');
  const inner = document.getElementById('attachPreviewInner');

  const { fileName, sizeLabel, isImage, dataUrl } = pendingAttachment;

  const thumb = isImage
    ? `<img src="${dataUrl}" alt="${escapeHtml(fileName)}" />`
    : `<div class="attach-chip-icon">📄</div>`;

  inner.innerHTML = `
    <div class="attach-chip">
      ${thumb}
      <span class="attach-chip-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
      <span class="attach-chip-size">${sizeLabel}</span>
      <button class="attach-chip-remove" onclick="clearAttachment()" title="Remove">✕</button>
    </div>`;

  strip.style.display = 'block';
}

function clearAttachment() {
  pendingAttachment = null;
  const strip = document.getElementById('attachPreviewStrip');
  strip.style.display = 'none';
  document.getElementById('attachPreviewInner').innerHTML = '';
  document.getElementById('attachBtn').classList.remove('has-file');
}

// ── Init ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await loadUser();
  autoResize(document.getElementById('chatInput'));
  updateWelcomeForMode();
});

// ── User profile — never redirects; app is open to all ───────────
async function loadUser() {
  const ghBanner   = document.getElementById('connectGithubBanner');
  const repoSection = document.getElementById('repoSection');
  const subEl      = document.getElementById('userSub');
  const avatarEl   = document.getElementById('userAvatar');
  const nameEl     = document.getElementById('userName');

  try {
    const res  = await fetch('/auth/status');
    const data = await res.json();

    if (!data.authenticated) {
      // No session — guest user. Show Google sign-in prompt in sidebar, NOT GitHub connect.
      if (avatarEl) avatarEl.textContent = '⚡';
      if (nameEl)   nameEl.textContent   = 'Ready4Launch';
      if (subEl)    subEl.textContent    = 'Sign in to get started';
      if (ghBanner) {
        ghBanner.style.display = 'block';
        ghBanner.innerHTML = `
          <div style="font-size:12px;font-weight:600;color:var(--purple-light);margin-bottom:4px;">👋 Welcome to Ready4Launch</div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:10px;">Sign in with Google to build and deploy apps — free.</div>
          <a href="/auth/google" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#fff;text-decoration:none;background:linear-gradient(135deg,#6366f1,#4f46e5);border-radius:7px;padding:6px 14px;">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
            Sign in with Google
          </a>`;
      }
      if (repoSection) repoSection.style.display = 'none';
      return;
    }

    const { login, name, avatarUrl } = data.user;
    const hasGitHub = !!data.hasGitHub;
    const hasGoogle = !!data.hasGoogle;

    if (avatarUrl) {
      if (avatarEl) avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${escapeHtml(name || login)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
    } else if (avatarEl) {
      avatarEl.textContent = (name || login || '?')[0].toUpperCase();
    }
    if (nameEl) nameEl.textContent = name || (hasGitHub ? `@${login}` : login);

    if (hasGitHub) {
      if (subEl)       subEl.textContent          = hasGoogle ? 'Google + GitHub connected' : 'GitHub connected';
      if (ghBanner)    ghBanner.style.display    = 'none';
      if (repoSection) repoSection.style.display = 'flex';
      loadUserRepos();
    } else {
      if (subEl)       subEl.textContent          = 'Connect GitHub to deploy to Pages';
      if (ghBanner)    ghBanner.style.display    = 'block';
      if (repoSection) repoSection.style.display = 'none';
    }

    // Show mode-selection cards for any authenticated user
    _userAuthenticated = true;
    showWelcomeCards();

    // ── Restore an unsaved build from a previous session ──────────
    // Show a non-intrusive resume banner on the welcome screen.
    // The same build also appears in My Account → Activity History
    // so the user can resume from either place.
    const pendingBuild = loadPendingBuild();
    if (pendingBuild) showResumeBuildBanner(pendingBuild);

  } catch {
    // Fail silently — app still usable without auth info
  }
}

// ── Adapt welcome screen copy to deploy mode ──────────────────────
function updateWelcomeForMode() {
  const topbarEl = document.getElementById('topbarSub');
  if (topbarEl) topbarEl.textContent = 'GitHub Pages — deploy to your own repo for free';
}


// ── Prompt bar visibility ────────────────────────────────────────
function hidePromptBar() {
  const bar = document.getElementById('chatInputArea');
  if (bar) bar.style.display = 'none';
}
function showPromptBar() {
  const bar = document.getElementById('chatInputArea');
  if (bar) bar.style.display = '';
}

// ── Welcome mode cards ────────────────────────────────────────────
// Canonical 4-card HTML (used both on first load and after "← Back")
function _welcomeCardsInnerHTML() {
  return `
    <div class="welcome-card" onclick="startWithMode('build')">
      <div class="welcome-card-icon">🏗️</div>
      <div class="welcome-card-title">Build an App</div>
      <div class="welcome-card-desc">Turn any idea into a full web app in minutes — just describe it in plain English</div>
    </div>
    <div class="welcome-card" onclick="startWithMode('convert')">
      <div class="welcome-card-icon">📄</div>
      <div class="welcome-card-title">Convert a Document</div>
      <div class="welcome-card-desc">Export content to Word, Excel, PowerPoint or PDF instantly</div>
    </div>
    <div class="welcome-card" onclick="startWithMode('chat')">
      <div class="welcome-card-icon">💬</div>
      <div class="welcome-card-title">Chat &amp; Analyse</div>
      <div class="welcome-card-desc">Ask anything, analyse data, research topics or get expert answers</div>
    </div>
    <div class="welcome-card" onclick="startWithMode('vision')">
      <div class="welcome-card-icon">🖼️</div>
      <div class="welcome-card-title">Analyse an Image</div>
      <div class="welcome-card-desc">Upload any photo or diagram for instant AI-powered visual analysis</div>
    </div>`;
}

function showWelcomeCards() {
  if (!_userAuthenticated) return;
  const cards = document.getElementById('welcomeCards');
  if (!cards) return;
  cards.innerHTML = _welcomeCardsInnerHTML();
  cards.style.display = 'grid';
  hidePromptBar();
}

/**
 * Called when a mode card is tapped.
 * 'build' → check GitHub is connected, then show prompt bar.
 * Others   → reveal prompt bar immediately with an appropriate placeholder.
 */
function startWithMode(mode) {
  // Remember which card the user clicked so we can pass it as a backend hint
  // on the first message (prevents "make me a resume" being routed to build mode).
  _welcomeMode = mode;
  const cards = document.getElementById('welcomeCards');

  if (mode === 'build') {
    // Check if GitHub is connected (deployMode stays 'github' but
    // hasGitHub drives the banner; check if the banner is hidden as proxy)
    const ghBanner = document.getElementById('connectGithubBanner');
    const ghConnected = ghBanner && ghBanner.style.display === 'none';

    if (!ghConnected) {
      // Not connected — show inline connect prompt instead of full redirect
      if (cards) {
        cards.innerHTML = `
          <div style="grid-column:1/-1;display:flex;align-items:center;gap:10px;margin-bottom:2px;">
            <button onclick="showWelcomeCards()" style="background:none;border:none;color:var(--text-3);font-size:13px;cursor:pointer;padding:2px 0;font-family:var(--font);display:flex;align-items:center;gap:4px;">&#8592; Back</button>
          </div>
          <div style="grid-column:1/-1;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:16px;padding:28px 24px;text-align:center;">
            <div style="font-size:36px;margin-bottom:14px;">🐙</div>
            <h3 style="font-size:17px;font-weight:700;margin-bottom:10px;">One last step — connect GitHub</h3>
            <p style="font-size:14px;color:var(--text-2);margin-bottom:8px;line-height:1.6;">
              Ready4Launch deploys your app directly to <strong>GitHub Pages</strong> — free, permanent, and owned by you.
            </p>
            <p style="font-size:13px;color:var(--text-3);margin-bottom:20px;">
              Open the <strong>☰ menu</strong> (top-left) and click <strong>"Connect GitHub"</strong> in the sidebar.
              <a href="/github-guide" target="_blank" style="color:var(--purple-light);text-decoration:none;margin-left:6px;">Step-by-step guide →</a>
            </p>
            <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:10px 20px;font-size:14px;color:var(--text-2);">
              ☰ Open sidebar → Connect GitHub
            </div>
          </div>`;
      }
      return;
    }

    // GitHub connected — go straight to prompt bar
    if (cards) cards.style.display = 'none';
    showPromptBar();
    const input = document.getElementById('chatInput');
    if (input) {
      input.placeholder = "Describe the app you want to build… (e.g. 'A recipe website with search and dark theme')";
      input.value = '';
      input.focus();
      autoResize(input);
    }
    return;
  }

  // Non-build modes — hide cards, show prompt bar
  if (cards) cards.style.display = 'none';
  showPromptBar();

  const placeholders = {
    convert: "Describe what to create — e.g. 'Make a PowerPoint about our Q1 results' or 'Convert this to a Word doc'",
    chat:    'Ask me anything — a question, analysis, research, or expert advice…',
    vision:  "What would you like to know about the image? (attach it with the 📎 button)",
  };

  const input = document.getElementById('chatInput');
  if (input) {
    input.placeholder = placeholders[mode] || 'Describe what you want…';
    input.value = '';
    input.focus();
    autoResize(input);
  }

  if (mode === 'vision') openAttachPicker();
}

// ── Resume last build banner ──────────────────────────────────────
// Shown on the welcome screen when an unsaved build is detected in localStorage.
function showResumeBuildBanner({ repoName, files, savedAt }) {
  const welcomeScreen = document.getElementById('welcomeScreen');
  if (!welcomeScreen) return;

  const ageMin = Math.round((Date.now() - savedAt) / 60000);
  const ageStr = ageMin < 60
    ? `${ageMin}m ago`
    : `${Math.round(ageMin / 60)}h ago`;

  const banner = document.createElement('div');
  banner.id = 'resumeBuildBanner';
  banner.style.cssText = `
    margin-top:16px;background:rgba(124,58,237,0.10);
    border:1px solid rgba(124,58,237,0.30);border-radius:12px;
    padding:16px 20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;`;
  banner.innerHTML = `
    <div style="flex:1;min-width:200px;">
      <div style="font-size:13px;font-weight:700;color:var(--purple-light);margin-bottom:3px;">
        🏗️ Unsaved build found — <em>${escapeHtml(repoName)}</em>
        <span style="font-weight:400;color:var(--text-3);font-size:12px;margin-left:6px;">${ageStr}</span>
      </div>
      <div style="font-size:12px;color:var(--text-2);">
        Your app was built but not deployed. Resume to push it to GitHub Pages.
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button id="resumeDeployBtn"
        style="background:var(--grad-main);color:#fff;border:none;border-radius:8px;
               padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);">
        🚀 Deploy it
      </button>
      <button id="resumeDismissBtn"
        style="background:none;border:1px solid var(--border);color:var(--text-3);
               border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:var(--font);">
        Discard
      </button>
    </div>`;

  welcomeScreen.appendChild(banner);

  banner.querySelector('#resumeDeployBtn').addEventListener('click', () => {
    banner.remove();
    showDeployPrompt(repoName, files);
  });
  banner.querySelector('#resumeDismissBtn').addEventListener('click', () => {
    clearPendingBuild();
    banner.remove();
  });
}

// ── New conversation ─────────────────────────────────────────────
function startNewConversation() {
  isNewConversation = true;
  editModeActive = null;

  const container = document.getElementById('chatMessages');
  container.innerHTML = `
    <div class="welcome-screen" id="welcomeScreen">
      <div class="welcome-icon">⚡</div>
      <h2 class="welcome-title">What do you want to build?</h2>
      <p class="welcome-sub">
        Describe any app or website in plain English. Ready4Launch will ask a few quick questions,
        then build and deploy your complete website — free.
      </p>
      <div class="welcome-cards-grid" id="welcomeCards" style="display:none;"></div>
      <div id="editModeBanner" style="display:none;background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.3);border-radius:10px;padding:12px 16px;font-size:13px;color:var(--purple-light);margin-top:12px;">
        ✏️ <strong>Edit mode</strong> — describe the changes to <span id="editModeBannerRepo"></span>
      </div>
    </div>`;

  // Show cards (and hide prompt bar) for signed-in users
  showWelcomeCards();

  document.getElementById('chatInput').placeholder = 'Describe the app you want to build…';
  document.getElementById('topbarSub').textContent = 'Describe your app to get started';
  closeSidebar();
  setStatus('Ready', false);

  // De-highlight any selected repo in sidebar
  document.querySelectorAll('.repo-item-btn').forEach(b => b.classList.remove('active'));
}

// ── Repo browser ──────────────────────────────────────────────────
let _allRepos = []; // cache for search filtering

async function loadUserRepos() {
  const list = document.getElementById('repoList');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:16px 0;color:var(--text-3);font-size:13px;">Loading…</div>';

  // Clear search box
  const searchEl = document.getElementById('repoSearch');
  if (searchEl) searchEl.value = '';

  try {
    const res  = await fetch('/api/github/repos');
    if (!res.ok) throw new Error('Failed');
    const repos = await res.json();
    _allRepos = repos; // cache all for filtering

    if (!repos.length) {
      list.innerHTML = '<div style="text-align:center;padding:16px 0;color:var(--text-3);font-size:13px;">No repositories yet.<br>Build your first app!</div>';
      return;
    }

    renderRepoList(repos);
  } catch {
    list.innerHTML = '<div style="text-align:center;padding:16px 0;color:var(--text-3);font-size:13px;">Could not load repos.</div>';
  }
}

function renderRepoList(repos) {
  const list = document.getElementById('repoList');
  if (!list) return;

  if (!repos.length) {
    list.innerHTML = '<div style="text-align:center;padding:12px 0;color:var(--text-3);font-size:13px;">No repos match.</div>';
    return;
  }

  list.innerHTML = repos.map(r => {
    const [owner, name] = r.fullName.split('/');
    const branch = escapeHtml(r.defaultBranch || 'main');
    return `
      <button class="repo-item-btn"
              data-owner="${escapeHtml(owner)}" data-repo="${escapeHtml(name)}" data-branch="${branch}"
              onclick="selectRepoForEdit('${escapeHtml(owner)}','${escapeHtml(name)}','${branch}')"
              style="width:100%;text-align:left;background:none;border:none;border-radius:8px;padding:8px 10px;cursor:pointer;color:var(--text-2);font-size:13px;display:flex;align-items:center;gap:8px;transition:background 0.15s,color 0.15s;"
              onmouseenter="this.style.background='var(--surface)';this.style.color='var(--text)'"
              onmouseleave="if(!this.classList.contains('active')){this.style.background='none';this.style.color='var(--text-2)'}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;opacity:0.6"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>
      </button>`;
  }).join('');
}

function filterRepos(query) {
  if (!_allRepos.length) return;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? _allRepos.filter(r => r.name.toLowerCase().includes(q) || r.fullName.toLowerCase().includes(q))
    : _allRepos;
  renderRepoList(filtered);
}

function selectRepoForEdit(owner, repo, defaultBranch) {
  // Reset conversation
  isNewConversation = true;
  editModeActive = { owner, repo, defaultBranch: defaultBranch || 'main' };

  // Update welcome banner
  const container = document.getElementById('chatMessages');
  // Re-render welcome with edit banner
  container.innerHTML = `
    <div class="welcome-screen" id="welcomeScreen">
      <div class="welcome-icon">✏️</div>
      <h2 class="welcome-title" style="font-size:clamp(20px,3vw,28px);">Editing: <span style="color:var(--purple-light);">${escapeHtml(repo)}</span></h2>
      <p class="welcome-sub">Describe the changes you want to make. Ready4Launch will fetch the current code, apply your changes, and push a new commit.</p>
    </div>`;

  // Update topbar
  document.getElementById('topbarSub').textContent = `Editing ${owner}/${repo}`;

  // Show prompt bar (it was hidden by the welcome card flow)
  showPromptBar();

  // Update input placeholder
  document.getElementById('chatInput').placeholder = `Describe your changes to ${repo}…`;
  document.getElementById('chatInput').focus();

  // Highlight selected repo in list
  document.querySelectorAll('.repo-item-btn').forEach(b => {
    const isSelected = b.dataset.owner === owner && b.dataset.repo === repo;
    b.classList.toggle('active', isSelected);
    b.style.background = isSelected ? 'var(--surface)' : 'none';
    b.style.color = isSelected ? 'var(--text)' : 'var(--text-2)';
  });

  closeSidebar();
  setStatus('Ready', false);
}

// ── Sidebar (mobile) ─────────────────────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

// ── Textarea auto-resize ─────────────────────────────────────────
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// ── Sending a message ─────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  // Allow send if there's text OR an attachment (or both)
  if ((!text && !pendingAttachment) || isStreaming) return;

  // Clear welcome screen on first message
  hideWelcome();

  // Show user message (with optional attachment preview)
  appendMessage('user', text, pendingAttachment);
  input.value = '';
  autoResize(input);

  // Snapshot and clear the attachment before the async call
  const attachment = pendingAttachment;
  clearAttachment();

  // Disable input while streaming
  setStreaming(true);

  // Placeholder AI bubble with typing indicator
  const aiMsgId = appendMessage('ai', null);

  try {
    const body = {
      message: text || '(see attached file)',
      newConversation: isNewConversation,
    };
    // Pass the welcome-card mode as a hint on the very first message so the backend
    // doesn't have to guess intent from keywords alone (e.g. "make me a resume"
    // should route to conversion, not the app-builder state machine).
    if (isNewConversation && _welcomeMode && _welcomeMode !== 'build') {
      body.modeHint = _welcomeMode;
    }
    _welcomeMode = null; // clear after first use regardless
    if (editModeActive) {
      body.editMode   = true;
      body.editOwner  = editModeActive.owner;
      body.editRepo   = editModeActive.repo;
      body.editBranch = editModeActive.defaultBranch || 'main';
    }
    if (attachment) {
      body.attachment = {
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        data:     attachment.data,
      };
    }

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    isNewConversation = false;

    // ── Package gate errors — handle before reading stream ────────
    if (!res.ok) {
      let errData = {};
      try { errData = await res.json(); } catch (_) {}

      if (errData.error === 'not_authenticated') {
        updateAIBubble(aiMsgId, '');
        showSignInWall();
      } else if (errData.error === 'no_package') {
        updateAIBubble(aiMsgId, '');
        showPricingModal();
      } else if (errData.error === 'package_expired') {
        updateAIBubble(aiMsgId,
          `⏰ **${errData.package === 'demo' ? 'Demo expired' : 'Subscription expired'}** — ` +
          `${errData.message} [View plans →](#plans)`
        );
        showPricingModal(errData.message);
      } else if (errData.error === 'daily_limit_reached') {
        updateAIBubble(aiMsgId,
          `🚫 **Daily limit reached** — ${errData.message}`
        );
        showDailyLimitBanner(errData);
      } else {
        updateAIBubble(aiMsgId, '⚠️ Something went wrong. Please try again.');
      }
      return; // stop — finally block handles setStreaming(false) + scrollToBottom
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let aiText = '';
    let buffer = '';

    let finalText = null; // set when 'done' event arrives

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (event.type === 'chunk') {
            aiText += event.text;
            updateAIBubble(aiMsgId, aiText);
          } else if (event.type === 'status') {
            setStatus(event.message, true);
          } else if (event.type === 'done') {
            aiText = event.text || aiText;
            updateAIBubble(aiMsgId, aiText);

            // ── Stack selector trigger ──────────────────────────────
            if (event.showStackSelector) {
              renderStackSelector(aiMsgId);
            }

            // ── Edit choice trigger ──────────────────────────────────
            if (event.showEditChoice) {
              renderEditChoice(aiMsgId);
            }

            // Carry context for post-stream handling
            if (event.editMode) {
              finalText = { text: aiText, editMode: true, editOwner: event.editOwner, editRepo: event.editRepo, editBranch: event.editBranch || 'main' };
            } else if (event.downloadable) {
              finalText = { text: aiText, downloadable: true, detectedFormat: event.detectedFormat || 'docx', pptPurpose: event.pptPurpose || null };
            } else if (event.build) {
              // Backend confirmed this is a build response — carry dry-run & deploy-mode hints
              finalText = { text: aiText, build: true, repoName: event.repoName || null, dryRun: event.dryRun || null, deployMode: event.deployMode || null };
            } else {
              finalText = aiText;
            }
          } else if (event.type === 'error') {
            updateAIBubble(aiMsgId, `⚠️ ${event.message}`);
          }
        } catch (_) {} // only protects JSON.parse — not checkForCode
      }
    }

    // Post-stream: deploy button / push-update / download options / generated image
    // Fallback: if the 'done' event was never parsed (JSON error on large payload),
    // use the accumulated chunk text so the deploy button still appears.
    if (finalText === null && aiText) finalText = aiText;

    if (finalText !== null) {
      if (finalText && typeof finalText === 'object' && finalText.editMode) {
        // Modified edit: treat as a build-like update, show deploy card for pushing changes
        checkForCode(finalText.text, null, null, null, {
          editMode: true,
          editOwner: finalText.editOwner,
          editRepo: finalText.editRepo,
          editBranch: finalText.editBranch
        });
      } else if (finalText && typeof finalText === 'object' && finalText.downloadable) {
        showDownloadOptions(aiMsgId, finalText.text, finalText.detectedFormat, finalText.pptPurpose);
      } else if (finalText && typeof finalText === 'object' && finalText.build) {
        // Backend confirmed build — pass server-side repoName hint and dry-run result
        checkForCode(finalText.text, finalText.repoName, finalText.dryRun, finalText.deployMode);
      } else {
        checkForCode(typeof finalText === 'string' ? finalText : finalText.text || '');
      }
    }
  } catch (err) {
    updateAIBubble(aiMsgId, '⚠️ Something went wrong. Please try again.');
    console.error(err);
  } finally {
    setStreaming(false);
    setStatus('Ready', false);
    scrollToBottom();
  }
}

// ── UI helpers ────────────────────────────────────────────────────
function hideWelcome() {
  const w = document.getElementById('welcomeScreen');
  if (w) w.remove();
}

let msgCounter = 0;
function appendMessage(role, text, attachment) {
  const id = `msg-${++msgCounter}`;
  const container = document.getElementById('chatMessages');
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.id = id;

  if (role === 'user') {
    // Build optional attachment HTML
    let attachHtml = '';
    if (attachment) {
      if (attachment.isImage) {
        attachHtml = `<div class="msg-attachment"><img src="${attachment.dataUrl}" alt="${escapeHtml(attachment.fileName)}" /></div>`;
      } else {
        attachHtml = `<div class="msg-attachment"><div class="msg-attachment-doc">📄 <span>${escapeHtml(attachment.fileName)}</span> <small style="color:var(--text-3)">${attachment.sizeLabel}</small></div></div>`;
      }
    }
    const textHtml = text ? `<div class="msg-bubble">${escapeHtml(text)}</div>` : '';
    div.innerHTML = `
      <div class="msg-avatar user">👤</div>
      <div class="msg-body">
        <div class="msg-meta">${now}</div>
        ${attachHtml}${textHtml}
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="msg-avatar ai">⚡</div>
      <div class="msg-body">
        <div class="msg-meta">Ready4Launch · ${now}</div>
        <div class="msg-bubble" id="${id}-bubble">
          ${text === null ? '<div class="typing-indicator"><span></span><span></span><span></span></div>' : renderMarkdown(text)}
        </div>
      </div>
    `;
  }

  container.appendChild(div);
  scrollToBottom();
  return id;
}

function updateAIBubble(msgId, text) {
  const bubble = document.getElementById(`${msgId}-bubble`);
  if (!bubble) return;
  bubble.innerHTML = renderMarkdown(text);
  scrollToBottom();
}

function scrollToBottom() {
  const c = document.getElementById('chatMessages');
  c.scrollTop = c.scrollHeight;
}

function setStreaming(active) {
  isStreaming = active;
  document.getElementById('sendBtn').disabled = active;
  document.getElementById('chatInput').disabled = active;
}

function setStatus(text, thinking = false) {
  document.getElementById('statusText').textContent = text;
  const dot = document.getElementById('statusDot');
  dot.className = 'status-dot' + (thinking ? ' thinking' : '');
}

// ── Code detection & auto-deploy ─────────────────────────────────
// hintRepoName — optional pre-parsed value from the backend done event (more reliable)
// dryRun      — { passed, issues, summary } from server-side validation
// deployMode  — 'github-pages' | 'local' | 'manual'
// editContext — { editMode, editOwner, editRepo, editBranch } for updating existing repos
function checkForCode(text, hintRepoName, dryRun, deployMode, editContext) {
  if (!text) return;

  // Extract REPO_NAME — prefer the server-side hint (more reliable than regex on large text)
  const repoMatch = text.match(/REPO_NAME:\s*([a-z0-9][a-z0-9\-]{1,48}[a-z0-9])/i);
  const repoName  = hintRepoName
    || (repoMatch ? repoMatch[1].toLowerCase() : null)
    || `r4l-${Date.now().toString(36)}`;

  const files = [];

  // ── Multi-file format: each block starts with a FILE: path comment ──
  // Matches ```html, ```css, ```javascript, ```js code blocks
  const BLOCK_RE = /```(html|css|javascript|js|json|typescript|ts|bash|sh|yaml|yml|env)\s*([\s\S]*?)```/gi;
  const FILE_COMMENT_RE = /^(?:<!--\s*FILE:\s*|\/\*\s*FILE:\s*|\/\/\s*FILE:\s*|#\s*FILE:\s*)([^\s*>]+)/i;

  let blockMatch;
  while ((blockMatch = BLOCK_RE.exec(text)) !== null) {
    const lang    = blockMatch[1].toLowerCase();
    const content = blockMatch[2].trim();
    if (!content || content.length < 10) continue;

    const firstLine = content.split('\n')[0];
    const pathMatch = FILE_COMMENT_RE.exec(firstLine);

    if (pathMatch) {
      // Strip the FILE: comment from the body
      const body = content.split('\n').slice(1).join('\n').trim();
      if (body.length >= 10) files.push({ path: pathMatch[1], content: body });
    } else {
      // No FILE: marker — fallback: use default path per language (legacy / single-file AI)
      const defaultPath = lang === 'html' ? 'index.html'
        : lang === 'css'                  ? 'css/style.css'
        :                                   'js/app.js';
      if (!files.find(f => f.path === defaultPath) && content.length >= 50) {
        files.push({ path: defaultPath, content });
      }
    }
  }

  // ── Fallback: truncated response — no closing ```, but HTML present ──
  if (!files.length) {
    const truncatedMatch = text.match(/```html\s*([\s\S]*?<\/html>)/i);
    if (truncatedMatch) {
      const content   = truncatedMatch[1].trim();
      const firstLine = content.split('\n')[0];
      const pathMatch = FILE_COMMENT_RE.exec(firstLine);
      if (pathMatch) {
        files.push({ path: pathMatch[1], content: content.split('\n').slice(1).join('\n').trim() });
      } else {
        files.push({ path: 'index.html', content });
      }
      console.warn('[Ready4Launch] HTML block had no closing ``` — used </html> as boundary');
    }
  }

  if (!files.length) return; // nothing useful to deploy

  showDeployPrompt(repoName, files, dryRun, deployMode, editContext);
}

// ── Download options card (conversion mode) ──────────────────────
const FORMAT_LABELS = {
  docx: { label: 'Word',        icon: '📝', ext: 'docx' },
  xlsx: { label: 'Excel',       icon: '📊', ext: 'xlsx' },
  pptx: { label: 'PowerPoint',  icon: '📑', ext: 'pptx' },
  pdf:  { label: 'PDF',         icon: '📄', ext: 'pdf'  },
  csv:  { label: 'CSV',         icon: '📋', ext: 'csv'  },
  json: { label: 'JSON',        icon: '🔧', ext: 'json' },
};

function showDownloadOptions(aiMsgId, content, detectedFormat, pptPurpose) {
  const bubble = document.getElementById(`${aiMsgId}-bubble`);
  if (!bubble) return;

  // Build card structure with DOM (never embed content in onclick attributes —
  // JSON.stringify produces double-quoted strings that break HTML attribute parsing)
  const card = document.createElement('div');
  card.className = 'download-card';

  const label = document.createElement('div');
  label.className = 'download-card-label';
  label.textContent = '⬇️ Download as';

  const row = document.createElement('div');
  row.className = 'download-format-row';

  const statusDiv = document.createElement('div');
  statusDiv.className = 'download-card-status';
  statusDiv.id = `dl-status-${aiMsgId}`;

  // Detected format goes first and gets the filled-purple style
  const allFormats = Object.entries(FORMAT_LABELS);
  const ordered = [
    ...allFormats.filter(([k]) => k === detectedFormat),
    ...allFormats.filter(([k]) => k !== detectedFormat),
  ];

  ordered.forEach(([fmt, { label: fmtLabel, icon }]) => {
    const btn = document.createElement('button');
    btn.className = `dl-format-btn${fmt === detectedFormat ? ' dl-format-btn--primary' : ''}`;
    btn.title = `Download as ${fmtLabel}`;
    btn.textContent = `${icon} ${fmtLabel}`;
    // Use addEventListener so the full content string is captured in a closure,
    // never serialised into an HTML attribute where quotes would break parsing.
    btn.addEventListener('click', () => downloadAs(btn, fmt, content, aiMsgId, pptPurpose));
    row.appendChild(btn);
  });

  card.appendChild(label);
  card.appendChild(row);
  card.appendChild(statusDiv);
  bubble.appendChild(card);
  scrollToBottom();
}

// aiMsgId is passed directly from showDownloadOptions — no fragile DOM traversal needed.
async function downloadAs(btn, format, content, aiMsgId, pptPurpose) {
  const statusEl = aiMsgId ? document.getElementById(`dl-status-${aiMsgId}`) : null;

  // Derive a filename from the first Markdown heading, fall back to "document"
  const headingMatch = content.match(/^#+ (.+)$/m);
  const filename = headingMatch
    ? headingMatch[1].replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 60)
    : 'document';

  btn.disabled = true;
  if (statusEl) statusEl.textContent = `Generating ${FORMAT_LABELS[format]?.label || format} file…`;

  try {
    const res = await fetch('/api/convert-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        format,
        filename,
        purposeKey: pptPurpose || undefined,
        userName: document.getElementById('userName')?.textContent?.trim() || undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${filename}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (statusEl) {
      statusEl.textContent = `✅ ${FORMAT_LABELS[format]?.label || format} downloaded!`;
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `⚠️ ${err.message}`;
    console.error('[downloadAs]', err);
  } finally {
    btn.disabled = false;
  }
}

// ── Push-update card (edit mode) ─────────────────────────────────
function showPushUpdatePrompt(fullText, owner, repo, branch) {
  // Extract the updated HTML from the AI response
  let htmlContent = null;
  const m = fullText.match(/```html\s*([\s\S]*?)```/i)
         || fullText.match(/```html\s*([\s\S]*?<\/html>)/i);
  if (m) htmlContent = m[1].trim();
  if (!htmlContent || htmlContent.length < 50) {
    // Fallback: show deploy button instead
    checkForCode(fullText);
    return;
  }

  const fileId = `fid-${++fileIdCounter}`;
  pendingFiles.set(fileId, { owner, repo, branch: branch || 'main', files: [{ path: 'index.html', content: htmlContent }] });

  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.style.cssText = 'padding:16px 0;max-width:780px;align-self:flex-start;width:100%;';
  div.innerHTML = `
    <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:14px;padding:24px;">
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">✅ Changes ready to push!</div>
      <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
        Ready4Launch has applied your changes to
        <strong style="color:#4ade80;">${escapeHtml(owner)}/${escapeHtml(repo)}</strong>.
        Push a new commit to update your live site.
      </p>
      <button data-fileid="${fileId}" onclick="pushUpdate(this.dataset.fileid, this)"
              style="background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;font-family:var(--font);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7-7 7 7"/></svg>
        Push update to GitHub
      </button>
    </div>`;
  container.appendChild(div);
  scrollToBottom();
}

async function pushUpdate(fileId, btn) {
  const pending = pendingFiles.get(fileId);
  if (!pending) return;

  btn.disabled = true;
  btn.innerHTML = '<span style="opacity:0.7">Pushing…</span>';

  // Clear any previous error message
  const card = btn.closest('div[style*="border-radius:14px"]');
  const existingErr = card && card.querySelector('.push-error-msg');
  if (existingErr) existingErr.remove();

  try {
    const res  = await fetch('/api/github/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner:  pending.owner,
        repo:   pending.repo,
        files:  pending.files,
        branch: pending.branch || 'main',
      }),
    });
    const data = await res.json();

    if (data.success) {
      card.innerHTML = `
        <div class="push-success">
          <h4>🎉 Update pushed!</h4>
          <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
            Your changes are live. GitHub Pages usually updates within ~60 seconds.
          </p>
          <p style="margin-bottom:8px;">
            🔗 <strong>Live site:</strong>
            <a href="${data.pagesUrl}" target="_blank" style="color:var(--purple-light);">${data.pagesUrl}</a>
          </p>
          <p style="margin-bottom:0;">
            📁 <strong>Repository:</strong>
            <a href="${data.repoUrl}" target="_blank" style="color:var(--purple-light);">${data.repoUrl}</a>
          </p>
        </div>`;
    } else {
      btn.disabled = false;
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7-7 7 7"/></svg> Retry push`;
      // Show error below the button — btn.closest('p') was null; find the card instead
      const errEl = document.createElement('p');
      errEl.className = 'push-error-msg';
      errEl.style.cssText = 'color:#f87171;font-size:13px;margin-top:10px;margin-bottom:0;';
      errEl.textContent = `⚠️ ${data.error || 'Push failed. Check that the repo still exists and try again.'}`;
      btn.insertAdjacentElement('afterend', errEl);
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7-7 7 7"/></svg> Retry push`;
    const errEl = document.createElement('p');
    errEl.className = 'push-error-msg';
    errEl.style.cssText = 'color:#f87171;font-size:13px;margin-top:10px;margin-bottom:0;';
    errEl.textContent = '⚠️ Network error — please check your connection and retry.';
    btn.insertAdjacentElement('afterend', errEl);
  }
  scrollToBottom();
}

// ── Unsaved build persistence ─────────────────────────────────────
// Saves the most-recently built (but not-yet-deployed) app to localStorage
// so it survives page reloads and server restarts without re-generating.
const PENDING_BUILD_KEY = 'r4l_pending_build';

function savePendingBuild(repoName, files) {
  try {
    localStorage.setItem(PENDING_BUILD_KEY, JSON.stringify({
      repoName, files, savedAt: Date.now(),
    }));
  } catch (_) {}
}

function clearPendingBuild() {
  try { localStorage.removeItem(PENDING_BUILD_KEY); } catch (_) {}
}

function loadPendingBuild() {
  try {
    const raw = localStorage.getItem(PENDING_BUILD_KEY);
    if (!raw) return null;
    const build = JSON.parse(raw);
    // Discard builds older than 24 hours
    if (!build.repoName || !build.files || Date.now() - build.savedAt > 86_400_000) {
      clearPendingBuild();
      return null;
    }
    return build;
  } catch (_) { return null; }
}

function showDeployPrompt(repoName, files, dryRun, deployMode, editContext) {
  // Persist so the user doesn't lose their build on refresh / server restart
  savePendingBuild(repoName, files);

  const fileId = `fid-${++fileIdCounter}`;
  const isEditMode = editContext && editContext.editMode;
  pendingFiles.set(fileId, { repoName, files, editContext });

  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.style.cssText = 'padding:16px 0;max-width:780px;align-self:flex-start;width:100%;';

  // ── Dry-run badge ─────────────────────────────────────────────
  let dryRunBadge = '';
  if (dryRun) {
    const col   = dryRun.passed ? '#4ade80' : '#fbbf24';
    const icon  = dryRun.passed ? '✅' : '⚠️';
    const issues = dryRun.issues?.length
      ? `<div style="margin-top:6px;font-size:12px;color:#fbbf24;">${dryRun.issues.map(i => `• ${escapeHtml(i)}`).join('<br>')}</div>`
      : '';
    dryRunBadge = `<div style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:20px;
      background:${dryRun.passed ? 'rgba(74,222,128,0.1)' : 'rgba(251,191,36,0.1)'};
      border:1px solid ${col};font-size:12px;color:${col};margin-bottom:14px;">
      ${icon} ${escapeHtml(dryRun.summary)}
    </div>${issues}`;
  }

  // ── CTA based on deploy mode or edit mode ─────────────────────
  let ctaLabel, ctaDesc;
  if (isEditMode) {
    ctaLabel = '🔄 Update & Push Changes';
    ctaDesc  = `Your modifications are ready. Push the updated code back to <strong>${editContext.editOwner}/${editContext.editRepo}</strong>.`;
  } else if (deployMode === 'local') {
    ctaLabel = '🚀 Push to GitHub + Launch Locally';
    ctaDesc  = `Ready4Launch will push your code to <strong>${repoName}</strong>, then automatically start the app in a new terminal window.`;
  } else if (deployMode === 'manual') {
    ctaLabel = '📁 Push to GitHub';
    ctaDesc  = `Your code will be pushed to <strong>${repoName}</strong>. Check the README for setup instructions specific to your stack.`;
  } else {
    ctaLabel = '🌐 Deploy to GitHub Pages';
    ctaDesc  = `Ready4Launch will create <strong>${repoName}</strong>, push your code, and enable GitHub Pages — your site will be live in ~2 minutes.`;
  }

  div.innerHTML = `
    <div style="background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.25);border-radius:14px;padding:24px;">
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">🚀 Your app is ready!</div>
      ${dryRunBadge}
      <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">${ctaDesc}</p>
      <button data-fileid="${fileId}" onclick="deployToGitHub(this.dataset.fileid, this)"
              style="background:var(--grad-main);color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;font-family:var(--font);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
        ${ctaLabel}
      </button>
    </div>
  `;
  container.appendChild(div);
  scrollToBottom();
}

async function deployToGitHub(fileId, btn) {
  const pending = pendingFiles.get(fileId);
  if (!pending) return;

  btn.disabled = true;

  const { repoName, files, editContext } = pending;
  const isEditMode = editContext && editContext.editMode;

  btn.innerHTML = `<span style="opacity:0.7">${isEditMode ? 'Pushing changes…' : 'Creating repo &amp; deploying…'}</span>`;

  try {
    // ── Choose endpoint based on mode ────────────────────────────
    const endpoint = isEditMode ? '/api/github/push' : '/api/github/deploy';
    const body = isEditMode
      ? {
          owner: editContext.editOwner,
          repo: editContext.editRepo,
          files,
          branch: editContext.editBranch || 'main'
        }
      : {
          repoName,
          files,
          description: `Built with Ready4Launch`
        };

    const res  = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const card = btn.closest('div[style]');

    if (res.status === 401) {
      // GitHub session expired — prompt reconnect
      card.innerHTML = `
        <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:12px;padding:20px;">
          <p style="margin:0 0 12px;font-weight:600;">⚠️ GitHub session expired</p>
          <p style="margin:0 0 16px;font-size:14px;color:var(--text-2);">Please reconnect your GitHub account to deploy.</p>
          <a href="/auth/github" style="display:inline-flex;align-items:center;gap:8px;background:var(--grad-main);color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;">
            🔗 Reconnect GitHub
          </a>
        </div>
      `;
      return;
    }

    if (data.success) {
      clearPendingBuild(); // successfully deployed — no need to resume this build later

      const isNodeApp = !!data.localUrl;
      const editSuccess = isEditMode;

      if (editSuccess) {
        // ── Edit success: show updated repo link ──────────────────
        card.innerHTML = `
          <div class="push-success">
            <h4>✅ Changes pushed successfully!</h4>
            <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
              Your modifications have been pushed to <strong>${editContext.editOwner}/${editContext.editRepo}</strong>.
              The updated app is now live.
            </p>
            <p style="margin-bottom:8px;">
              🔗 <strong>Repository:</strong>
              <a href="${data.repoUrl}" target="_blank" rel="noopener" style="color:var(--purple-light);">${data.repoUrl}</a>
            </p>
            <p style="margin-bottom:0;">
              🌐 <strong>Live Site:</strong>
              <a href="${data.pagesUrl}" target="_blank" rel="noopener" style="color:var(--purple-light);">${data.pagesUrl}</a>
            </p>
          </div>
        `;
        return;
      }

      if (isNodeApp) {
        // ── Node.js / full-stack app ──────────────────────────────
        card.innerHTML = `
          <div class="push-success">
            <h4>🚀 App launched locally!</h4>
            <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
              Your Node.js app has been saved, dependencies installed, and the server
              started in a new terminal window.
            </p>
            <p style="margin-bottom:8px;">
              🖥️ <strong>Local URL:</strong>
              <a href="${data.localUrl}" target="_blank" rel="noopener"
                style="color:#4ade80;font-weight:700;">${data.localUrl}</a>
              &nbsp;<span style="font-size:12px;color:var(--text-3);">(open in your browser)</span>
            </p>
            <p style="margin-bottom:8px;">
              📁 <strong>Source code:</strong>
              <a href="${data.repoUrl}" target="_blank" rel="noopener" style="color:var(--purple-light);">${data.repoUrl}</a>
            </p>
            <p style="font-size:12px;color:var(--text-3);margin-bottom:0;">
              💡 The app is also saved at <code style="background:var(--surface);padding:1px 5px;border-radius:4px;">generated-apps/${data.repoName}</code>
            </p>
          </div>
        `;
      } else {
        // ── Static / GitHub Pages app ─────────────────────────────
        const apkPromptId = `apk-prompt-${Date.now()}`;
        card.innerHTML = `
          <div class="push-success">
            <h4>🎉 Deployed to GitHub Pages!</h4>
            <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
              Your code is pushed and GitHub Pages is building the site.
              The live URL below is usually ready within <strong>2–5 minutes</strong> for a first deployment —
              if it shows a 404, wait a moment and refresh.
            </p>
            <p style="margin-bottom:8px;">
              🔗 <strong>Live URL:</strong>
              <a href="${data.pagesUrl}" target="_blank" rel="noopener" style="color:var(--purple-light);">${data.pagesUrl}</a>
            </p>
            <p style="margin-bottom:16px;">
              📁 <strong>Repository:</strong>
              <a href="${data.repoUrl}" target="_blank" rel="noopener" style="color:var(--purple-light);">${data.repoUrl}</a>
            </p>

            <!-- Android APK prompt -->
            <div id="${apkPromptId}" style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px;">
              <p style="font-size:13px;font-weight:600;margin-bottom:6px;">📱 Want this as an Android app?</p>
              <p style="font-size:12px;color:var(--text-3);margin-bottom:10px;">
                I can wrap your app in a native Android WebView and generate a project you can
                build into an APK — installable on any Android device.
              </p>
              <div style="display:flex;gap:8px;">
                <button onclick="buildAndroidApk('${apkPromptId}','${data.repoName}','${encodeURIComponent(data.repoName)}','${encodeURIComponent(data.pagesUrl)}')"
                  style="background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;border:none;
                         border-radius:8px;padding:8px 18px;font-size:12px;font-weight:700;
                         cursor:pointer;font-family:var(--font);">
                  Yes, create Android APK →
                </button>
                <button onclick="document.getElementById('${apkPromptId}').remove()"
                  style="background:none;border:1px solid var(--border);color:var(--text-3);
                         border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;
                         font-family:var(--font);">
                  No thanks
                </button>
              </div>
            </div>
          </div>
        `;
      }
    } else {
      btn.disabled = false;
      btn.textContent = 'Retry deployment';
      card.querySelector('p').textContent = `Error: ${data.error || 'Deployment failed'}`;
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Retry deployment';
    console.error('[Deploy] GitHub deploy error:', err);
  }
  scrollToBottom();
}

// ── Markdown → HTML (lightweight) ─────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Code blocks — stash with placeholders so bold/italic don't process their content
  const codeBlocks = [];
  html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Inline code — stash with placeholders
  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Bold / italic (safe now — code content is protected by placeholders)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Restore inline code, then code blocks
  inlineCodes.forEach((c, i) => { html = html.replace(`\x00IC${i}\x00`, c); });
  codeBlocks.forEach((b, i) => { html = html.replace(`\x00CB${i}\x00`, b); });

  // Numbered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Bullet lists
  html = html.replace(/((?:^[•\-\*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[•\-\*] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Paragraphs (double newlines)
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br/>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/<p>(<(?:h[123]|ul|ol|pre)>)/g, '$1');
  html = html.replace(/(<\/(?:h[123]|ul|ol|pre)>)<\/p>/g, '$1');

  return html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════════════════════════════
// Package gate UI — modals & banners
// ══════════════════════════════════════════════════════════════════

function removeModal() {
  document.getElementById('r4l-modal-overlay')?.remove();
}

function showSignInWall() {
  removeModal();

  // Detect whether this is a session expiry (user was signed in this page load)
  // vs a first-time visitor who was never authenticated.
  const sessionExpired = _userAuthenticated;
  const icon    = sessionExpired ? '🔄' : '⚡';
  const heading = sessionExpired ? 'Session expired' : 'Sign in to continue';
  const subtext = sessionExpired
    ? 'Your session has expired — this usually happens after a server restart. Please sign in again to continue.'
    : 'Create a free account to build and deploy apps with Ready4Launch.';
  const btnLabel = sessionExpired ? 'Sign in again with Google' : 'Continue with Google';

  const overlay = document.createElement('div');
  overlay.id = 'r4l-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
  overlay.innerHTML = `
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:20px;padding:40px 36px;max-width:420px;width:100%;text-align:center;">
      <div style="font-size:40px;margin-bottom:16px;">${icon}</div>
      <h2 style="font-size:22px;font-weight:700;margin-bottom:10px;">${heading}</h2>
      <p style="color:var(--text-2);font-size:15px;margin-bottom:28px;">${subtext}</p>
      <a href="/auth/google" style="display:inline-flex;align-items:center;gap:10px;background:#fff;color:#333;border:1px solid #ddd;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;text-decoration:none;margin-bottom:12px;width:100%;justify-content:center;">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        ${btnLabel}
      </a>
      <button onclick="removeModal()" style="background:transparent;border:none;color:var(--text-3);font-size:13px;cursor:pointer;margin-top:4px;">Maybe later</button>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) removeModal(); });
  document.body.appendChild(overlay);
}

async function showPricingModal(headline) {
  removeModal();

  // Fetch catalogue from server
  let plans = [];
  try {
    const r = await fetch('/api/user/packages');
    plans = await r.json();
  } catch (_) {}

  const overlay = document.createElement('div');
  overlay.id = 'r4l-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;overflow-y:auto;';

  const cardsHtml = plans.map(p => `
    <div style="flex:1;min-width:220px;background:${p.highlight ? 'linear-gradient(135deg,rgba(99,102,241,0.15),rgba(79,70,229,0.12))' : 'var(--surface-1)'};border:${p.highlight ? '2px solid #6366f1' : '1px solid var(--border)'};border-radius:16px;padding:28px 22px;position:relative;">
      ${p.highlight ? '<div style="position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-size:11px;font-weight:700;padding:4px 14px;border-radius:20px;white-space:nowrap;">MOST POPULAR</div>' : ''}
      <div style="font-size:17px;font-weight:700;margin-bottom:4px;">${escapeHtml(p.name)}</div>
      <div style="font-size:13px;color:var(--text-2);margin-bottom:16px;">${escapeHtml(p.tagline)}</div>
      <div style="font-size:28px;font-weight:800;margin-bottom:2px;">${escapeHtml(p.price)}</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:20px;">${escapeHtml(p.priceSub)}</div>
      <ul style="list-style:none;padding:0;margin:0 0 24px;font-size:13px;color:var(--text-2);">
        ${p.features.map(f => `<li style="padding:4px 0;">✓ ${escapeHtml(f)}</li>`).join('')}
      </ul>
      <button onclick="activatePackage('${p.id}',this)" style="width:100%;background:${p.highlight ? 'linear-gradient(135deg,#6366f1,#4f46e5)' : 'var(--surface-2)'};color:${p.highlight ? '#fff' : 'var(--text-1)'};border:${p.highlight ? 'none' : '1px solid var(--border)'};border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font);">
        ${escapeHtml(p.cta)}
      </button>
    </div>`).join('');

  overlay.innerHTML = `
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:24px;padding:40px 32px;max-width:860px;width:100%;">
      <div style="text-align:center;margin-bottom:32px;">
        <div style="font-size:36px;margin-bottom:12px;">🚀</div>
        <h2 style="font-size:24px;font-weight:800;margin-bottom:8px;">${escapeHtml(headline || 'Choose your Ready4Launch plan')}</h2>
        <p style="color:var(--text-2);font-size:15px;">Build, publish and deploy apps — pick the plan that fits.</p>
      </div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;justify-content:center;margin-bottom:20px;">${cardsHtml}</div>
      <div style="text-align:center;">
        <button onclick="removeModal()" style="background:transparent;border:none;color:var(--text-3);font-size:13px;cursor:pointer;">Maybe later</button>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) removeModal(); });
  document.body.appendChild(overlay);
}

async function activatePackage(packageId, btn) {
  btn.disabled = true;
  btn.textContent = 'Activating…';
  try {
    const res  = await fetch('/api/user/package', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ packageType: packageId }),
    });
    const data = await res.json();

    if (res.status === 401) {
      removeModal();
      showSignInWall();
      return;
    }
    if (data.success) {
      removeModal();
      // Show confirmation in chat
      const container = document.getElementById('chatMessages');
      const div = document.createElement('div');
      div.style.cssText = 'padding:16px 0;max-width:780px;align-self:flex-start;width:100%;';
      div.innerHTML = `
        <div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:14px;padding:20px;">
          <h4 style="margin:0 0 8px;font-size:16px;">🎉 ${escapeHtml(data.packageName)} activated!</h4>
          <p style="margin:0;font-size:14px;color:var(--text-2);">${escapeHtml(data.message)} You can now start building.</p>
        </div>`;
      container.appendChild(div);
      scrollToBottom();
    } else {
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  } catch (_) {
    btn.disabled = false;
    btn.textContent = 'Try again';
  }
}

function showDailyLimitBanner(errData) {
  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.style.cssText = 'padding:16px 0;max-width:780px;align-self:flex-start;width:100%;';
  div.innerHTML = `
    <div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:14px;padding:20px;">
      <p style="margin:0 0 12px;font-weight:600;font-size:15px;">🚫 Daily limit reached for <strong>${escapeHtml(errData.section || 'this section')}</strong></p>
      <p style="margin:0 0 16px;font-size:14px;color:var(--text-2);">
        You've used all <strong>${errData.limit}</strong> free ${escapeHtml(errData.section || '')} prompts for today on the Demo plan.
        Come back tomorrow, or upgrade for more.
      </p>
      <button onclick="showPricingModal('Upgrade to build more today')" style="background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font);">
        ⬆️ Upgrade plan
      </button>
    </div>`;
  container.appendChild(div);
  scrollToBottom();
}

// ── Quota Panel ───────────────────────────────────────────────────

let quotaPanelOpen   = false;
let quotaAutoRefresh = null;

const PROVIDER_META = {
  gemini:    { label: 'Gemini',    color: '#3b82f6', bg: 'rgba(59,130,246,0.1)',  border: 'rgba(59,130,246,0.25)'  },
  groq:      { label: 'Groq',      color: '#f97316', bg: 'rgba(249,115,22,0.1)',  border: 'rgba(249,115,22,0.25)'  },
  cerebras:  { label: 'Cerebras',  color: '#a855f7', bg: 'rgba(168,85,247,0.1)',  border: 'rgba(168,85,247,0.25)'  },
  sambanova: { label: 'SambaNova', color: '#22c55e', bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.25)'   },
};

function toggleQuotaPanel() {
  quotaPanelOpen = !quotaPanelOpen;
  const panel   = document.getElementById('quotaPanel');
  const overlay = document.getElementById('quotaOverlay');
  const btn     = document.getElementById('quotaBtn');
  if (quotaPanelOpen) {
    panel.style.display   = 'block';
    overlay.style.display = 'block';
    if (btn) { btn.style.borderColor='rgba(99,102,241,0.5)'; btn.style.background='rgba(99,102,241,0.14)'; }
    fetchQuotaData();
    quotaAutoRefresh = setInterval(fetchQuotaData, 30000);
  } else {
    panel.style.display   = 'none';
    overlay.style.display = 'none';
    if (btn) { btn.style.borderColor='rgba(99,102,241,0.25)'; btn.style.background='rgba(99,102,241,0.08)'; }
    if (quotaAutoRefresh) { clearInterval(quotaAutoRefresh); quotaAutoRefresh = null; }
  }
}

function refreshQuota() {
  const btn = document.getElementById('quotaRefreshBtn');
  if (btn) { btn.textContent = '↻'; btn.style.animation = 'qspin 0.75s linear infinite'; btn.disabled = true; }
  fetchQuotaData().finally(() => {
    if (btn) { btn.style.animation = ''; btn.textContent = '↻'; btn.disabled = false; }
  });
}

async function fetchQuotaData() {
  try {
    const res  = await fetch('/api/quota/status');
    const data = await res.json();
    renderQuotaPanel(data);
  } catch {
    const el = document.getElementById('quotaContent');
    if (el) el.innerHTML = `<div style="color:#f87171;font-size:12px;padding:32px 0;text-align:center;">
      Failed to load quota data.<br/><span style="color:var(--text-3)">Is the server running?</span></div>`;
  }
}

function renderQuotaPanel(data) {
  // ── Reset info ──────────────────────────────────────────────────
  const resetEl = document.getElementById('quotaResetInfo');
  if (resetEl && data.resetInfo) resetEl.textContent = data.resetInfo.resetLabel;

  // ── Health pills (header row) ──────────────────────────────────
  const pillsEl = document.getElementById('quotaHealthPills');
  if (pillsEl) {
    pillsEl.innerHTML = Object.entries(PROVIDER_META).map(([key, m]) => {
      const configured = data.configured?.[key];
      const models     = data.providers?.[key] || [];
      const anyDead    = models.some(x => x.slotStatus === 'dead');
      const anyCrit    = models.some(x => x.status === 'critical');
      const anyWarn    = models.some(x => x.status === 'warning');
      const dot = !configured ? '#64748b' : anyDead ? '#f87171' : anyCrit ? '#f87171' : anyWarn ? '#fbbf24' : '#4ade80';
      return `<div style="display:flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;
        font-size:10px;font-weight:600;color:${m.color};background:${m.bg};border:1px solid ${m.border};">
        <div style="width:5px;height:5px;border-radius:50%;background:${dot};flex-shrink:0;"></div>
        ${m.label}
      </div>`;
    }).join('');
  }

  // ── Main content ───────────────────────────────────────────────
  const content = document.getElementById('quotaContent');
  if (!content) return;

  const providers = ['gemini', 'groq', 'cerebras', 'sambanova'];
  let html = '';

  // Summary cards row (2×2 grid)
  html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">`;
  for (const key of providers) {
    const m          = PROVIDER_META[key];
    const configured = data.configured?.[key];
    const models     = data.providers?.[key] || [];
    const totalReq   = models.reduce((s, x) => s + (x.requestsUsed || 0), 0);
    const totalTok   = models.reduce((s, x) => s + (x.tokensUsed   || 0), 0);
    const maxPct     = models.reduce((max, x) => Math.max(max, x.percentUsed || 0), 0);
    const barColor   = maxPct > 90 ? '#f87171' : maxPct > 70 ? '#fbbf24' : m.color;
    const activeCount = models.filter(x => x.slotStatus === 'active').length;
    const totalSlots  = models.length;

    if (!configured) {
      html += `<div style="border-radius:11px;border:1px solid var(--border);padding:12px;
        background:rgba(255,255,255,0.01);opacity:0.45;">
        <div style="font-size:10px;font-weight:700;color:var(--text-3);letter-spacing:0.3px;margin-bottom:6px;">${m.label.toUpperCase()}</div>
        <div style="font-size:11px;color:var(--text-3);">Not configured</div>
        <div style="font-size:10px;color:var(--text-3);margin-top:2px;">Add API key to .env</div>
      </div>`;
      continue;
    }

    html += `<div style="border-radius:11px;border:1px solid ${m.border};padding:12px;background:${m.bg};cursor:pointer;"
      onclick="toggleQSection('qs-${key}')">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:700;color:${m.color};letter-spacing:0.4px;">${m.label.toUpperCase()}</div>
        <div style="font-size:9px;color:var(--text-3);">${activeCount}/${totalSlots} slots</div>
      </div>
      <div style="font-size:18px;font-weight:800;color:var(--text);letter-spacing:-0.5px;line-height:1;">
        ${totalReq > 0 ? totalReq.toLocaleString() : totalTok > 0 ? Math.round(totalTok/1000)+'K' : '0'}
      </div>
      <div style="font-size:9px;color:var(--text-3);margin-top:1px;margin-bottom:8px;">
        ${totalTok > 0 && totalReq === 0 ? 'tokens used today' : 'requests today'}
      </div>
      ${maxPct > 0 ? `<div class="qs-bar-bg"><div class="qs-bar-fill" style="width:${Math.min(maxPct,100)}%;background:${barColor};"></div></div>
      <div style="font-size:9px;color:var(--text-3);margin-top:3px;">${maxPct}% peak usage</div>` :
      `<div class="qs-bar-bg"><div class="qs-bar-fill" style="width:0%;background:${m.color};"></div></div>
      <div style="font-size:9px;color:var(--text-3);margin-top:3px;">0% used</div>`}
    </div>`;
  }
  html += `</div>`;

  // Separator
  html += `<div style="font-size:10px;font-weight:700;color:var(--text-3);letter-spacing:0.8px;
    text-transform:uppercase;margin-bottom:8px;padding-left:2px;">Model Breakdown</div>`;

  // Accordion sections per provider
  for (const key of providers) {
    const m          = PROVIDER_META[key];
    const configured = data.configured?.[key];
    const models     = data.providers?.[key] || [];
    if (!configured) continue;

    const anyIssue = models.some(x => x.slotStatus !== 'active' || x.status === 'critical' || x.status === 'warning');
    const chevron  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

    html += `<div class="qs-section" id="qs-${key}">
      <div class="qs-header" onclick="toggleQSection('qs-${key}')">
        <div style="display:flex;align-items:center;gap:7px;">
          <div style="width:7px;height:7px;border-radius:50%;background:${m.color};flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:600;color:var(--text);">${m.label}</span>
          ${anyIssue ? `<span style="font-size:9px;color:#fbbf24;font-weight:600;">⚠ check models</span>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;color:var(--text-3);">
          <span style="font-size:10px;">${models.length} models</span>
          <div id="qs-${key}-chev" style="transition:transform 0.2s;color:var(--text-3);">${chevron}</div>
        </div>
      </div>
      <div class="qs-body" id="qs-${key}-body" style="display:none;">`;

    for (const mdl of models) {
      const pct    = mdl.percentUsed || 0;
      const bar    = pct > 90 ? '#f87171' : pct > 70 ? '#fbbf24' : m.color;
      const icon   = mdl.slotStatus === 'dead'    ? `<span style="color:#f87171;font-size:10px;">✕</span>` :
                     mdl.slotStatus === 'cooling'  ? `<span style="color:#fbbf24;font-size:10px;">⏸</span>` :
                     mdl.status     === 'critical' ? `<span style="color:#f87171;font-size:10px;">●</span>` :
                     mdl.status     === 'warning'  ? `<span style="color:#fbbf24;font-size:10px;">●</span>` :
                                                     `<span style="color:#4ade80;font-size:10px;">●</span>`;

      // ── Prefer server-reported data (live from API) over local session counts ──
      const srv = mdl.serverReported;
      let usageStr, barPct, liveTag = '';

      if (srv) {
        // Real data from API response headers — shows actual remaining across ALL apps
        if (srv.remainingRequests !== null && srv.limitRequests !== null) {
          const used = srv.limitRequests - srv.remainingRequests;
          usageStr = `${used} / ${srv.limitRequests} req`;
          barPct   = Math.round((used / srv.limitRequests) * 100);
        } else if (srv.remainingTokens !== null && srv.limitTokens !== null) {
          const usedTok = srv.limitTokens - srv.remainingTokens;
          usageStr = `${Math.round(usedTok/1000)}K / ${Math.round(srv.limitTokens/1000)}K tok`;
          barPct   = Math.round((usedTok / srv.limitTokens) * 100);
        } else {
          usageStr = `${mdl.requestsUsed} req (local)`;
          barPct   = pct;
        }
        const when = new Date(srv.updatedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        liveTag = `<span style="font-size:8px;color:#4ade80;margin-left:4px;" title="Live from API at ${when}">●LIVE</span>`;
      } else {
        // Fallback: local session counts (this app only, resets on server restart)
        usageStr = mdl.tokensLimit
          ? `${Math.round(mdl.tokensUsed/1000)}K / ${Math.round(mdl.tokensLimit/1000)}K tok`
          : mdl.requestsLimit
          ? `${mdl.requestsUsed} / ${mdl.requestsLimit} req`
          : `${mdl.requestsUsed} req`;
        barPct = pct;
        liveTag = `<span style="font-size:8px;color:var(--text-3);margin-left:4px;" title="Local session count only — make an API call to get live data">●LOCAL</span>`;
      }

      const barColor2 = barPct > 90 ? '#f87171' : barPct > 70 ? '#fbbf24' : m.color;
      const short = mdl.model.length > 24 ? mdl.model.slice(0, 22) + '…' : mdl.model;
      const cooling = mdl.slotStatus === 'cooling' && mdl.coolingSecondsLeft > 0
        ? `<span style="font-size:9px;color:#fbbf24;"> ${mdl.coolingSecondsLeft}s</span>` : '';

      html += `<div class="qs-row">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
          ${icon}
          <div style="min-width:0;width:100%;">
            <div style="display:flex;align-items:center;">
              <span style="font-size:11px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;"
                title="${mdl.model}">${short}${cooling}</span>
              ${liveTag}
            </div>
            ${(mdl.requestsLimit || mdl.tokensLimit || srv) ? `<div class="qs-bar-bg" style="margin-top:2px;"><div class="qs-bar-fill" style="width:${Math.min(barPct||0,100)}%;background:${barColor2};"></div></div>` : ''}
          </div>
        </div>
        <div style="font-size:10px;color:var(--text-3);white-space:nowrap;margin-left:10px;flex-shrink:0;">${usageStr}</div>
      </div>`;
    }

    html += `</div></div>`; // close qs-body + qs-section
  }

  content.innerHTML = html;

  // Auto-open first provider section
  const firstKey = providers.find(k => data.configured?.[k]);
  if (firstKey) openQSection('qs-' + firstKey);
}

function toggleQSection(id) {
  const body = document.getElementById(id + '-body');
  const chev = document.getElementById(id + '-chev');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chev) chev.style.transform = isOpen ? '' : 'rotate(180deg)';
}

function openQSection(id) {
  const body = document.getElementById(id + '-body');
  const chev = document.getElementById(id + '-chev');
  if (!body) return;
  body.style.display = 'block';
  if (chev) chev.style.transform = 'rotate(180deg)';
}
// ── Android APK builder ───────────────────────────────────────────

async function buildAndroidApk(promptId, repoName, encodedAppName, encodedPagesUrl) {
  const promptEl = document.getElementById(promptId);
  if (!promptEl) return;

  const appName  = decodeURIComponent(encodedAppName);
  const pagesUrl = decodeURIComponent(encodedPagesUrl);

  // Show loading state
  promptEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
      <div style="width:16px;height:16px;border:2px solid rgba(34,197,94,0.3);
        border-top-color:#22c55e;border-radius:50%;animation:qspin 0.75s linear infinite;flex-shrink:0;"></div>
      <span style="font-size:13px;color:var(--text-2);">Generating Android project…</span>
    </div>`;

  try {
    const res  = await fetch('/api/android/build', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ repoName, appName, pagesUrl }),
    });
    const data = await res.json();

    if (!data.success) throw new Error(data.error || 'Build failed');

    const isApk  = data.type === 'apk';
    const label  = isApk ? '⬇️ Download APK' : '⬇️ Download Android Project (ZIP)';
    const note   = isApk
      ? 'APK built and ready — transfer to your Android device and install.'
      : 'Open this ZIP in <strong>Android Studio</strong> → Sync → Build → Generate APK.';

    promptEl.innerHTML = `
      <div style="border-top:1px solid var(--border);padding-top:14px;">
        <p style="font-size:13px;font-weight:600;color:#22c55e;margin-bottom:6px;">
          📱 Android project ready!
        </p>
        <p style="font-size:12px;color:var(--text-3);margin-bottom:10px;">${note}</p>
        <a href="${data.downloadUrl}" download="${data.fileName}"
          style="display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#22c55e,#16a34a);
                 color:#fff;text-decoration:none;border-radius:8px;padding:8px 18px;
                 font-size:12px;font-weight:700;font-family:var(--font);">
          ${label}
        </a>
        <p style="font-size:10px;color:var(--text-3);margin-top:8px;margin-bottom:0;">
          ${isApk ? `File: ${data.fileName}` : `ZIP contains: Kotlin source, Gradle files, AndroidManifest, res/ — open in Android Studio to build APK`}
        </p>
      </div>`;

  } catch (err) {
    promptEl.innerHTML = `
      <div style="border-top:1px solid var(--border);padding-top:12px;">
        <p style="font-size:12px;color:#f87171;margin:0;">
          ⚠️ Could not build Android project: ${err.message}
        </p>
      </div>`;
  }
  scrollToBottom();
}
// ── Stack selector UI ─────────────────────────────────────────────

const STACK_OPTIONS = {
  frontend: [
    { id: 'html',    label: 'HTML / CSS / Vanilla JS' },
    { id: 'react',   label: 'React' },
    { id: 'vue',     label: 'Vue.js' },
    { id: 'angular', label: 'Angular' },
    { id: 'svelte',  label: 'Svelte' },
    { id: 'nextjs',  label: 'Next.js' },
    { id: 'nuxtjs',  label: 'Nuxt.js' },
  ],
  backend: [
    { id: 'none',     label: 'No backend' },
    { id: 'nodejs',   label: 'Node.js + Express' },
    { id: 'python',   label: 'Python (FastAPI / Flask)' },
    { id: 'java',     label: 'Java (Spring Boot)' },
    { id: 'csharp',   label: 'C# (.NET)' },
    { id: 'php',      label: 'PHP (Laravel)' },
    { id: 'go',       label: 'Go' },
    { id: 'ruby',     label: 'Ruby on Rails' },
    { id: 'rust',     label: 'Rust' },
  ],
  type: [
    { id: 'static',   label: 'Static Website', desc: 'HTML/CSS only' },
    { id: 'dynamic',  label: 'Dynamic Web App', desc: 'Data changes from database' },
    { id: 'spa',      label: 'Single Page App (SPA)', desc: 'React, Angular, Vue' },
    { id: 'ssr',      label: 'Server-Side Rendered', desc: 'Next.js, Nuxt.js' },
    { id: 'pwa',      label: 'Progressive Web App', desc: 'Behaves like native app' },
    { id: 'jamstack', label: 'JAMstack', desc: 'Static frontend + APIs' },
  ],
};

function renderStackSelector(aiMsgId) {
  const bubble = document.getElementById(`${aiMsgId}-bubble`);
  if (!bubble) return;

  const card = document.createElement('div');
  card.className = 'stack-selector-card';
  card.style.cssText = `margin-top:16px;padding:20px;border-radius:12px;
    background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);font-family:var(--font);`;

  window._stackFrontend = 'html';
  window._stackBackend  = 'none';
  window._stackType     = 'static';

  const renderGroup = (label, options, varName) => {
    const opts = options.map(opt => `
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer;padding:6px 8px;border-radius:6px;">
        <input type="radio" name="${varName}" value="${opt.id}" onchange="window._stack${varName.charAt(0).toUpperCase()+varName.slice(1)}='${opt.id}'" style="cursor:pointer;margin:0;" ${opt.id === ('html'|'none'|'static') ? 'checked' : ''} />
        <span style="font-size:13px;color:var(--text-2);">${opt.label}</span>
      </label>
    `).join('');
    return `<div style="margin-bottom:14px;"><div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px;text-transform:uppercase;">${label}</div><div style="margin-left:4px;">${opts}</div></div>`;
  };

  card.innerHTML = `<div style="margin-bottom:16px;"><h3 style="margin:0 0 12px;font-size:14px;font-weight:700;">Choose Your Tech Stack</h3></div>
    ${renderGroup('Frontend Framework', STACK_OPTIONS.frontend, 'frontend')}
    ${renderGroup('Backend Server', STACK_OPTIONS.backend, 'backend')}
    ${renderGroup('Website Type', STACK_OPTIONS.type, 'type')}
    <button onclick="submitStackSelection('${aiMsgId}')" style="width:100%;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font);margin-top:12px;">Build with this stack →</button>`;

  bubble.appendChild(card);
  scrollToBottom();
}

function submitStackSelection(aiMsgId) {
  const frontend = window._stackFrontend || 'html';
  const backend  = window._stackBackend  || 'none';
  const type     = window._stackType     || 'static';
  const msg = `__STACK__:${JSON.stringify({ frontend, backend, type })}`;
  sendMessage(msg);
}
// ── Edit choice UI (Change stack vs Modify) ────────────────────────

function renderEditChoice(aiMsgId) {
  const bubble = document.getElementById(`${aiMsgId}-bubble`);
  if (!bubble) return;

  const card = document.createElement('div');
  card.style.cssText = `margin-top:16px;padding:20px;border-radius:12px;
    background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);font-family:var(--font);`;

  card.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
      <button onclick="sendMessage('1')"
        style="background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;border:none;border-radius:8px;
               padding:12px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font);
               transition:all 0.2s;display:flex;flex-direction:column;align-items:center;gap:6px;"
        onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">
        <span style="font-size:18px;">🔄</span>
        Change the stack
      </button>
      <button onclick="sendMessage('2')"
        style="background:linear-gradient(135deg,#8b5cf6,#7c3aed);color:#fff;border:none;border-radius:8px;
               padding:12px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:var(--font);
               transition:all 0.2s;display:flex;flex-direction:column;align-items:center;gap:6px;"
        onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">
        <span style="font-size:18px;">✨</span>
        Modify within same stack
      </button>
    </div>
  `;

  bubble.appendChild(card);
  scrollToBottom();
}
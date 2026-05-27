/* ── Ready4Launch chat interface ──────────────────────────────────── */

let isStreaming = false;
let isNewConversation = true;
const pendingFiles = new Map(); // fileId → { repoName, files }
let fileIdCounter = 0;
let _userAuthenticated = false; // set by loadUser(); controls welcome card visibility

// ── Deploy mode — set from URL param ?mode=cloudflare ────────────
// 'github'     → user arrived via /auth/github, deploy to GitHub Pages
// 'cloudflare' → user arrived via ?mode=cloudflare, instant managed deploy
// null         → direct access; deploy buttons show both options
const _urlMode = new URLSearchParams(window.location.search).get('mode');
let deployMode = (_urlMode === 'cloudflare') ? 'cloudflare'
               : (_urlMode === 'github')     ? 'github'
               : null; // will be resolved after auth check

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
      // No session — guest user
      if (avatarEl) avatarEl.textContent = '⚡';
      if (nameEl)   nameEl.textContent   = 'Ready4Launch';
      if (subEl)    subEl.textContent    = 'Connect GitHub to deploy apps';
      if (ghBanner)    ghBanner.style.display    = deployMode === 'cloudflare' ? 'none' : 'block';
      if (repoSection) repoSection.style.display = 'none';
      if (!deployMode) deployMode = 'cloudflare';
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
      deployMode = deployMode || 'github';
      if (subEl)       subEl.textContent          = hasGoogle ? 'Google + GitHub connected' : 'GitHub connected';
      if (ghBanner)    ghBanner.style.display    = 'none';
      if (repoSection) repoSection.style.display = 'flex';
      loadUserRepos();
    } else {
      if (deployMode === 'github') deployMode = 'cloudflare';
      if (!deployMode) deployMode = 'cloudflare';
      if (subEl)       subEl.textContent          = 'Connect GitHub to deploy to Pages';
      if (ghBanner)    ghBanner.style.display    = 'block';
      if (repoSection) repoSection.style.display = 'none';
    }

    // Show mode-selection cards for any authenticated user
    _userAuthenticated = true;
    showWelcomeCards();

  } catch {
    // Fail silently — app still usable without auth info
    if (deployMode === null) deployMode = 'cloudflare';
  }
}

// ── Adapt welcome screen copy to deploy mode ──────────────────────
function updateWelcomeForMode() {
  const titleEl  = document.getElementById('welcomeTitle');
  const subEl2   = document.getElementById('welcomeSub');
  const inputEl  = document.getElementById('chatInput');
  const topbarEl = document.getElementById('topbarSub');

  if (deployMode === 'cloudflare') {
    if (titleEl)  titleEl.textContent  = 'What do you want to build?';
    if (subEl2)   subEl2.textContent   = 'Describe your app in plain English. Ready4Launch will ask a few questions, build it, and publish it live — no GitHub account needed.';
    if (inputEl)  inputEl.placeholder  = 'Describe the app you want to build…';
    if (topbarEl) topbarEl.textContent = 'Instant Deploy — live link, no account needed';
  } else if (deployMode === 'github') {
    if (topbarEl) topbarEl.textContent = 'GitHub Pages mode — deploy to your repo';
  }
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
 * 'build' → show deploy-method sub-options first.
 * Others   → reveal prompt bar immediately with an appropriate placeholder.
 */
function startWithMode(mode) {
  if (mode === 'build') {
    _showBuildDeployOptions();
    return;
  }

  // Hide the cards, show the input bar
  const cards = document.getElementById('welcomeCards');
  if (cards) cards.style.display = 'none';
  showPromptBar();

  const placeholders = {
    convert: "Describe what to create — e.g. 'Convert my notes to a Word doc' or 'Make an Excel sales sheet'",
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

/**
 * Sub-options shown when the user picks "Build an App".
 * Lets them choose Instant Publish (Cloudflare) or GitHub Pages.
 */
function _showBuildDeployOptions() {
  const cards = document.getElementById('welcomeCards');
  if (!cards) return;

  const ghConnected = (deployMode === 'github');

  cards.innerHTML = `
    <div style="grid-column:1/-1;display:flex;align-items:center;gap:10px;margin-bottom:2px;">
      <button onclick="showWelcomeCards()" style="background:none;border:none;color:var(--text-3);font-size:13px;cursor:pointer;padding:2px 0;font-family:var(--font);display:flex;align-items:center;gap:4px;transition:color 0.2s;" onmouseenter="this.style.color='var(--text)'" onmouseleave="this.style.color='var(--text-3)'">&#8592; Back</button>
      <span style="font-size:13px;font-weight:600;color:var(--text-2);">How do you want to deploy?</span>
    </div>
    <div class="welcome-card" onclick="selectBuildDeploy('cloudflare')">
      <div class="welcome-card-icon">⚡</div>
      <div class="welcome-card-title">Instant Publish</div>
      <div class="welcome-card-desc">No GitHub needed — your app goes live in seconds on our managed hosting</div>
    </div>
    <div class="welcome-card" onclick="selectBuildDeploy('github')">
      <div class="welcome-card-icon">🐙</div>
      <div class="welcome-card-title">GitHub Pages</div>
      <div class="welcome-card-desc">${ghConnected
        ? 'Deploy to your own GitHub repo — free forever, full control'
        : 'Connect GitHub to deploy your app to GitHub Pages for free'}</div>
    </div>`;
}

/**
 * User picked a deploy method from the Build App sub-screen.
 */
function selectBuildDeploy(mode) {
  if (mode === 'github' && deployMode !== 'github') {
    // GitHub not connected yet — redirect to connect flow
    window.location.href = '/auth/github';
    return;
  }

  deployMode = mode;
  const cards = document.getElementById('welcomeCards');
  if (cards) cards.style.display = 'none';
  showPromptBar();

  const input = document.getElementById('chatInput');
  if (input) {
    input.placeholder = "Describe the app you want to build… (e.g. 'A recipe website with search and dark theme')";
    input.value = '';
    input.focus();
    autoResize(input);
  }
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
            // Carry context for post-stream handling
            if (event.editMode) {
              finalText = { text: aiText, editMode: true, editOwner: event.editOwner, editRepo: event.editRepo, editBranch: event.editBranch || 'main' };
            } else if (event.downloadable) {
              finalText = { text: aiText, downloadable: true, detectedFormat: event.detectedFormat || 'docx' };
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
    if (finalText !== null) {
      if (finalText && typeof finalText === 'object' && finalText.editMode) {
        showPushUpdatePrompt(finalText.text, finalText.editOwner, finalText.editRepo, finalText.editBranch);
      } else if (finalText && typeof finalText === 'object' && finalText.downloadable) {
        showDownloadOptions(aiMsgId, finalText.text, finalText.detectedFormat);
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
function checkForCode(text) {
  if (!text) return;

  // 1. Try a complete ```html … ``` block (normal case)
  let htmlContent = null;
  const completeMatch = text.match(/```html\s*([\s\S]*?)```/i);
  if (completeMatch) {
    htmlContent = completeMatch[1].trim();
  }

  // 2. Fallback: response was truncated — no closing ```, but HTML is still present.
  //    Accept anything from ```html up to the last </html> in the text.
  if (!htmlContent) {
    const truncatedMatch = text.match(/```html\s*([\s\S]*?<\/html>)/i);
    if (truncatedMatch) {
      htmlContent = truncatedMatch[1].trim();
      console.warn('[Ready4Launch] HTML block had no closing ``` — used </html> as boundary');
    }
  }

  if (!htmlContent || htmlContent.length < 50) return; // nothing useful to deploy

  // Extract REPO_NAME (e.g. "REPO_NAME: portfolio-site")
  const repoMatch = text.match(/REPO_NAME:\s*([a-z0-9][a-z0-9\-]{1,48}[a-z0-9])/i);
  const repoName  = repoMatch
    ? repoMatch[1].toLowerCase()
    : `r4l-${Date.now().toString(36)}`;

  const files = [{ path: 'index.html', content: htmlContent }];

  // Pick up any separate CSS / JS blocks (rare but possible)
  const cssMatch = text.match(/```css\s*([\s\S]*?)```/i);
  const jsMatch  = text.match(/```(?:javascript|js)\s*([\s\S]*?)```/i);
  if (cssMatch) files.push({ path: 'style.css',  content: cssMatch[1].trim() });
  if (jsMatch)  files.push({ path: 'script.js',  content: jsMatch[1].trim() });

  // Route to the correct deploy prompt based on mode
  if (deployMode === 'cloudflare') {
    showCloudflareDeployPrompt(repoName, files);
  } else {
    showDeployPrompt(repoName, files);
  }
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

function showDownloadOptions(aiMsgId, content, detectedFormat) {
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
    btn.addEventListener('click', () => downloadAs(btn, fmt, content, aiMsgId));
    row.appendChild(btn);
  });

  card.appendChild(label);
  card.appendChild(row);
  card.appendChild(statusDiv);
  bubble.appendChild(card);
  scrollToBottom();
}

// aiMsgId is passed directly from showDownloadOptions — no fragile DOM traversal needed.
async function downloadAs(btn, format, content, aiMsgId) {
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
      body: JSON.stringify({ content, format, filename }),
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

function showDeployPrompt(repoName, files) {
  const fileId = `fid-${++fileIdCounter}`;
  pendingFiles.set(fileId, { repoName, files });

  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.style.cssText = 'padding:16px 0;max-width:780px;align-self:flex-start;width:100%;';
  div.innerHTML = `
    <div style="background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.25);border-radius:14px;padding:24px;">
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">🚀 Your app is ready to deploy!</div>
      <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
        Ready4Launch will create a new public GitHub repository called
        <strong style="color:var(--purple-light);">${repoName}</strong>,
        push your code, and enable GitHub Pages — automatically.
      </p>
      <button data-fileid="${fileId}" onclick="deployToGitHub(this.dataset.fileid, this)"
              style="background:var(--grad-main);color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;font-family:var(--font);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
        Deploy to GitHub Pages
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
  btn.innerHTML = '<span style="opacity:0.7">Creating repo &amp; deploying…</span>';

  const { repoName, files } = pending;

  try {
    const res  = await fetch('/api/github/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoName, files, description: `Built with Ready4Launch` }),
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
          <p style="margin-bottom:0;">
            📁 <strong>Repository:</strong>
            <a href="${data.repoUrl}" target="_blank" rel="noopener" style="color:var(--purple-light);">${data.repoUrl}</a>
          </p>
        </div>
      `;
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

// ── Instant Deploy (managed cloud) ───────────────────────────────
function showCloudflareDeployPrompt(projectName, files) {
  const fileId = `fid-${++fileIdCounter}`;
  pendingFiles.set(fileId, { projectName, files });

  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.style.cssText = 'padding:16px 0;max-width:780px;align-self:flex-start;width:100%;';
  div.innerHTML = `
    <div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.3);border-radius:14px;padding:24px;">
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">🚀 Your app is ready — publish it live!</div>
      <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
        <strong style="color:#818cf8;">${escapeHtml(projectName)}</strong> is built and ready.
        One click and it's live on the internet — no account needed.
      </p>
      <button data-fileid="${fileId}" onclick="deployToCloudflarePages(this.dataset.fileid, this)"
              style="background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;font-family:var(--font);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        Publish Live ⚡
      </button>
    </div>`;
  container.appendChild(div);
  scrollToBottom();
}

async function deployToCloudflarePages(fileId, btn) {
  const pending = pendingFiles.get(fileId);
  if (!pending) return;

  btn.disabled = true;
  btn.innerHTML = '<span style="opacity:0.7">Publishing your app…</span>';

  const { projectName, files } = pending;
  const card = btn.closest('div[style*="border-radius:14px"]');

  try {
    const res  = await fetch('/api/cloudflare/deploy', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ projectName, files }),
    });
    const data = await res.json();

    if (data.success) {
      card.innerHTML = `
        <div class="push-success">
          <h4>🎉 Your app is live!</h4>
          <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
            Your site has been published. Click the link below to open it —
            if it shows "not found" for the first few seconds, wait 30–60 seconds and refresh.
            New deployments take a moment to go live globally.
          </p>
          <p style="margin-bottom:8px;">
            🔗 <strong>Live URL:</strong>
            <a href="${data.url}" target="_blank" rel="noopener" style="color:#818cf8;">${data.url}</a>
          </p>
          <p style="font-size:12px;color:var(--text-3);margin-bottom:0;">
            App ID: ${escapeHtml(data.projectName)}
          </p>
        </div>`;
    } else {
      btn.disabled = false;
      btn.textContent = 'Retry deployment';
      const errEl = document.createElement('p');
      errEl.style.cssText = 'color:#f87171;font-size:13px;margin-top:10px;margin-bottom:0;';
      errEl.textContent = `⚠️ ${data.error || 'Deployment failed. Please try again.'}`;
      btn.insertAdjacentElement('afterend', errEl);
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Retry deployment';
    const errEl = document.createElement('p');
    errEl.style.cssText = 'color:#f87171;font-size:13px;margin-top:10px;margin-bottom:0;';
    errEl.textContent = '⚠️ Network error — please check your connection and retry.';
    btn.insertAdjacentElement('afterend', errEl);
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
  const overlay = document.createElement('div');
  overlay.id = 'r4l-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
  overlay.innerHTML = `
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:20px;padding:40px 36px;max-width:420px;width:100%;text-align:center;">
      <div style="font-size:40px;margin-bottom:16px;">⚡</div>
      <h2 style="font-size:22px;font-weight:700;margin-bottom:10px;">Sign in to continue</h2>
      <p style="color:var(--text-2);font-size:15px;margin-bottom:28px;">Create a free account to build and deploy apps with Ready4Launch.</p>
      <a href="/auth/google" style="display:inline-flex;align-items:center;gap:10px;background:#fff;color:#333;border:1px solid #ddd;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;text-decoration:none;margin-bottom:12px;width:100%;justify-content:center;">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Continue with Google
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

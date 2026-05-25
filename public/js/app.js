/* ── AppBuilder chat interface ──────────────────────────────────── */

let selectedRepo = null;     // { fullName, owner, name }
let allRepos = [];           // cached repo list
let isStreaming = false;
let isNewConversation = true; // tells the server to start a fresh AG session
const pendingFiles = new Map(); // fileId → files array (avoids putting file content in onclick attrs)
let fileIdCounter = 0;

// ── Init ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await loadUser();
  await loadRepos();
  await checkGoogleStatus();
  autoResize(document.getElementById('chatInput'));
});

// ── User profile ─────────────────────────────────────────────────
async function loadUser() {
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (!data.authenticated) { window.location.href = '/'; return; }
    const { login, name, avatarUrl } = data.user;

    const avatarEl = document.getElementById('userAvatar');
    if (avatarUrl) {
      avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${login}" />`;
    } else {
      avatarEl.textContent = (name || login)[0].toUpperCase();
    }
    document.getElementById('userName').textContent = name || `@${login}`;
  } catch {
    window.location.href = '/';
  }
}

// ── Repository loading ───────────────────────────────────────────
async function loadRepos() {
  try {
    const res = await fetch('/api/github/repos');
    if (!res.ok) throw new Error('Failed');
    allRepos = await res.json();
    renderRepoList(allRepos);
  } catch {
    document.getElementById('repoList').innerHTML =
      '<div class="repo-loading" style="color:var(--red);">Failed to load repositories</div>';
  }
}

function renderRepoList(repos) {
  const list = document.getElementById('repoList');
  if (!repos.length) {
    list.innerHTML = '<div class="repo-loading">No repositories found</div>';
    return;
  }
  list.innerHTML = repos.map(r => `
    <div class="repo-item ${selectedRepo?.fullName === r.fullName ? 'selected' : ''}"
         onclick="selectRepo(${JSON.stringify(r).replace(/"/g, '&quot;')})">
      <span class="repo-item-icon">${r.private ? '🔒' : '📂'}</span>
      <span class="repo-item-name">${r.name}</span>
      ${r.private ? '<span class="repo-item-private">private</span>' : ''}
    </div>
  `).join('');
}

function filterRepos() {
  const q = document.getElementById('repoSearch').value.toLowerCase();
  renderRepoList(q ? allRepos.filter(r => r.name.toLowerCase().includes(q)) : allRepos);
}

function toggleRepoDropdown() {
  const dd = document.getElementById('repoDropdown');
  dd.classList.toggle('open');
  if (dd.classList.contains('open')) {
    document.getElementById('repoSearch').focus();
    document.addEventListener('click', closeDropdownOnOutsideClick, true);
  }
}

function closeDropdownOnOutsideClick(e) {
  const selector = document.querySelector('.repo-selector');
  if (!selector.contains(e.target)) {
    document.getElementById('repoDropdown').classList.remove('open');
    document.removeEventListener('click', closeDropdownOnOutsideClick, true);
  }
}

function selectRepo(repo) {
  selectedRepo = repo;
  document.getElementById('repoName').textContent = repo.name;
  document.getElementById('repoDropdown').classList.remove('open');
  document.getElementById('topbarSub').textContent = `📁 ${repo.fullName}`;
  document.getElementById('repoWarning').style.display = 'none';

  // If first message hasn't been sent yet, just update welcome screen
  renderRepoList(allRepos);

  // Update placeholder to show the selected repo name
  if (isNewConversation) {
    document.getElementById('chatInput').placeholder =
      `Describe the app you want to build for "${repo.name}"…`;
  }
}

// ── Google connection status ─────────────────────────────────────
async function checkGoogleStatus() {
  try {
    const res  = await fetch('/auth/google/status');
    const data = await res.json();
    document.getElementById('googleConnected').style.display    = data.connected ? 'flex' : 'none';
    document.getElementById('googleDisconnected').style.display = data.connected ? 'none' : 'flex';
  } catch (_) {}
}

// ── New conversation ─────────────────────────────────────────────
function startNewConversation() {
  // Reset AG session flag so the next message gets a fresh session_id on the server
  isNewConversation = true;

  // Clear the chat UI
  const container = document.getElementById('chatMessages');
  container.innerHTML = '';

  // Re-inject welcome screen
  container.innerHTML = `
    <div class="welcome-screen" id="welcomeScreen">
      <div class="welcome-icon">⚡</div>
      <h2 class="welcome-title">What do you want to build?</h2>
      <p class="welcome-sub">
        Describe any app or website in plain English. AppBuilder will ask you a few questions,
        then create your complete, live website — completely free.
      </p>
      <div class="welcome-repo-warning" id="repoWarning" style="display:none;">
        <span>⚠️</span>
        <span>Please select a GitHub repository in the sidebar first.</span>
      </div>
    </div>`;

  document.getElementById('chatInput').placeholder =
    'Describe the app you want to build…';

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
  if (!text || isStreaming) return;

  if (!selectedRepo) {
    document.getElementById('repoWarning').style.display = 'flex';
    document.getElementById('welcomeScreen').scrollIntoView({ behavior: 'smooth' });
    openSidebar();
    return;
  }

  // Clear welcome screen on first message
  hideWelcome();

  // Show user message
  appendMessage('user', text);
  input.value = '';
  autoResize(input);

  // Disable input while streaming
  setStreaming(true);

  // Placeholder AI bubble with typing indicator
  const aiMsgId = appendMessage('ai', null);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        repoFullName: selectedRepo.fullName,
        newConversation: isNewConversation,
      }),
    });

    // After the first message, all subsequent ones continue the same AG session
    isNewConversation = false;

    if (res.status === 403) {
      const body = await res.json();
      if (body.error === 'google_not_connected') {
        updateAIBubble(aiMsgId, '⚠️ Please connect your Google account in the sidebar first, then try again.');
        setStreaming(false); setStatus('Ready', false); scrollToBottom(); openSidebar(); return;
      }
    }
    if (!res.ok) throw new Error('Server error');

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let aiText = '';
    let buffer = '';

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
            aiText = event.text;
            updateAIBubble(aiMsgId, aiText);
            checkForCode(aiText);
          } else if (event.type === 'error') {
            updateAIBubble(aiMsgId, `⚠️ ${event.message}`);
          }
        } catch (_) {}
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
function appendMessage(role, text) {
  const id = `msg-${++msgCounter}`;
  const container = document.getElementById('chatMessages');
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.id = id;

  if (role === 'user') {
    div.innerHTML = `
      <div class="msg-avatar user">👤</div>
      <div class="msg-body">
        <div class="msg-meta">${now}</div>
        <div class="msg-bubble">${escapeHtml(text)}</div>
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="msg-avatar ai">⚡</div>
      <div class="msg-body">
        <div class="msg-meta">AppBuilder · ${now}</div>
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

// ── Code detection & GitHub push ─────────────────────────────────
function checkForCode(text) {
  // Look for HTML code blocks in the response
  const htmlMatch = text.match(/```html\s*([\s\S]*?)```/i);
  const cssMatch = text.match(/```css\s*([\s\S]*?)```/i);
  const jsMatch = text.match(/```(?:javascript|js)\s*([\s\S]*?)```/i);

  if (htmlMatch) {
    const files = [{ path: 'index.html', content: htmlMatch[1].trim() }];
    if (cssMatch) files.push({ path: 'style.css', content: cssMatch[1].trim() });
    if (jsMatch) files.push({ path: 'script.js', content: jsMatch[1].trim() });
    showPushPrompt(files);
  }
}

function showPushPrompt(files) {
  if (!selectedRepo) return;
  // Store files in memory map — never put raw file content into onclick attributes
  const fileId = `fid-${++fileIdCounter}`;
  pendingFiles.set(fileId, files);

  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.style.cssText = 'padding:16px 0;max-width:780px;align-self:flex-start;width:100%;';
  div.innerHTML = `
    <div style="background:rgba(124,58,237,0.1);border:1px solid rgba(124,58,237,0.25);border-radius:14px;padding:24px;">
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">🚀 Your app is ready!</div>
      <p style="font-size:14px;color:var(--text-2);margin-bottom:16px;">
        AppBuilder has generated <strong style="color:var(--text);">${files.length} file${files.length > 1 ? 's' : ''}</strong> for your website.
        Click below to push them to <strong style="color:var(--purple-light);">${selectedRepo.fullName}</strong> and get your live URL.
      </p>
      <button data-fileid="${fileId}" onclick="pushToGitHub(this.dataset.fileid, this)"
              style="background:var(--grad-main);color:#fff;border:none;border-radius:10px;padding:12px 24px;font-size:15px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px;font-family:var(--font);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
        Push to GitHub &amp; Get Live URL
      </button>
    </div>
  `;
  container.appendChild(div);
  scrollToBottom();
}

async function pushToGitHub(fileId, btn) {
  btn.disabled = true;
  btn.textContent = 'Pushing…';

  const [owner, repo] = selectedRepo.fullName.split('/');
  const parsedFiles = pendingFiles.get(fileId);
  if (!parsedFiles) { btn.disabled = false; btn.textContent = 'Retry'; return; }

  try {
    const res = await fetch('/api/github/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, repo, files: parsedFiles }),
    });
    const data = await res.json();

    const parent = btn.closest('div[style]');
    if (data.success) {
      parent.innerHTML = `
        <div class="push-success">
          <h4>🎉 Your app is live!</h4>
          <p style="font-size:14px;color:var(--text-2);margin-bottom:12px;">
            Your website has been pushed to GitHub and is being deployed.
          </p>
          <p style="margin-bottom:8px;">
            🔗 <strong>Live URL:</strong> <a href="${data.pagesUrl}" target="_blank">${data.pagesUrl}</a>
          </p>
          <p style="margin-bottom:8px;">
            📁 <strong>Repository:</strong> <a href="${data.repoUrl}" target="_blank">${data.repoUrl}</a>
          </p>
          <div style="margin-top:16px;background:var(--bg-3);border:1px solid var(--border);border-radius:10px;padding:16px;font-size:13px;color:var(--text-2);">
            <strong style="color:var(--text);display:block;margin-bottom:8px;">📋 Deployment steps:</strong>
            <ol style="padding-left:20px;display:flex;flex-direction:column;gap:6px;">
              <li>Go to your repository: <a href="${data.repoUrl}" target="_blank">${data.repoUrl}</a></li>
              <li>Click <strong style="color:var(--text);">Settings</strong> → <strong style="color:var(--text);">Pages</strong> (left sidebar)</li>
              <li>Under <strong style="color:var(--text);">Branch</strong>, select <code style="background:var(--bg);padding:1px 6px;border-radius:4px;">main</code> and click <strong style="color:var(--text);">Save</strong></li>
              <li>Wait ~60 seconds, then visit: <a href="${data.pagesUrl}" target="_blank">${data.pagesUrl}</a></li>
            </ol>
          </div>
        </div>
      `;
    } else {
      btn.disabled = false;
      btn.textContent = 'Retry push';
      parent.querySelector('p').textContent = `Error: ${data.error}`;
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Retry push';
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

  // Code blocks (must come before inline code)
  html = html.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

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

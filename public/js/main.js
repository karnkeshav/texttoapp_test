/* ── Landing page JS ───────────────────────────────────────────── */

// ── Particle canvas ──────────────────────────────────────────────
(function initParticles() {
  const canvas = document.getElementById('particleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  function resize() {
    W = canvas.width = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const COLORS = ['#7c3aed', '#3b82f6', '#06b6d4', '#a78bfa'];
  for (let i = 0; i < 60; i++) {
    particles.push({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 2 + 0.5,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: Math.random() * 0.5 + 0.1,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();
      ctx.globalAlpha = 1;
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W;
      if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H;
      if (p.y > H) p.y = 0;
    });
    requestAnimationFrame(draw);
  }
  draw();
})();

// ── Demo typing animation ────────────────────────────────────────
(function initDemoTyping() {
  const cursor = document.getElementById('typingCursor');
  if (!cursor) return;
  const msgs = [
    'Great idea! Before I start building, let me ask a few questions:\n\n1. What pages do you want — just the gallery, or also an "About" and "Contact" page?\n2. What style of photography? (landscapes, portraits, events...)\n3. Any color preferences for the theme?\n4. Do you want a "Book a session" button or just an enquiry form?',
    'Perfect! One more question — do you want the gallery to show images in a masonry grid, or a clean 3-column layout?',
    'Excellent! I have everything I need. Let me now build your complete photographer portfolio...',
  ];
  let msgIdx = 0;
  let charIdx = 0;
  let currentText = '';
  let waiting = false;

  function typeNext() {
    if (waiting) return;
    const target = msgs[msgIdx];
    if (charIdx < target.length) {
      currentText += target[charIdx++];
      cursor.textContent = currentText;
      setTimeout(typeNext, charIdx < target.length ? 18 : 0);
    } else {
      waiting = true;
      setTimeout(() => {
        msgIdx = (msgIdx + 1) % msgs.length;
        charIdx = 0;
        currentText = '';
        cursor.textContent = '';
        waiting = false;
        typeNext();
      }, 3500);
    }
  }
  setTimeout(typeNext, 1200);
})();

// ── Nav scroll effect ────────────────────────────────────────────
window.addEventListener('scroll', () => {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  nav.style.background = window.scrollY > 20
    ? 'rgba(8,9,14,0.95)'
    : 'rgba(8,9,14,0.8)';
});

// ── Mobile nav ───────────────────────────────────────────────────
function toggleMobileMenu() {
  const actions = document.querySelector('.nav-actions');
  if (!actions) return;
  const isOpen = actions.style.display === 'flex';
  actions.style.cssText = isOpen
    ? ''
    : 'display:flex;flex-direction:column;position:fixed;top:64px;left:0;right:0;background:rgba(8,9,14,0.98);padding:20px;gap:8px;border-bottom:1px solid rgba(255,255,255,0.08);z-index:99;';
}

// ── Setup accordion ──────────────────────────────────────────────
function toggleStep(n) {
  const step = document.querySelector(`.setup-step[data-step="${n}"]`);
  if (!step) return;
  const isOpen = step.classList.contains('open');
  document.querySelectorAll('.setup-step').forEach(s => s.classList.remove('open'));
  if (!isOpen) step.classList.add('open');
}

// Open first step by default
window.addEventListener('DOMContentLoaded', () => {
  toggleStep(1);
  checkAuthStatus();
});

// ── Tab switching in setup ───────────────────────────────────────
function switchTab(btn, tabId) {
  const parent = btn.closest('.setup-step-body');
  parent.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  parent.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(tabId).classList.add('active');
}

// ── Checklist ────────────────────────────────────────────────────
function updateChecklist() {
  const checkboxes = document.querySelectorAll('.check-item input[type="checkbox"]');
  const allChecked = Array.from(checkboxes).every(c => c.checked);
  const readySection = document.getElementById('readySection');
  if (readySection) readySection.style.display = allChecked ? 'block' : 'none';
}

// ── Auth status ──────────────────────────────────────────────────
async function checkAuthStatus() {
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (data.authenticated) {
      const btn = document.getElementById('connectGithubBtn');
      if (btn) {
        btn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          Connected as @${data.user.login} — Go to Ready4Launch
        `;
        btn.href = '/app';
        btn.style.background = 'linear-gradient(135deg,#10b981,#059669)';
      }
    }
  } catch (_) {}
}

// ── Start building ───────────────────────────────────────────────
function startBuilding() {
  window.location.href = '/auth/github';
}

// ── Intersection observer for entrance animations ─────────────────
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, { threshold: 0.1 });

window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.step-card, .feature-card, .setup-step').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    observer.observe(el);
  });
});

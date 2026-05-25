require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes       = require('./routes/auth');
const googleAuthRoutes = require('./routes/googleAuth');
const chatRoutes       = require('./routes/chat');
const githubRoutes     = require('./routes/github');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API / Auth Routes ─────────────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/auth', googleAuthRoutes);
app.use('/api', chatRoutes);
app.use('/api/github', githubRoutes);

// ── Page routes ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  if (!req.session.githubToken) return res.redirect('/?error=not_authenticated');
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 AppBuilder running at http://localhost:${PORT}\n`);
});

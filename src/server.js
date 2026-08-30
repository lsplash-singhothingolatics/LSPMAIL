require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { attachUser } = require('./middleware/auth');
const { pool } = require('./db');

const app = express();
app.set('trust proxy', 1);

// Keep the raw body around so webhook signatures can be checked.
app.use(express.json({
  limit: '30mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(attachUser);

app.get('/healthz', async (_req, res) => {
  try { await pool.query('select 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use('/auth', require('./routes/auth'));
app.use('/api/mail', require('./routes/mail'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/inbound', require('./routes/inbound'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/domains', require('./routes/domains'));

app.get('/api/config', (req, res) => {
  res.json({
    appName: process.env.APP_NAME || 'LSPMail',
    mailDomain: process.env.MAIL_DOMAIN || 'lspmail.app',
    providers: {
      google: !!process.env.GOOGLE_CLIENT_ID,
      yahoo: !!process.env.YAHOO_CLIENT_ID,
      github: !!process.env.GITHUB_CLIENT_ID,
    },
    razorpay: !!process.env.RAZORPAY_KEY_ID,
    signedIn: !!req.user,
  });
});

app.get(['/app', '/app.html'], (req, res) => {
  if (!req.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

app.get('/', (req, res) => {
  if (req.user) return res.redirect('/app');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Static last: otherwise /app resolves to app.html and skips the check above.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => res.status(404).json({ error: 'Nothing here.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something broke on our side. Try again.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`LSPMail listening on :${port}`));

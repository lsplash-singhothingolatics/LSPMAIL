/**
 * LSPMail as an OAuth 2.0 / OpenID-ish provider.
 *
 *   GET  /oauth/authorize   sign in, see what's being asked, approve or refuse
 *   POST /oauth/token       swap the code for an access token (PKCE supported)
 *   GET  /oauth/userinfo    read the approved profile with a Bearer token
 *
 * Clients are configured by environment variable rather than a registration UI,
 * which suits a small number of first-party apps:
 *
 *   OAUTH_CLIENT_ID       lspso
 *   OAUTH_CLIENT_SECRET   <random>
 *   OAUTH_REDIRECT_URIS   https://lspso.onrender.com/auth/lspmail/callback
 *   OAUTH_CLIENT_NAME     LSPSO           (optional, shown on the consent screen)
 *
 * Authorization codes live in the database, hashed, single-use, 5 minutes.
 * Access tokens are signed JWTs, so verifying one needs no database round trip.
 */
const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { one, query } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CODE_TTL_SECONDS = 300;
const TOKEN_TTL_SECONDS = 3600;

const CLIENTS = {};
if (process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET) {
  CLIENTS[process.env.OAUTH_CLIENT_ID] = {
    id: process.env.OAUTH_CLIENT_ID,
    secret: process.env.OAUTH_CLIENT_SECRET,
    name: process.env.OAUTH_CLIENT_NAME || process.env.OAUTH_CLIENT_ID,
    redirectUris: (process.env.OAUTH_REDIRECT_URIS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
  };
}

const SCOPES = {
  openid: 'Confirm who you are',
  email: 'See your email address',
  profile: 'See your name and picture',
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function redirectError(res, redirectUri, state, error, description) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return res.redirect(u.toString());
}

// ---------- authorize ----------
router.get('/authorize', async (req, res) => {
  const {
    client_id, redirect_uri, response_type, scope = 'openid email profile',
    state, code_challenge, code_challenge_method,
  } = req.query;

  const client = CLIENTS[client_id];
  // Errors before the redirect URI is trusted must be shown here, never redirected.
  if (!client) return res.status(400).send(page('Unknown application', 'That app is not registered with LSPMail.'));
  if (!client.redirectUris.includes(redirect_uri)) {
    return res.status(400).send(page('Bad redirect', 'That redirect address is not on the approved list for this app.'));
  }
  if (response_type !== 'code') {
    return redirectError(res, redirect_uri, state, 'unsupported_response_type');
  }
  if (code_challenge && code_challenge_method !== 'S256') {
    return redirectError(res, redirect_uri, state, 'invalid_request', 'Only S256 is supported');
  }

  // Not signed in: bounce through the normal login, then come back here.
  if (!req.user) {
    const back = encodeURIComponent(req.originalUrl);
    return res.redirect(`/?next=${back}`);
  }

  const requested = String(scope).split(/\s+/).filter((s) => SCOPES[s]);

  // The approval carries a signed copy of the request, so nothing can be
  // swapped between showing the screen and pressing Allow.
  const ticket = jwt.sign(
    { c: client.id, r: redirect_uri, s: requested.join(' '), st: state || '',
      cc: code_challenge || '', u: req.user.id },
    JWT_SECRET, { expiresIn: '10m' }
  );

  res.send(consentPage(client, req.user, requested, ticket));
});

router.post('/authorize/decision', async (req, res) => {
  const { ticket, decision } = req.body;
  let t;
  try { t = jwt.verify(ticket, JWT_SECRET); }
  catch { return res.status(400).send(page('Expired', 'That approval screen timed out. Start again.')); }

  if (!req.user || req.user.id !== t.u) {
    return res.status(401).send(page('Signed out', 'You were signed out. Start again.'));
  }
  if (decision !== 'allow') {
    return redirectError(res, t.r, t.st, 'access_denied', 'You refused the request');
  }

  const code = b64url(crypto.randomBytes(32));
  await query(
    `insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, expires_at)
     values ($1,$2,$3,$4,$5,$6, now() + interval '5 minutes')`,
    [sha256(code), t.c, t.u, t.r, t.s, t.cc || null]
  );

  const u = new URL(t.r);
  u.searchParams.set('code', code);
  if (t.st) u.searchParams.set('state', t.st);
  res.redirect(u.toString());
});

// ---------- token ----------
router.post('/token', async (req, res) => {
  res.set('cache-control', 'no-store');

  // Credentials arrive either in an Authorization header or in the form body.
  let clientId = req.body.client_id;
  let clientSecret = req.body.client_secret;
  const basic = req.get('authorization');
  if (basic?.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
    clientId = id; clientSecret = secret;
  }

  const client = CLIENTS[clientId];
  if (!client) return res.status(401).json({ error: 'invalid_client' });

  const a = Buffer.from(String(clientSecret || ''));
  const b = Buffer.from(client.secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  if (req.body.grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  const { code, redirect_uri, code_verifier } = req.body;
  if (!code) return res.status(400).json({ error: 'invalid_request' });

  // Claim the code atomically: a replayed code finds nothing left to claim.
  const row = await one(
    `update oauth_codes set used = true
     where code_hash = $1 and used = false and expires_at > now()
     returning *`, [sha256(String(code))]
  );
  if (!row) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code is used, expired or unknown' });

  if (row.client_id !== client.id) return res.status(400).json({ error: 'invalid_grant' });
  if (row.redirect_uri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match' });
  }

  if (row.code_challenge) {
    if (!code_verifier) return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
    const computed = b64url(crypto.createHash('sha256').update(code_verifier).digest());
    if (computed !== row.code_challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE check failed' });
    }
  }

  const user = await one('select * from users where id = $1', [row.user_id]);
  if (!user) return res.status(400).json({ error: 'invalid_grant' });

  const access_token = jwt.sign(
    { sub: user.id, aud: 'oauth', client: client.id, scope: row.scope },
    JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS }
  );

  const body = { access_token, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS, scope: row.scope };

  if (row.scope.includes('openid')) {
    body.id_token = jwt.sign(
      { sub: user.id, aud: client.id, iss: process.env.APP_URL || '',
        email: user.email, email_verified: true, name: user.name },
      JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS }
    );
  }

  res.json(body);
});

// ---------- userinfo ----------
router.get('/userinfo', async (req, res) => {
  res.set('cache-control', 'no-store');
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'invalid_token' });

  let claims;
  try { claims = jwt.verify(header.slice(7), JWT_SECRET, { audience: 'oauth' }); }
  catch { return res.status(401).json({ error: 'invalid_token' }); }

  const user = await one('select * from users where id = $1', [claims.sub]);
  if (!user) return res.status(401).json({ error: 'invalid_token' });

  const scope = String(claims.scope || '');
  const out = { sub: user.id };
  if (scope.includes('email')) { out.email = user.email; out.email_verified = true; }
  if (scope.includes('profile')) { out.name = user.name; out.picture = user.avatar_url; }
  res.json(out);
});

// Lets a client discover the endpoints without them being hard-coded.
router.get('/.well-known/openid-configuration', (_req, res) => {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    scopes_supported: Object.keys(SCOPES),
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  });
});

// ---------- pages ----------
const shell = (inner) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LSPMail</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Inter:wght@400;500;600;650&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/app.css">
</head><body style="display:grid;place-items:center;min-height:100vh;padding:24px">
<div style="width:100%;max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:30px 30px 26px;box-shadow:var(--shadow-card)">
${inner}
</div></body></html>`;

const page = (title, body) => shell(`
  <div class="wordmark" style="font-size:18px"><span class="lsp">LSP</span>Mail</div>
  <h1 style="font-family:var(--display);font-size:21px;font-weight:650;margin:18px 0 8px">${esc(title)}</h1>
  <p style="color:var(--muted);font-size:14px;margin:0">${esc(body)}</p>`);

const consentPage = (client, user, scopes, ticket) => shell(`
  <div class="wordmark" style="font-size:18px"><span class="lsp">LSP</span>Mail</div>
  <h1 style="font-family:var(--display);font-size:22px;font-weight:650;letter-spacing:-.02em;margin:18px 0 6px">
    Let ${esc(client.name)} in?
  </h1>
  <p style="color:var(--muted);font-size:14px;margin:0 0 20px">
    It wants to use your LSPMail account, signed in as <strong>${esc(user.email)}</strong>.
  </p>

  <div style="border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px;margin-bottom:20px">
    ${scopes.map((s) => `<div style="display:flex;gap:10px;padding:5px 0;font-size:13.5px">
      <span style="color:var(--accent)">•</span><span>${esc(SCOPES[s])}</span></div>`).join('')}
  </div>

  <p style="font-size:12.5px;color:var(--faint);margin:0 0 20px">
    It cannot read your messages or send mail as you.
  </p>

  <form method="post" action="/oauth/authorize/decision">
    <input type="hidden" name="ticket" value="${esc(ticket)}">
    <button class="btn btn-primary btn-block btn-lg" name="decision" value="allow" type="submit">
      Continue as ${esc(user.name || user.email)}
    </button>
    <button class="btn btn-block" name="decision" value="deny" type="submit" style="margin-top:9px">
      Not now
    </button>
  </form>`);

module.exports = router;

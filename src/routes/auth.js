const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { one, many, query, tx } = require('../db');
const { setSession, clearSession, signState, readState, hashCode, newCode } = require('../lib/tokens');
const { sendOtp } = require('../lib/mailer');
const { PLANS } = require('../lib/plans');

const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'lspmail.app';

const PROVIDERS = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    id: () => process.env.GOOGLE_CLIENT_ID,
    secret: () => process.env.GOOGLE_CLIENT_SECRET,
    extra: { access_type: 'offline', prompt: 'select_account' },
    normalize: (p) => ({ uid: p.sub, email: p.email, name: p.name, avatar: p.picture }),
  },
  yahoo: {
    authorize: 'https://api.login.yahoo.com/oauth2/request_auth',
    token: 'https://api.login.yahoo.com/oauth2/get_token',
    userinfo: 'https://api.login.yahoo.com/openid/v1/userinfo',
    scope: 'openid email profile',
    id: () => process.env.YAHOO_CLIENT_ID,
    secret: () => process.env.YAHOO_CLIENT_SECRET,
    extra: {},
    normalize: (p) => ({ uid: p.sub, email: p.email, name: p.name || p.nickname, avatar: p.picture }),
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userinfo: 'https://api.github.com/user',
    scope: 'read:user user:email',
    id: () => process.env.GITHUB_CLIENT_ID,
    secret: () => process.env.GITHUB_CLIENT_SECRET,
    extra: {},
    normalize: (p) => ({ uid: String(p.id), email: p.email, name: p.name || p.login, avatar: p.avatar_url }),
  },
};

const redirectUri = (name) => `${APP_URL}/auth/${name}/callback`;

// ---------- shared account provisioning ----------
function handleFromEmail(email) {
  return email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24) || 'user';
}

async function findOrCreateUser({ provider, uid, email, name, avatar }) {
  if (!email) throw new Error('That account has no verified email address.');
  email = email.toLowerCase();

  const existingIdentity = await one(
    'select u.* from identities i join users u on u.id = i.user_id where i.provider = $1 and i.provider_uid = $2',
    [provider, uid]
  );
  if (existingIdentity) return existingIdentity;

  return tx(async (c) => {
    let user = (await c.query('select * from users where email = $1', [email])).rows[0];
    if (!user) {
      user = (await c.query(
        'insert into users (email, name, avatar_url, plan, quota_bytes) values ($1,$2,$3,$4,$5) returning *',
        [email, name || null, avatar || null, 'starter', PLANS.starter.quota]
      )).rows[0];

      // Give every new account an @MAIL_DOMAIN mailbox, plus their sign-in address.
      let handle = handleFromEmail(email);
      const taken = (await c.query('select 1 from addresses where address = $1', [`${handle}@${MAIL_DOMAIN}`])).rowCount;
      if (taken) handle = `${handle}${Math.floor(Math.random() * 9000 + 1000)}`;
      await c.query(
        'insert into addresses (user_id, address, label, is_primary, verified) values ($1,$2,$3,true,true)',
        [user.id, `${handle}@${MAIL_DOMAIN}`, 'LSPMail']
      );
      await c.query(
        `insert into addresses (user_id, address, label, is_primary, verified) values ($1,$2,$3,false,true)
         on conflict (address) do nothing`,
        [user.id, email, name || 'Sign-in address']
      );
    }
    await c.query(
      'insert into identities (user_id, provider, provider_uid) values ($1,$2,$3) on conflict do nothing',
      [user.id, provider, uid]
    );
    if (avatar && !user.avatar_url) {
      await c.query('update users set avatar_url = $1 where id = $2', [avatar, user.id]);
    }
    return user;
  });
}

// ---------- oauth ----------
router.get('/:provider', (req, res) => {
  const p = PROVIDERS[req.params.provider];
  if (!p) return res.redirect('/?error=Unknown+sign-in+provider');
  if (!p.id()) return res.redirect(`/?error=${encodeURIComponent(req.params.provider)}+sign-in+is+not+configured+yet`);

  const url = new URL(p.authorize);
  url.searchParams.set('client_id', p.id());
  url.searchParams.set('redirect_uri', redirectUri(req.params.provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', p.scope);
  url.searchParams.set('state', signState({ p: req.params.provider }));
  for (const [k, v] of Object.entries(p.extra)) url.searchParams.set(k, v);
  res.redirect(url.toString());
});

router.get('/:provider/callback', async (req, res) => {
  const name = req.params.provider;
  const p = PROVIDERS[name];
  try {
    if (!p) throw new Error('Unknown sign-in provider');
    const state = readState(req.query.state || '');
    if (!state || state.p !== name) throw new Error('Sign-in link expired. Try again.');
    if (req.query.error) throw new Error('Sign-in was cancelled.');

    const tokenRes = await fetch(p.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: req.query.code,
        client_id: p.id(),
        client_secret: p.secret(),
        redirect_uri: redirectUri(name),
      }),
    });
    const tok = await tokenRes.json();
    if (!tok.access_token) throw new Error(tok.error_description || 'Could not complete sign-in.');

    const uiRes = await fetch(p.userinfo, {
      headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': 'LSPMail', accept: 'application/json' },
    });
    const profile = await uiRes.json();

    // GitHub hides the email unless you ask the emails endpoint.
    if (name === 'github' && !profile.email) {
      const emails = await (await fetch('https://api.github.com/user/emails', {
        headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': 'LSPMail' },
      })).json();
      profile.email = (emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || {}).email;
    }

    const user = await findOrCreateUser({ provider: name, ...p.normalize(profile) });
    setSession(res, user);
    res.redirect('/app');
  } catch (e) {
    res.redirect(`/?error=${encodeURIComponent(e.message)}`);
  }
});

// ---------- otp ----------
const otpLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false });

router.post('/otp/request', otpLimit, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const code = newCode();
  await query('delete from otp_codes where email = $1', [email]);
  await query('insert into otp_codes (email, code_hash, expires_at) values ($1,$2, now() + interval \'10 minutes\')',
    [email, hashCode(code)]);
  try {
    await sendOtp(email, code);
  } catch (e) {
    return res.status(502).json({ error: 'We could not send the code. Check the address and try again.' });
  }
  res.json({ ok: true, email });
});

router.post('/otp/verify', otpLimit, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const row = await one(
    'select * from otp_codes where email = $1 and expires_at > now() order by created_at desc limit 1', [email]
  );
  if (!row) return res.status(400).json({ error: 'That code expired. Request a new one.' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many tries. Request a new code.' });
  if (row.code_hash !== hashCode(code)) {
    await query('update otp_codes set attempts = attempts + 1 where email = $1', [email]);
    return res.status(400).json({ error: 'That code is not right.' });
  }
  await query('delete from otp_codes where email = $1', [email]);
  const user = await findOrCreateUser({ provider: 'otp', uid: email, email, name: null, avatar: null });
  setSession(res, user);
  res.json({ ok: true });
});

router.post('/signout', (req, res) => { clearSession(res); res.json({ ok: true }); });

module.exports = router;
module.exports.PROVIDERS = PROVIDERS;

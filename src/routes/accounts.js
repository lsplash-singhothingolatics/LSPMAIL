const router = require('express').Router();
const { one, many, query } = require('../db');
const { requireUser } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');
const { PLANS, fmtBytes } = require('../lib/plans');
const { signState, readState } = require('../lib/tokens');

const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'lspmail.app';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const ADDRESS_LIMIT = { starter: 1, pro: 5, business: Infinity };

// Confirmation links are opened from an email client, so this one runs before the guard.
router.get('/addresses/confirm', async (req, res) => {
  const s = readState(req.query.token || '');
  if (!s || s.k !== 'addr') return res.redirect('/app?error=That+confirmation+link+expired');
  await query('update addresses set verified = true where id = $1 and user_id = $2', [s.a, s.u]);
  res.redirect('/app?ok=Address+confirmed');
});

router.use(requireUser);

router.get('/me', async (req, res) => {
  const u = req.user;
  const addresses = await many(
    'select id, address, label, is_primary, verified from addresses where user_id = $1 order by is_primary desc, created_at',
    [u.id]
  );
  const domains = await many('select domain, status from domains where user_id = $1 order by created_at desc', [u.id]);
  res.json({
    user: {
      id: u.id, email: u.email, name: u.name, avatarUrl: u.avatar_url, plan: u.plan,
      quotaBytes: Number(u.quota_bytes), usedBytes: Number(u.used_bytes),
      quotaLabel: fmtBytes(Number(u.quota_bytes)), usedLabel: fmtBytes(Number(u.used_bytes)),
    },
    addresses, domains, plans: PLANS, mailDomain: MAIL_DOMAIN,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
  });
});

// Add another address you already own. We mail it a confirmation link before enabling it.
router.post('/addresses', async (req, res) => {
  const address = String(req.body.address || '').trim().toLowerCase();
  const label = String(req.body.label || '').trim() || null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const count = (await one('select count(*)::int n from addresses where user_id = $1', [req.user.id])).n;
  const limit = ADDRESS_LIMIT[req.user.plan] ?? 1;
  if (count >= limit) {
    return res.status(402).json({ error: `The ${PLANS[req.user.plan].name} plan covers ${limit} address${limit > 1 ? 'es' : ''}. Upgrade to add more.`, code: 'plan' });
  }

  const taken = await one('select user_id from addresses where address = $1', [address]);
  if (taken) return res.status(409).json({ error: 'That address is already connected to an account.' });

  const isLsp = address.endsWith(`@${MAIL_DOMAIN}`);
  const row = await one(
    'insert into addresses (user_id, address, label, verified) values ($1,$2,$3,$4) returning id, address, label, is_primary, verified',
    [req.user.id, address, label, isLsp]
  );

  if (!isLsp) {
    const token = signState({ a: row.id, u: req.user.id, k: 'addr' });
    const link = `${APP_URL}/api/accounts/addresses/confirm?token=${token}`;
    try {
      await sendMail({
        from: process.env.OTP_FROM || `LSPMail <login@${MAIL_DOMAIN}>`,
        to: address,
        subject: 'Confirm this address for LSPMail',
        text: `Confirm ${address} for LSPMail: ${link}`,
        html: `<p style="font-family:sans-serif">Confirm <b>${address}</b> so you can send and receive from it in LSPMail.</p>
               <p><a href="${link}" style="display:inline-block;background:#2D4BE0;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-family:sans-serif">Confirm address</a></p>
               <p style="font-family:sans-serif;color:#6E6E66;font-size:12px">The link works for 10 minutes.</p>`,
      });
    } catch {
      await query('delete from addresses where id = $1', [row.id]);
      return res.status(502).json({ error: 'We could not reach that address. Check the spelling and try again.' });
    }
  }
  res.json({ address: row, needsConfirmation: !isLsp });
});

router.post('/addresses/:id/primary', async (req, res) => {
  await query('update addresses set is_primary = false where user_id = $1', [req.user.id]);
  const row = await one(
    'update addresses set is_primary = true where id = $1 and user_id = $2 and verified returning *',
    [req.params.id, req.user.id]
  );
  if (!row) return res.status(400).json({ error: 'Confirm that address first.' });
  res.json({ ok: true });
});

router.delete('/addresses/:id', async (req, res) => {
  const row = await one('select * from addresses where id = $1 and user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Address not found.' });
  if (row.is_primary) return res.status(400).json({ error: 'Make another address primary before removing this one.' });
  await query('delete from addresses where id = $1', [row.id]);
  res.json({ ok: true });
});

// Claim a fresh @lspmail handle
router.post('/addresses/claim', async (req, res) => {
  const handle = String(req.body.handle || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (handle.length < 3) return res.status(400).json({ error: 'Handles are at least 3 characters.' });
  const address = `${handle}@${MAIL_DOMAIN}`;
  if (await one('select 1 from addresses where address = $1', [address])) {
    return res.status(409).json({ error: 'That handle is taken.' });
  }
  const count = (await one('select count(*)::int n from addresses where user_id = $1', [req.user.id])).n;
  const limit = ADDRESS_LIMIT[req.user.plan] ?? 1;
  if (count >= limit) return res.status(402).json({ error: 'Upgrade your plan to add more addresses.', code: 'plan' });
  const row = await one(
    'insert into addresses (user_id, address, label, verified) values ($1,$2,$3,true) returning *',
    [req.user.id, address, req.body.label || null]
  );
  res.json({ address: row });
});

module.exports = router;

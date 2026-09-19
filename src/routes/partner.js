/**
 * Partner search — lets LSPSO look up the signed-in person's own mail.
 *
 * Trust model, stated plainly:
 *   LSPSO has already authenticated the person (Google, GitHub or an emailed
 *   code), so it can assert which email address it is asking about. LSPMail
 *   trusts that assertion only when the request carries a valid HMAC made with
 *   a secret both servers hold, and only when the address is a VERIFIED address
 *   on a LSPMail account. An unverified address never matches.
 *
 *   This endpoint returns headers and snippets, never message bodies or
 *   attachments. LSPSO shows enough to recognise a message, then links out to
 *   LSPMail to read it.
 */
const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { one, many } = require('../db');

const SECRET = process.env.PARTNER_SECRET;
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const MAX_SKEW_SECONDS = 300;

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// Signature covers the timestamp too, so a captured request cannot be replayed later.
function verify(req) {
  if (!SECRET) return { ok: false, why: 'Partner search is not configured.' };

  const ts = req.get('x-lsp-timestamp') || '';
  const given = req.get('x-lsp-signature') || '';
  if (!ts || !given) return { ok: false, why: 'Missing signature.' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > MAX_SKEW_SECONDS) {
    return { ok: false, why: 'Signature expired.' };
  }

  const expected = crypto.createHmac('sha256', SECRET)
    .update(`${ts}.${req.rawBody || ''}`).digest('hex');

  if (expected.length !== given.length) return { ok: false, why: 'Bad signature.' };
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
    return { ok: false, why: 'Bad signature.' };
  }
  return { ok: true };
}

const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

router.post('/search', limiter, async (req, res) => {
  const check = verify(req);
  if (!check.ok) return res.status(401).json({ error: check.why });

  const email = String(req.body.email || '').trim().toLowerCase();
  const q = String(req.body.query || '').trim();
  const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 10, 1), 25);

  if (!email) return res.status(400).json({ error: 'No address given.' });

  // Only a verified address resolves to a mailbox.
  const addr = await one('select user_id from addresses where address = $1 and verified', [email]);
  if (!addr) return res.json({ linked: false, messages: [], total: 0 });

  if (!q) {
    const unread = await one(
      "select count(*)::int n from messages where user_id = $1 and folder = 'inbox' and unread",
      [addr.user_id]);
    return res.json({ linked: true, messages: [], total: 0, unread: unread.n });
  }

  const pattern = `%${likeEscape(q)}%`;
  const rows = await many(
    `select id, subject, from_addr, from_name, to_addrs, snippet, folder, created_at, unread,
            (select count(*)::int from attachments a where a.message_id = m.id) as attachment_count
     from messages m
     where user_id = $1 and folder <> 'trash'
       and (subject ilike $2 or from_addr ilike $2 or from_name ilike $2 or snippet ilike $2)
     order by created_at desc limit $3`,
    [addr.user_id, pattern, limit]
  );

  const unread = await one(
    "select count(*)::int n from messages where user_id = $1 and folder = 'inbox' and unread",
    [addr.user_id]);

  res.json({
    linked: true,
    unread: unread.n,
    total: rows.length,
    messages: rows.map((m) => ({
      id: m.id,
      subject: m.subject || '(no subject)',
      from: m.from_name || m.from_addr,
      fromAddress: m.from_addr,
      snippet: m.snippet || '',
      folder: m.folder,
      unread: m.unread,
      hasAttachments: m.attachment_count > 0,
      date: m.created_at,
      url: `${APP_URL}/app?msg=${m.id}`,
    })),
  });
});

// Lightweight probe so LSPSO can show or hide the mail tab without a search.
router.post('/status', limiter, async (req, res) => {
  const check = verify(req);
  if (!check.ok) return res.status(401).json({ error: check.why });

  const email = String(req.body.email || '').trim().toLowerCase();
  const addr = await one('select user_id from addresses where address = $1 and verified', [email]);
  if (!addr) return res.json({ linked: false });

  const unread = await one(
    "select count(*)::int n from messages where user_id = $1 and folder = 'inbox' and unread",
    [addr.user_id]);
  res.json({ linked: true, unread: unread.n, appUrl: `${APP_URL}/app` });
});

module.exports = router;

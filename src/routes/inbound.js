// Receives mail. Point Resend inbound (or Cloudflare Email Routing) at POST /api/inbound.
const router = require('express').Router();
const crypto = require('crypto');
const { one, tx } = require('../db');

const snippetOf = (t = '') => String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
const threadKeyOf = (s = '') => s.toLowerCase().replace(/^(re|fwd|fw)\s*:\s*/gi, '').trim().slice(0, 120) || 'no-subject';

const PROMO = /(newsletter|unsubscribe|promo|sale|deal|offer)/i;
const SOCIAL = /(facebook|twitter|x\.com|linkedin|instagram|reddit|discord)/i;
const UPDATES = /(no-?reply|notification|receipt|invoice|alert|billing)/i;

function categorize({ from, subject, text }) {
  const hay = `${from} ${subject} ${String(text).slice(0, 400)}`;
  if (SOCIAL.test(from)) return 'social';
  if (PROMO.test(hay)) return 'promotions';
  if (UPDATES.test(from)) return 'updates';
  return 'primary';
}

function verifySignature(req) {
  const secret = process.env.RESEND_INBOUND_SECRET;
  if (!secret) return true; // unset in dev
  const sig = req.get('svix-signature') || req.get('x-webhook-signature') || '';
  const id = req.get('svix-id') || '';
  const ts = req.get('svix-timestamp') || '';
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${req.rawBody}`).digest('base64');
  return sig.split(' ').some((part) => {
    const v = part.includes(',') ? part.split(',')[1] : part;
    try { return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); } catch { return false; }
  });
}

function parsePayload(body) {
  const d = body.data || body;
  const fromRaw = d.from?.address || d.from || d.envelope?.from || '';
  const nameMatch = /^\s*"?([^"<]*?)"?\s*</.exec(typeof d.from === 'string' ? d.from : '');
  return {
    from: (/<([^>]+)>/.exec(fromRaw)?.[1] || fromRaw).toLowerCase().trim(),
    fromName: d.from?.name || nameMatch?.[1]?.trim() || null,
    to: (Array.isArray(d.to) ? d.to : [d.to])
      .filter(Boolean)
      .map((t) => (t.address || t)).map((t) => (/<([^>]+)>/.exec(t)?.[1] || t).toLowerCase().trim()),
    cc: (d.cc || []).map((t) => (t.address || t)),
    subject: d.subject || '',
    text: d.text || d.plain || '',
    html: d.html || null,
    attachments: d.attachments || [],
    providerId: d.email_id || d.id || null,
  };
}

router.post('/', async (req, res) => {
  if (!verifySignature(req)) return res.status(401).json({ error: 'Bad signature' });

  const mail = parsePayload(req.body);
  if (!mail.to.length) return res.json({ ok: true, skipped: 'no recipient' });

  let delivered = 0;
  for (const rcpt of mail.to) {
    const addr = await one('select * from addresses where address = $1 and verified', [rcpt]);
    if (!addr) continue;
    const user = await one('select * from users where id = $1', [addr.user_id]);
    if (!user) continue;

    const attachBytes = mail.attachments.reduce((n, a) => n + (a.size || Math.ceil((a.content || '').length * 0.75)), 0);
    const size = Buffer.byteLength(mail.subject + mail.text + (mail.html || '')) + attachBytes;

    // Over quota: bounce it rather than silently swallowing mail.
    if (Number(user.used_bytes) + size > Number(user.quota_bytes)) continue;

    await tx(async (c) => {
      const m = (await c.query(
        `insert into messages (user_id, address_id, direction, folder, category, from_addr, from_name,
                               to_addrs, cc_addrs, subject, snippet, body_text, body_html, thread_key, size_bytes, provider_id)
         values ($1,$2,'inbound','inbox',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [user.id, addr.id, categorize(mail), mail.from, mail.fromName, mail.to, mail.cc, mail.subject,
         snippetOf(mail.text || mail.html), mail.text, mail.html, threadKeyOf(mail.subject), size, mail.providerId]
      )).rows[0];

      for (const a of mail.attachments) {
        const buf = Buffer.from(a.content || a.data || '', 'base64');
        await c.query(
          'insert into attachments (message_id, user_id, filename, content_type, size_bytes, data) values ($1,$2,$3,$4,$5,$6)',
          [m.id, user.id, a.filename || 'attachment', a.content_type || a.contentType || null, buf.length, buf]
        );
      }
      await c.query('update users set used_bytes = used_bytes + $1 where id = $2', [size, user.id]);
    });
    delivered++;
  }
  res.json({ ok: true, delivered });
});

module.exports = router;

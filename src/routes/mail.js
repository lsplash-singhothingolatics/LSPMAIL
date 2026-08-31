const router = require('express').Router();
const { one, many, query, tx } = require('../db');
const { requireUser } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');

router.use(requireUser);

const snippetOf = (t = '') => String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
const threadKeyOf = (subject = '') =>
  subject.toLowerCase().replace(/^(re|fwd|fw)\s*:\s*/gi, '').trim().slice(0, 120) || 'no-subject';

const EMAIL_RE = /^(?:[^<>]*<\s*)?[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+\s*>?$/;

// Accept commas, semicolons, or newlines between addresses.
function parseList(input) {
  return (Array.isArray(input) ? input : String(input || '').split(/[,;\n]/))
    .flatMap((s) => String(s).split(/[;\n]/))
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- list ----------
router.get('/', async (req, res) => {
  const { folder = 'inbox', category, starred, q, address } = req.query;
  const where = ['m.user_id = $1'];
  const args = [req.user.id];

  if (starred === '1') {
    where.push("m.folder <> 'trash'", 'm.starred = true');
  } else {
    args.push(folder); where.push(`m.folder = $${args.length}`);
    if (category && folder === 'inbox') { args.push(category); where.push(`m.category = $${args.length}`); }
  }
  if (address) { args.push(address); where.push(`m.address_id = $${args.length}`); }
  if (q) {
    args.push(`%${q}%`);
    where.push(`(m.subject ilike $${args.length} or m.from_addr ilike $${args.length} or m.snippet ilike $${args.length})`);
  }

  const rows = await many(
    `select m.id, m.folder, m.category, m.from_addr, m.from_name, m.to_addrs, m.subject, m.snippet,
            m.starred, m.unread, m.size_bytes, m.created_at, m.direction,
            (select count(*)::int from attachments a where a.message_id = m.id) as attachment_count
     from messages m where ${where.join(' and ')}
     order by m.created_at desc limit 100`, args
  );
  res.json({ messages: rows });
});

router.get('/counts', async (req, res) => {
  const rows = await many(
    `select folder, category, count(*) filter (where unread) as unread, count(*) as total
     from messages where user_id = $1 group by folder, category`, [req.user.id]
  );
  const starred = await one(
    "select count(*)::int as n from messages where user_id = $1 and starred and folder <> 'trash'", [req.user.id]);
  res.json({ buckets: rows, starred: starred.n });
});

// ---------- read one ----------
router.get('/:id', async (req, res) => {
  const m = await one('select * from messages where id = $1 and user_id = $2', [req.params.id, req.user.id]);
  if (!m) return res.status(404).json({ error: 'That message is no longer here.' });
  await query('update messages set unread = false where id = $1', [m.id]);
  m.unread = false;
  m.attachments = await many(
    'select id, filename, content_type, size_bytes from attachments where message_id = $1', [m.id]);
  res.json({ message: m });
});

router.get('/:id/attachments/:aid', async (req, res) => {
  const a = await one(
    'select * from attachments where id = $1 and message_id = $2 and user_id = $3',
    [req.params.aid, req.params.id, req.user.id]
  );
  if (!a) return res.status(404).send('Not found');
  res.setHeader('content-type', a.content_type || 'application/octet-stream');
  res.setHeader('content-disposition', `attachment; filename="${a.filename.replace(/"/g, '')}"`);
  res.send(a.data);
});

// ---------- send ----------
router.post('/send', async (req, res) => {
  const { from, to, cc = [], subject = '', bodyText = '', bodyHtml, attachments = [] } = req.body;

  const recipients = parseList(to);
  const ccList = parseList(cc);
  if (!recipients.length) return res.status(400).json({ error: 'Add at least one recipient.' });

  const bad = [...recipients, ...ccList].find((a) => !EMAIL_RE.test(a));
  if (bad) return res.status(400).json({ error: `${bad} is not a valid email address.` });

  const addr = await one(
    'select * from addresses where user_id = $1 and address = $2',
    [req.user.id, String(from || '').toLowerCase()]
  );
  if (!addr) return res.status(400).json({ error: 'Pick one of your own addresses to send from.' });
  if (!addr.verified) return res.status(400).json({ error: 'Verify that address before sending from it.' });

  const attachBytes = attachments.reduce((n, a) => n + Math.ceil((a.content || '').length * 0.75), 0);
  const size = Buffer.byteLength(subject + bodyText + (bodyHtml || '')) + attachBytes;

  if (Number(req.user.used_bytes) + size > Number(req.user.quota_bytes)) {
    return res.status(402).json({ error: 'Your mailbox is full. Upgrade your plan to keep sending.', code: 'quota' });
  }

  let provider;
  try {
    provider = await sendMail({
      from: addr.label ? `${addr.label} <${addr.address}>` : addr.address,
      to: recipients, cc: ccList, subject, text: bodyText, html: bodyHtml, replyTo: addr.address, attachments,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const msg = await tx(async (c) => {
    const m = (await c.query(
      `insert into messages (user_id, address_id, direction, folder, from_addr, from_name, to_addrs, cc_addrs,
                             subject, snippet, body_text, body_html, thread_key, unread, size_bytes, provider_id)
       values ($1,$2,'outbound','sent',$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12,$13) returning *`,
      [req.user.id, addr.id, addr.address, addr.label, recipients, ccList, subject,
       snippetOf(bodyText || bodyHtml), bodyText, bodyHtml || null, threadKeyOf(subject), size, provider?.id || null]
    )).rows[0];

    for (const a of attachments) {
      const buf = Buffer.from(a.content, 'base64');
      await c.query(
        'insert into attachments (message_id, user_id, filename, content_type, size_bytes, data) values ($1,$2,$3,$4,$5,$6)',
        [m.id, req.user.id, a.filename, a.contentType || null, buf.length, buf]
      );
    }
    await c.query('update users set used_bytes = used_bytes + $1 where id = $2', [size, req.user.id]);
    return m;
  });

  res.json({ ok: true, message: msg });
});

// ---------- update / delete ----------
router.patch('/:id', async (req, res) => {
  const sets = [];
  const args = [req.params.id, req.user.id];
  for (const [key, col] of [['starred', 'starred'], ['unread', 'unread'], ['folder', 'folder'], ['category', 'category']]) {
    if (req.body[key] !== undefined) { args.push(req.body[key]); sets.push(`${col} = $${args.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  const m = await one(
    `update messages set ${sets.join(', ')} where id = $1 and user_id = $2 returning *`, args);
  if (!m) return res.status(404).json({ error: 'That message is no longer here.' });
  res.json({ message: m });
});

router.delete('/:id', async (req, res) => {
  const m = await one('select * from messages where id = $1 and user_id = $2', [req.params.id, req.user.id]);
  if (!m) return res.status(404).json({ error: 'That message is no longer here.' });
  if (m.folder !== 'trash') {
    await query("update messages set folder = 'trash' where id = $1", [m.id]);
    return res.json({ ok: true, trashed: true });
  }
  await tx(async (c) => {
    await c.query('delete from messages where id = $1', [m.id]);
    await c.query('update users set used_bytes = greatest(0, used_bytes - $1) where id = $2', [m.size_bytes, req.user.id]);
  });
  res.json({ ok: true, deleted: true });
});

module.exports = router;
module.exports.snippetOf = snippetOf;
module.exports.threadKeyOf = threadKeyOf;

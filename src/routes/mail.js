const router = require('express').Router();
const { one, many, query, tx } = require('../db');
const { requireUser } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');

router.use(requireUser);

// ---------- helpers ----------
const snippetOf = (t = '') => String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
const threadKeyOf = (subject = '') =>
  subject.toLowerCase().replace(/^(re|fwd|fw)\s*:\s*/gi, '').trim().slice(0, 120) || 'no-subject';

const EMAIL_RE = /^(?:[^<>]*<\s*)?[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+\s*>?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FOLDERS = new Set(['inbox', 'sent', 'drafts', 'trash', 'spam']);
const CATEGORIES = new Set(['primary', 'social', 'promotions', 'updates']);

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;   // per file
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;      // whole message

// Accept commas, semicolons, or newlines between addresses.
function parseList(input) {
  return (Array.isArray(input) ? input : String(input || '').split(/[,;\n]/))
    .flatMap((s) => String(s).split(/[;\n]/))
    .map((s) => s.trim())
    .filter(Boolean);
}

// Bare address out of "Name <a@b.com>", lowercased.
const bareAddress = (s) => (/<([^>]+)>/.exec(s)?.[1] || s).toLowerCase().trim();

// A user's search text must not act as a LIKE pattern.
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// Reject a non-UUID before it reaches Postgres, which would throw 22P02 and surface as a 500.
function guardUuid(req, res, next) {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'That message is no longer here.' });
  next();
}

// ---------- list ----------
router.get('/', async (req, res) => {
  const { folder = 'inbox', category, starred, q, address } = req.query;
  const where = ['m.user_id = $1'];
  const args = [req.user.id];

  if (starred === '1') {
    where.push("m.folder <> 'trash'", 'm.starred = true');
  } else {
    if (!FOLDERS.has(folder)) return res.status(400).json({ error: 'Unknown folder.' });
    args.push(folder); where.push(`m.folder = $${args.length}`);
    if (category && folder === 'inbox') {
      if (!CATEGORIES.has(category)) return res.status(400).json({ error: 'Unknown category.' });
      args.push(category); where.push(`m.category = $${args.length}`);
    }
  }

  if (address) {
    if (!UUID_RE.test(address)) return res.status(400).json({ error: 'Unknown address.' });
    args.push(address); where.push(`m.address_id = $${args.length}`);
  }

  if (q) {
    args.push(`%${likeEscape(q)}%`);
    where.push(`(m.subject ilike $${args.length} or m.from_addr ilike $${args.length} or m.snippet ilike $${args.length})`);
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  args.push(limit, offset);

  const rows = await many(
    `select m.id, m.folder, m.category, m.from_addr, m.from_name, m.to_addrs, m.subject, m.snippet,
            m.starred, m.unread, m.size_bytes, m.created_at, m.direction,
            (select count(*)::int from attachments a where a.message_id = m.id) as attachment_count
     from messages m where ${where.join(' and ')}
     order by m.created_at desc
     limit $${args.length - 1} offset $${args.length}`, args
  );
  res.json({ messages: rows, limit, offset, hasMore: rows.length === limit });
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
router.get('/:id', guardUuid, async (req, res) => {
  const m = await one('select * from messages where id = $1 and user_id = $2', [req.params.id, req.user.id]);
  if (!m) return res.status(404).json({ error: 'That message is no longer here.' });
  await query('update messages set unread = false where id = $1', [m.id]);
  m.unread = false;
  m.attachments = await many(
    'select id, filename, content_type, size_bytes from attachments where message_id = $1', [m.id]);
  res.json({ message: m });
});

router.get('/:id/attachments/:aid', guardUuid, async (req, res) => {
  if (!UUID_RE.test(req.params.aid)) return res.status(404).send('Not found');
  const a = await one(
    'select * from attachments where id = $1 and message_id = $2 and user_id = $3',
    [req.params.aid, req.params.id, req.user.id]
  );
  if (!a) return res.status(404).send('Not found');

  // Never echo a sender-supplied content type back on our own origin: an attachment
  // claiming text/html would run as a same-origin script. Force a download instead.
  const safeName = a.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'attachment';
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; sandbox");
  res.setHeader('content-disposition', `attachment; filename="${safeName}"`);
  res.send(a.data);
});

// ---------- send ----------
router.post('/send', async (req, res) => {
  const { from, to, cc = [], subject = '', bodyText = '', bodyHtml, attachments = [] } = req.body;

  const recipients = parseList(to);
  const ccList = parseList(cc);
  if (!recipients.length) return res.status(400).json({ error: 'Add at least one recipient.' });
  if (recipients.length + ccList.length > 100) {
    return res.status(400).json({ error: 'That is too many recipients for one message.' });
  }

  const bad = [...recipients, ...ccList].find((a) => !EMAIL_RE.test(a));
  if (bad) return res.status(400).json({ error: `${bad} is not a valid email address.` });

  if (!Array.isArray(attachments)) return res.status(400).json({ error: 'Attachments are malformed.' });
  if (attachments.length > MAX_ATTACHMENTS) {
    return res.status(400).json({ error: `Attach at most ${MAX_ATTACHMENTS} files.` });
  }

  const addr = await one(
    'select * from addresses where user_id = $1 and address = $2',
    [req.user.id, String(from || '').toLowerCase()]
  );
  if (!addr) return res.status(400).json({ error: 'Pick one of your own addresses to send from.' });
  if (!addr.verified) return res.status(400).json({ error: 'Verify that address before sending from it.' });

  // Decode once, up front: we need real byte counts, and malformed base64 should
  // fail here rather than halfway through the transaction.
  let files;
  try {
    files = attachments.map((a) => {
      const buf = Buffer.from(String(a.content || ''), 'base64');
      if (!buf.length) throw new Error(`${a.filename || 'A file'} is empty or could not be read.`);
      if (buf.length > MAX_ATTACHMENT_BYTES) {
        throw new Error(`${a.filename || 'A file'} is over the 10 MB limit.`);
      }
      return { filename: String(a.filename || 'attachment').slice(0, 255), contentType: a.contentType || null, buf };
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const size = Buffer.byteLength(subject + bodyText + (bodyHtml || ''))
    + files.reduce((n, f) => n + f.buf.length, 0);
  if (size > MAX_MESSAGE_BYTES) return res.status(413).json({ error: 'That message is too large to send.' });

  // Reserve the space atomically. A read-then-write check lets two concurrent
  // sends both pass while over quota; this cannot.
  const reserved = await one(
    `update users set used_bytes = used_bytes + $1
     where id = $2 and used_bytes + $1 <= quota_bytes
     returning used_bytes`, [size, req.user.id]
  );
  if (!reserved) {
    return res.status(402).json({ error: 'Your mailbox is full. Upgrade your plan to keep sending.', code: 'quota' });
  }

  const release = () => query(
    'update users set used_bytes = greatest(0, used_bytes - $1) where id = $2',
    [size, req.user.id]).catch(() => {});

  let provider;
  try {
    provider = await sendMail({
      from: addr.label ? `${addr.label} <${addr.address}>` : addr.address,
      to: recipients, cc: ccList, subject, text: bodyText, html: bodyHtml, replyTo: addr.address,
      attachments: files.map((f) => ({ filename: f.filename, content: f.buf.toString('base64') })),
    });
  } catch (e) {
    await release();
    return res.status(502).json({ error: e.message });
  }

  let msg;
  try {
    msg = await tx(async (c) => {
      const row = (await c.query(
        `insert into messages (user_id, address_id, direction, folder, from_addr, from_name, to_addrs, cc_addrs,
                               subject, snippet, body_text, body_html, thread_key, unread, size_bytes, provider_id)
         values ($1,$2,'outbound','sent',$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12,$13) returning *`,
        [req.user.id, addr.id, addr.address, addr.label, recipients, ccList, subject,
         snippetOf(bodyText || bodyHtml), bodyText, bodyHtml || null, threadKeyOf(subject), size,
         provider?.id || null]
      )).rows[0];

      for (const f of files) {
        await c.query(
          'insert into attachments (message_id, user_id, filename, content_type, size_bytes, data) values ($1,$2,$3,$4,$5,$6)',
          [row.id, req.user.id, f.filename, f.contentType, f.buf.length, f.buf]
        );
      }
      return row;
    });
  } catch (e) {
    await release();
    throw e;
  }

  // Deliver straight to any recipient who is also on LSPMail, so internal mail
  // arrives without waiting on a round trip through the inbound webhook.
  let localDeliveries = 0;
  for (const rcpt of [...recipients, ...ccList].map(bareAddress)) {
    try {
      const target = await one('select * from addresses where address = $1 and verified', [rcpt]);
      if (!target || target.user_id === req.user.id) continue;

      const ok = await one(
        `update users set used_bytes = used_bytes + $1
         where id = $2 and used_bytes + $1 <= quota_bytes returning id`, [size, target.user_id]);
      if (!ok) continue; // their mailbox is full

      await tx(async (c) => {
        const row = (await c.query(
          `insert into messages (user_id, address_id, direction, folder, category, from_addr, from_name,
                                 to_addrs, cc_addrs, subject, snippet, body_text, body_html, thread_key, size_bytes)
           values ($1,$2,'inbound','inbox','primary',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [target.user_id, target.id, addr.address, addr.label, recipients, ccList, subject,
           snippetOf(bodyText || bodyHtml), bodyText, bodyHtml || null, threadKeyOf(subject), size]
        )).rows[0];

        for (const f of files) {
          await c.query(
            'insert into attachments (message_id, user_id, filename, content_type, size_bytes, data) values ($1,$2,$3,$4,$5,$6)',
            [row.id, target.user_id, f.filename, f.contentType, f.buf.length, f.buf]
          );
        }
      });
      localDeliveries++;
    } catch (e) {
      console.error('local delivery failed for', rcpt, e.message);
    }
  }

  res.json({ ok: true, message: msg, localDeliveries });
});

// ---------- update ----------
router.patch('/:id', guardUuid, async (req, res) => {
  const sets = [];
  const args = [req.params.id, req.user.id];

  if (req.body.starred !== undefined) { args.push(!!req.body.starred); sets.push(`starred = $${args.length}`); }
  if (req.body.unread !== undefined) { args.push(!!req.body.unread); sets.push(`unread = $${args.length}`); }

  if (req.body.folder !== undefined) {
    if (!FOLDERS.has(req.body.folder)) return res.status(400).json({ error: 'Unknown folder.' });
    args.push(req.body.folder); sets.push(`folder = $${args.length}`);
  }
  if (req.body.category !== undefined) {
    if (!CATEGORIES.has(req.body.category)) return res.status(400).json({ error: 'Unknown category.' });
    args.push(req.body.category); sets.push(`category = $${args.length}`);
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

  const m = await one(
    `update messages set ${sets.join(', ')} where id = $1 and user_id = $2 returning *`, args);
  if (!m) return res.status(404).json({ error: 'That message is no longer here.' });
  res.json({ message: m });
});

// ---------- delete ----------
router.delete('/:id', guardUuid, async (req, res) => {
  const m = await one('select * from messages where id = $1 and user_id = $2', [req.params.id, req.user.id]);
  if (!m) return res.status(404).json({ error: 'That message is no longer here.' });

  if (m.folder !== 'trash') {
    await query("update messages set folder = 'trash' where id = $1", [m.id]);
    return res.json({ ok: true, trashed: true });
  }

  await tx(async (c) => {
    await c.query('delete from messages where id = $1', [m.id]);
    await c.query('update users set used_bytes = greatest(0, used_bytes - $1) where id = $2',
      [m.size_bytes, req.user.id]);
  });
  res.json({ ok: true, deleted: true });
});

// Empty the trash and reclaim the space in one pass.
router.post('/trash/empty', async (req, res) => {
  const freed = await tx(async (c) => {
    const rows = (await c.query(
      "delete from messages where user_id = $1 and folder = 'trash' returning size_bytes", [req.user.id])).rows;
    const total = rows.reduce((n, r) => n + Number(r.size_bytes), 0);
    await c.query('update users set used_bytes = greatest(0, used_bytes - $1) where id = $2', [total, req.user.id]);
    return { count: rows.length, bytes: total };
  });
  res.json({ ok: true, ...freed });
});

module.exports = router;
module.exports.snippetOf = snippetOf;
module.exports.threadKeyOf = threadKeyOf;
module.exports.parseList = parseList;
module.exports.EMAIL_RE = EMAIL_RE;

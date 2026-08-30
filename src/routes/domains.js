const router = require('express').Router();
const dns = require('dns').promises;
const { one, many, query } = require('../db');
const { requireUser } = require('../middleware/auth');
const { resend } = require('../lib/mailer');
const { DOMAIN_PRICE_PAISE } = require('../lib/plans');

router.use(requireUser);

const TLDS = ['.com', '.in', '.co', '.io', '.app', '.email'];

// Availability check: a domain with no NS records is almost certainly unregistered.
router.get('/search', async (req, res) => {
  const base = String(req.query.q || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (base.length < 2) return res.status(400).json({ error: 'Type at least two characters.' });

  const results = await Promise.all(TLDS.map(async (tld) => {
    const domain = base + tld;
    let available = true;
    try { const ns = await dns.resolveNs(domain); available = !ns.length; } catch { available = true; }
    const owned = await one('select 1 from domains where domain = $1', [domain]);
    return { domain, tld, available: available && !owned, pricePaise: DOMAIN_PRICE_PAISE };
  }));
  res.json({ results });
});

router.get('/', async (req, res) => {
  res.json({ domains: await many('select * from domains where user_id = $1 order by created_at desc', [req.user.id]) });
});

// After payment clears, register the domain with Resend so it can send mail.
router.post('/:domain/connect', async (req, res) => {
  const row = await one('select * from domains where domain = $1 and user_id = $2',
    [req.params.domain, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Buy this domain first.' });

  try {
    const { data, error } = await resend.domains.create({ name: row.domain });
    if (error) throw new Error(error.message);
    await query('update domains set resend_id = $1, dns_records = $2, status = $3 where id = $4',
      [data.id, JSON.stringify(data.records || []), 'verifying', row.id]);
    res.json({ domain: row.domain, records: data.records || [] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/:domain/verify', async (req, res) => {
  const row = await one('select * from domains where domain = $1 and user_id = $2',
    [req.params.domain, req.user.id]);
  if (!row?.resend_id) return res.status(400).json({ error: 'Connect the domain first.' });
  try {
    await resend.domains.verify(row.resend_id);
    const { data } = await resend.domains.get(row.resend_id);
    const status = data?.status === 'verified' ? 'active' : 'verifying';
    await query('update domains set status = $1 where id = $2', [status, row.id]);
    res.json({ status, records: data?.records || row.dns_records });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;

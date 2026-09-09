/**
 * Billing through LSP-Pay.
 *
 * Flow: our server creates an order over HTTP Basic auth, the browser opens the
 * returned checkoutUrl, and we confirm the result two ways — a signed webhook
 * for speed, and polling as a safety net. The browser is never trusted to
 * report a payment.
 *
 * Note LSP-Pay takes amounts in RUPEES. We store paise internally (as the
 * orders table always has), so every outbound amount is divided by 100.
 */
const router = require('express').Router();
const crypto = require('crypto');
const { one, many, query, tx } = require('../db');
const { requireUser } = require('../middleware/auth');
const { PLANS, DOMAIN_PRICE_PAISE } = require('../lib/plans');

const BASE = (process.env.LSPPAY_URL || '').replace(/\/+$/, '');
const KEY_ID = process.env.LSPPAY_KEY_ID;
const SECRET = process.env.LSPPAY_SECRET;
const WEBHOOK_SECRET = process.env.LSPPAY_WEBHOOK_SECRET;
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

const configured = () => Boolean(BASE && KEY_ID && SECRET);
const basicAuth = () => 'Basic ' + Buffer.from(`${KEY_ID}:${SECRET}`).toString('base64');

async function lsp(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      authorization: basicAuth(),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || `LSP-Pay returned ${r.status}`);
  return data;
}

router.get('/config', (_req, res) => res.json({ enabled: configured(), provider: 'LSP-Pay' }));
router.get('/plans', (_req, res) => res.json({ plans: PLANS, domainPricePaise: DOMAIN_PRICE_PAISE }));

// ---------- create ----------
router.post('/order', requireUser, async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'Payments are not switched on yet.' });

  const { kind, sku } = req.body;
  let paise, label;

  if (kind === 'plan') {
    const plan = PLANS[sku];
    if (!plan || !plan.paise) return res.status(400).json({ error: 'Pick a paid plan.' });
    paise = plan.paise;
    label = `LSPMail ${plan.name} — one month`;
  } else if (kind === 'domain') {
    if (!/^[a-z0-9-]+\.[a-z.]{2,}$/i.test(String(sku || ''))) {
      return res.status(400).json({ error: 'That domain name is not valid.' });
    }
    paise = DOMAIN_PRICE_PAISE;
    label = `Domain ${sku} — one year`;
  } else {
    return res.status(400).json({ error: 'Unknown purchase.' });
  }

  // Our own reference, so the webhook can find this row without trusting anything else.
  const reference = `lspmail_${crypto.randomBytes(9).toString('hex')}`;

  let order;
  try {
    order = await lsp('/api/v1/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: paise / 100,            // LSP-Pay wants rupees
        description: label,
        reference,
        customer_email: req.user.email,
      }),
    });
  } catch (e) {
    console.error('LSP-Pay order failed:', e.message);
    return res.status(502).json({ error: `Could not start the payment. ${e.message}` });
  }

  await query(
    'insert into orders (user_id, razorpay_id, kind, sku, amount_paise, status) values ($1,$2,$3,$4,$5,$6)',
    [req.user.id, order.id, kind, sku, paise, 'created']
  );

  res.json({
    orderId: order.id,
    reference,
    checkoutUrl: order.checkoutUrl,
    amountLabel: order.amountLabel || `₹${(paise / 100).toLocaleString('en-IN')}`,
    expiresAt: order.expiresAt,
    label,
  });
});

// ---------- fulfilment ----------
async function fulfil(order) {
  if (order.status === 'paid') return false;
  await tx(async (c) => {
    const claimed = (await c.query(
      "update orders set status = 'paid' where id = $1 and status <> 'paid' returning id", [order.id]
    )).rowCount;
    if (!claimed) return;                       // another path got here first

    if (order.kind === 'plan') {
      const plan = PLANS[order.sku];
      await c.query('update users set plan = $1, quota_bytes = $2 where id = $3',
        [plan.id, plan.quota, order.user_id]);
    } else if (order.kind === 'domain') {
      const domain = order.sku.replace(/^domain:/, '');
      await c.query(
        `insert into domains (user_id, domain, status) values ($1,$2,'verifying')
         on conflict (domain) do update set status = 'verifying'`,
        [order.user_id, domain]
      );
    }
  });
  return true;
}

// ---------- webhook ----------
router.post('/webhook', async (req, res) => {
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(req.rawBody || '').digest('hex');
    const given = req.get('x-lsp-signature') || '';
    const ok = expected.length === given.length
      && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
    if (!ok) return res.status(400).json({ error: 'Bad signature' });
  }

  const { event, order } = req.body || {};
  if (event === 'order.paid' && order?.id) {
    const row = await one('select * from orders where razorpay_id = $1', [order.id]);
    if (row) await fulfil(row);
  }
  res.sendStatus(200);
});

// ---------- polling safety net ----------
router.get('/orders/:id/status', requireUser, async (req, res) => {
  const row = await one('select * from orders where razorpay_id = $1 and user_id = $2',
    [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Order not found.' });
  if (row.status === 'paid') return res.json({ status: 'paid', settled: true });

  try {
    const remote = await lsp(`/api/v1/orders/${encodeURIComponent(req.params.id)}`);
    if (remote.status === 'paid') {
      await fulfil(row);
      return res.json({ status: 'paid', settled: true });
    }
    if (remote.status === 'expired') {
      await query("update orders set status = 'expired' where id = $1", [row.id]);
    }
    return res.json({ status: remote.status, settled: false });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
});

router.get('/orders', requireUser, async (req, res) => {
  res.json({
    orders: await many(
      `select kind, sku, amount_paise, currency, status, created_at
       from orders where user_id = $1 order by created_at desc limit 50`, [req.user.id]),
  });
});

module.exports = router;

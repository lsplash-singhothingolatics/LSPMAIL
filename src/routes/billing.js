const router = require('express').Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { one, query, tx } = require('../db');
const { requireUser } = require('../middleware/auth');
const { PLANS, DOMAIN_PRICE_PAISE } = require('../lib/plans');

const rzp = process.env.RAZORPAY_KEY_ID
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

router.get('/plans', (_req, res) => res.json({ plans: PLANS, domainPricePaise: DOMAIN_PRICE_PAISE }));

// Step 1: create a Razorpay order the browser checkout can open.
router.post('/order', requireUser, async (req, res) => {
  if (!rzp) return res.status(503).json({ error: 'Payments are not switched on yet.' });

  const { kind, sku } = req.body;
  let amount, label;
  if (kind === 'plan') {
    const plan = PLANS[sku];
    if (!plan || !plan.paise) return res.status(400).json({ error: 'Pick a paid plan.' });
    amount = plan.paise; label = `LSPMail ${plan.name}`;
  } else if (kind === 'domain') {
    amount = DOMAIN_PRICE_PAISE; label = `Domain ${sku}`;
  } else {
    return res.status(400).json({ error: 'Unknown purchase.' });
  }

  const order = await rzp.orders.create({
    amount, currency: 'INR', receipt: `lsp_${Date.now()}`,
    notes: { user_id: req.user.id, kind, sku },
  });
  await query(
    'insert into orders (user_id, razorpay_id, kind, sku, amount_paise) values ($1,$2,$3,$4,$5)',
    [req.user.id, order.id, kind, sku, amount]
  );
  res.json({ orderId: order.id, amount, currency: 'INR', keyId: process.env.RAZORPAY_KEY_ID, label,
             prefill: { email: req.user.email, name: req.user.name || '' } });
});

async function fulfil(order) {
  if (order.status === 'paid') return;
  await tx(async (c) => {
    await c.query("update orders set status = 'paid' where id = $1", [order.id]);
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
}

// Step 2: browser hands back the signature after checkout closes.
router.post('/verify', requireUser, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (expected !== razorpay_signature) return res.status(400).json({ error: 'We could not verify that payment.' });

  const order = await one('select * from orders where razorpay_id = $1 and user_id = $2',
    [razorpay_order_id, req.user.id]);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  await query('update orders set payment_id = $1 where id = $2', [razorpay_payment_id, order.id]);
  await fulfil(order);
  res.json({ ok: true });
});

// Step 3 (belt and braces): Razorpay's server-to-server webhook.
router.post('/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const sig = req.get('x-razorpay-signature') || '';
  if (secret) {
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (expected !== sig) return res.status(401).json({ error: 'Bad signature' });
  }
  const event = req.body;
  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    const orderId = event.payload?.payment?.entity?.order_id || event.payload?.order?.entity?.id;
    const order = await one('select * from orders where razorpay_id = $1', [orderId]);
    if (order) await fulfil(order);
  }
  res.json({ ok: true });
});

router.get('/orders', requireUser, async (req, res) => {
  const { many } = require('../db');
  res.json({ orders: await many(
    'select kind, sku, amount_paise, currency, status, created_at from orders where user_id = $1 order by created_at desc limit 50',
    [req.user.id]) });
});

module.exports = router;

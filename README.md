# LSPMail

Webmail with 40 GB on the free tier. Node + Postgres, Resend for delivery, Razorpay for payments, deployed on Render.

- Sign in with Google, Yahoo, GitHub, or a one-time code emailed by Resend
- Inbox with Primary / Social / Promotions / Updates tabs, plus Starred
- Hold several addresses on one account and filter the inbox by any of them
- Send and receive real mail, attachments included
- Buy a domain for a business, then verify it for sending
- Storage metered per account: 40 GB free, paid tiers unlock more

---

## 1. Put it on GitHub

```bash
git init
git add .
git commit -m "LSPMail"
gh repo create lspmail --private --source=. --push
```

Or create the repo on github.com and:

```bash
git remote add origin https://github.com/YOUR_USER/lspmail.git
git push -u origin main
```

## 2. Deploy on Render

`render.yaml` is a Blueprint. In Render: **New → Blueprint → connect your repo**. It creates a Postgres instance and a web service, runs the migration during build, and health-checks `/healthz`.

Then fill in the secrets marked `sync: false` under the service's **Environment** tab. `APP_URL` must be the live URL Render gives you, with no trailing slash.

Deploying by hand instead:

- Build command: `npm ci && npm run migrate`
- Start command: `npm start`
- Add a Render Postgres instance and set `DATABASE_URL` from it

## 3. Sending mail — Resend

1. Add your domain in Resend and put the DKIM/SPF records at your DNS host.
2. Copy the API key into `RESEND_API_KEY`.
3. Set `MAIL_DOMAIN` to that domain and `OTP_FROM` to something like `LSPMail <login@yourdomain.com>`.

Until the domain is verified, Resend only delivers to the address that owns the account, so sign-in codes to other addresses will fail.

## 4. Receiving mail

Point inbound mail at `POST https://YOUR_APP/api/inbound`.

- **Resend inbound**: add the endpoint under Webhooks and copy the signing secret into `RESEND_INBOUND_SECRET`.
- **Cloudflare Email Routing** (free, works today): route your domain's catch-all to a Worker that POSTs `{from, to, subject, text, html}` to the same endpoint.

Delivery only lands for an address that exists in the `addresses` table and is verified. Mail for a full mailbox is refused rather than silently dropped.

## 5. Sign-in providers

Set each callback to `https://YOUR_APP/auth/<provider>/callback`.

| Provider | Console | Scopes |
|---|---|---|
| Google | console.cloud.google.com → OAuth client | `openid email profile` |
| GitHub | Settings → Developer settings → OAuth Apps | `read:user user:email` |
| Yahoo | developer.yahoo.com → Create App | `openid email profile` |

Any provider you leave unset is hidden from the login screen. One-time codes always work.

## 6. Payments — Razorpay

Put `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in the environment. Add a webhook pointing at `https://YOUR_APP/api/billing/webhook` for `payment.captured` and `order.paid`, and copy its secret into `RAZORPAY_WEBHOOK_SECRET`.

Payment is confirmed twice: once from the browser signature, once from the webhook. Either one upgrades the account, and fulfilment is idempotent.

Prices live in `src/lib/plans.js`:

| Plan | Storage | Price |
|---|---|---|
| Starter | 40 GB | Free |
| Pro | 500 GB | ₹299 / month |
| Business | 2 TB | ₹999 / month |

Domains are ₹999 / year.

## 7. Run it locally

```bash
cp .env.example .env      # fill in DATABASE_URL and RESEND_API_KEY
npm install
npm run migrate
npm run dev               # http://localhost:3000
```

Set `APP_URL=http://localhost:3000` so OAuth callbacks resolve.

---

## What's wired and what isn't

Working end to end: auth, mailboxes, send, receive, attachments, quota accounting, plan upgrades, domain search and DNS setup.

Two things need a decision before launch:

- **Domain purchase.** Checkout takes the payment and records the domain, but no registrar is called. Drop a ResellerClub, GoDaddy, or Namecheap reseller call into `fulfil()` in `src/routes/billing.js` to actually register it.
- **Attachments in Postgres.** Files are stored as `bytea`, which is fine at small scale and expensive past a few GB. Move to S3 or Cloudflare R2 before you have real volume — the `attachments` table already tracks size separately from the blob, so swapping in a key is a small change.

## Layout

```
src/
  server.js        express app, static hosting, route mounting
  schema.sql       tables
  db.js            pg pool, query helpers, transactions
  lib/             tokens (JWT + OTP), plans, Resend wrapper
  middleware/      session → req.user
  routes/
    auth.js        OAuth for 3 providers + one-time codes
    mail.js        list, read, send, star, trash, attachments
    accounts.js    addresses: claim, connect, confirm, primary
    inbound.js     webhook that receives mail
    billing.js     Razorpay orders, signature check, webhook
    domains.js     availability search, Resend domain setup
public/
  index.html       sign-in
  app.html         mailbox
  css/app.css      design tokens + all styling
  js/              login.js, app.js
```

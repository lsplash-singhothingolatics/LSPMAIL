# LSPMail — OAuth provider + partner search

Upload these keeping the folders exactly as they are here.

```
src/server.js            replaces yours — mounts /oauth, keeps your /app.html route
src/schema.sql           replaces yours — adds the oauth_codes table
src/routes/oauth.js      NEW
src/routes/partner.js    NEW  (move it out of lspco-search if it's there)
src/routes/auth.js       replaces yours
public/js/app.js         replaces yours
public/js/login.js       replaces yours
```

On GitHub, navigate INTO the destination folder first, then Add file → Upload
files. Uploading from the repo root drops everything at the root.

## Environment (Render → lspmail → Environment)

```
PARTNER_SECRET        same value as on LSPSO
OAUTH_CLIENT_ID       lspso
OAUTH_CLIENT_SECRET   a second random value, also set on LSPSO
OAUTH_CLIENT_NAME     LSPSO
OAUTH_REDIRECT_URIS   https://lspso.onrender.com/auth/lspmail/callback
```

Generate each with `openssl rand -hex 32`. PARTNER_SECRET and
OAUTH_CLIENT_SECRET are DIFFERENT values — one signs search requests, the other
authenticates the OAuth client.

On LSPSO the matching names are:

```
PARTNER_SECRET         same as above
LSPMAIL_CLIENT_ID      lspso
LSPMAIL_CLIENT_SECRET  same as OAUTH_CLIENT_SECRET
LSPMAIL_URL            https://lspmail.onrender.com
```

## Migration

`oauth_codes` is created by `npm run migrate`, which runs at startup. If your
start command is still plain `npm start`, change it to:

```
npm run migrate && npm start
```

Otherwise the table never gets created and every sign-in fails at the token step.

## Checking it worked

| URL | Expected |
|---|---|
| `lspmail.onrender.com/oauth/.well-known/openid-configuration` | three endpoints |
| `lspso.onrender.com/mail` | results, once PARTNER_SECRET matches both sides |
| `lspso.onrender.com/auth/lspmail` | LSPMail consent screen |

A 404 on the first means `oauth.js` or `server.js` did not land.

## What each file does

**oauth.js** — the provider. `/oauth/authorize` shows a consent screen,
`/oauth/token` exchanges a single-use code (PKCE S256 supported),
`/oauth/userinfo` returns sub, email and name to a Bearer token.

**partner.js** — `/api/partner/search`, which LSPSO calls to search your mail.
HMAC signed, verified addresses only, headers and snippets only — never message
bodies.

**auth.js + login.js** — after signing in you return to whatever sent you there.
Without these, approving an OAuth request bounces you to the inbox and you have
to click the button twice.

**server.js** — mounts `/oauth` and `/api/partner`. Also stops reporting
`razorpay` in `/api/config`, since billing moved to LSP-Pay.

**app.js** — the mailbox. Sign-out menu on the avatar, LSP-Pay checkout, and
`?msg=<id>` deep links so a result in LSPSO opens that message directly.

const $ = (s, r = document) => r.querySelector(s);
const msg = $('#msg');

const say = (text, kind = 'error') => {
  msg.innerHTML = text ? `<div class="notice ${kind}">${text}</div>` : '';
};

const MARKS = {
  google: `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.4a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.6-5.2 3.6-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3a7.2 7.2 0 0 1-10.7-3.8h-4v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.3a7.1 7.1 0 0 1 0-4.6v-3.1h-4a12 12 0 0 0 0 10.8l4-3.1z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.5-3.5A12 12 0 0 0 1.3 6.6l4 3.1A7.2 7.2 0 0 1 12 4.8z"/></svg>`,
  yahoo: `<svg viewBox="0 0 24 24"><path fill="#6001D2" d="M1 5.4h4.2l2.9 7.1 3-7.1h4.1L9 20.3H4.8l1.6-3.7L1 5.4zm16.3 6.3a2.4 2.4 0 1 1 0 4.9 2.4 2.4 0 0 1 0-4.9zM19.4 3.7h4.3l-4.5 6.7h-3.9l4.1-6.7z"/></svg>`,
  github: `<svg viewBox="0 0 24 24"><path fill="#1B1B18" d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.2.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.1.1 1.7 1.2 1.7 1.2 1 1.8 2.7 1.3 3.4 1 .1-.7.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .4.2.7.8.6A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>`,
};
const LABEL = { google: 'Continue with Google', yahoo: 'Continue with Yahoo', github: 'Continue with GitHub' };

(async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) say(params.get('error'));

  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({ providers: {} }));
  const box = $('#providers');
  const on = Object.entries(cfg.providers || {}).filter(([, v]) => v).map(([k]) => k);

  if (!on.length) {
    box.innerHTML = `<div class="notice">Social sign-in isn't switched on yet. Use a one-time code below.</div>`;
  } else {
    box.innerHTML = on.map((p) =>
      `<a class="btn provider" href="/auth/${p}">${MARKS[p]}<span>${LABEL[p]}</span></a>`
    ).join('');
  }
})();

// ---------- one-time code ----------
let pendingEmail = '';

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'That did not work. Try again.');
  return data;
}

$('#email-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#send-code');
  const email = $('#email').value.trim();
  btn.disabled = true; btn.textContent = 'Sending…'; say('');
  try {
    await post('/auth/otp/request', { email });
    pendingEmail = email;
    $('#sent-to').textContent = email;
    $('#step-choose').hidden = true;
    $('#step-code').hidden = false;
    $('#otp').firstElementChild.focus();
  } catch (err) {
    say(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Email me a code';
  }
});

const digits = [...document.querySelectorAll('#otp input')];
digits.forEach((input, i) => {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 1);
    if (input.value && i < digits.length - 1) digits[i + 1].focus();
    if (digits.every((d) => d.value)) verify();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && i > 0) digits[i - 1].focus();
  });
  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!text) return;
    e.preventDefault();
    text.split('').forEach((ch, k) => { if (digits[k]) digits[k].value = ch; });
    digits[Math.min(text.length, 5)].focus();
    if (text.length === 6) verify();
  });
});

async function verify() {
  const btn = $('#verify');
  btn.disabled = true; btn.textContent = 'Signing in…'; say('');
  try {
    await post('/auth/otp/verify', { email: pendingEmail, code: digits.map((d) => d.value).join('') });
    location.href = '/app';
  } catch (err) {
    say(err.message);
    digits.forEach((d) => (d.value = ''));
    digits[0].focus();
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

$('#verify').addEventListener('click', verify);

$('#back').addEventListener('click', () => {
  $('#step-code').hidden = true;
  $('#step-choose').hidden = false;
  say('');
});

$('#resend').addEventListener('click', async () => {
  try { await post('/auth/otp/request', { email: pendingEmail }); say('New code sent.', 'ok'); }
  catch (err) { say(err.message); }
});

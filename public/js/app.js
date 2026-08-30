const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  folder: 'inbox',
  category: 'primary',
  addressId: null,
  q: '',
  openId: null,
  me: null,
  addresses: [],
  plans: {},
};

const CATEGORIES = [
  ['primary', 'Primary'],
  ['social', 'Social'],
  ['promotions', 'Promotions'],
  ['updates', 'Updates'],
];

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const bytes = (n) => {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};

const when = (iso) => {
  const d = new Date(iso), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: '2-digit' });
};

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const initials = (s = '') => s.replace(/[^a-zA-Z ]/g, '').trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || s.slice(0, 2).toUpperCase();

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

async function api(url, opts = {}) {
  const r = await fetch(url, {
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || 'Something went wrong.'); e.code = data.code; e.status = r.status; throw e; }
  return data;
}

// ---------- boot ----------
(async function boot() {
  const p = new URLSearchParams(location.search);
  if (p.get('ok')) toast(p.get('ok'));
  if (p.get('error')) toast(p.get('error'));
  if (p.size) history.replaceState({}, '', '/app');

  await refreshMe();
  renderTabs();
  await Promise.all([loadMessages(), loadCounts()]);
})();

async function refreshMe() {
  const data = await api('/api/accounts/me');
  state.me = data.user;
  state.addresses = data.addresses;
  state.plans = data.plans;
  state.mailDomain = data.mailDomain;
  state.razorpayKeyId = data.razorpayKeyId;
  renderIdentity(data.domains);
}

// ---------- rail: identity, addresses, storage ----------
function renderIdentity(domains = []) {
  const u = state.me;
  $('#me').innerHTML = u.avatarUrl
    ? `<img src="${esc(u.avatarUrl)}" alt="">`
    : esc(initials(u.name || u.email));
  $('#me').title = `${u.name || u.email} · ${state.plans[u.plan].name}`;

  $('#addresses').innerHTML = state.addresses.map((a) => `
    <div class="addr ${state.addressId === a.id ? 'active' : ''}" data-address="${a.id}" title="${esc(a.address)}">
      <i class="dot ${a.verified ? '' : 'pending'}"></i>
      <span>${esc(a.address)}</span>
    </div>`).join('') || `<p style="font-size:12px;color:var(--faint);padding:4px 12px">No addresses yet.</p>`;

  $('#domains').innerHTML = domains.length
    ? domains.map((d) => `<div class="addr" title="${esc(d.status)}">
        <i class="dot ${d.status === 'active' ? '' : 'pending'}"></i><span>${esc(d.domain)}</span></div>`).join('')
    : `<p style="font-size:12px;color:var(--faint);padding:4px 12px">None yet.</p>`;

  renderMeter();
}

function renderMeter() {
  const { usedBytes, quotaBytes } = state.me;
  const pct = Math.min(1, usedBytes / quotaBytes);
  const SEGMENTS = 24;
  const lit = Math.max(usedBytes > 0 ? 1 : 0, Math.round(pct * SEGMENTS));
  const tone = pct > 0.92 ? 'full' : pct > 0.75 ? 'warn' : 'fill';

  $('#used').textContent = bytes(usedBytes);
  $('#cap').textContent = `of ${bytes(quotaBytes)}`;
  $('#tape').innerHTML = Array.from({ length: SEGMENTS },
    (_, i) => `<i class="${i < lit ? tone : ''}"></i>`).join('');

  const plan = state.plans[state.me.plan];
  $('#meter-note').innerHTML = pct > 0.9
    ? `Almost full. <a href="#" id="meter-upgrade">Add more storage</a>`
    : `${plan.name} plan${plan.paise ? '' : ' · free'}. <a href="#" id="meter-upgrade">See plans</a>`;
  $('#meter-upgrade')?.addEventListener('click', (e) => { e.preventDefault(); openPlans(); });
}

// ---------- tabs ----------
function renderTabs() {
  const tabs = $('#tabs');
  if (state.folder === 'inbox') {
    tabs.hidden = false;
    tabs.innerHTML = CATEGORIES.map(([id, label]) =>
      `<button class="tab ${state.category === id ? 'active' : ''}" data-cat="${id}">${label}</button>`).join('');
  } else {
    tabs.hidden = true;
    tabs.innerHTML = '';
  }
}

// ---------- message list ----------
async function loadMessages() {
  const list = $('#messages');
  list.innerHTML = `<p style="padding:20px;color:var(--faint);font-size:13px">Loading…</p>`;

  const params = new URLSearchParams();
  if (state.folder === 'starred') params.set('starred', '1');
  else {
    params.set('folder', state.folder);
    if (state.folder === 'inbox') params.set('category', state.category);
  }
  if (state.addressId) params.set('address', state.addressId);
  if (state.q) params.set('q', state.q);

  const { messages } = await api(`/api/mail?${params}`);

  if (!messages.length) {
    list.innerHTML = `<div class="empty" style="min-height:280px">
      <h3>Nothing here</h3>
      <p>${state.q ? 'No message matches that search.' : state.folder === 'inbox'
        ? 'New mail lands here. Share your address to get started.'
        : 'This folder is empty.'}</p></div>`;
    return;
  }

  list.innerHTML = messages.map((m) => {
    const who = state.folder === 'sent'
      ? `To ${esc((m.to_addrs || []).join(', '))}`
      : esc(m.from_name || m.from_addr);
    return `
    <article class="row ${m.unread ? 'unread' : ''} ${state.openId === m.id ? 'active' : ''}" data-id="${m.id}">
      <button class="star ${m.starred ? 'on' : ''}" data-star="${m.id}" aria-label="Star">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="${m.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6">
          <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/></svg>
      </button>
      <div style="min-width:0">
        <div class="row-top">
          <span class="row-from">${who}</span>
          <span class="row-time">${when(m.created_at)}</span>
        </div>
        <div class="row-sub">${m.attachment_count ? clipIcon() : ''}${esc(m.subject || '(no subject)')}</div>
        <div class="row-snip">${esc(m.snippet || '')}</div>
      </div>
    </article>`;
  }).join('');
}

const clipIcon = () => `<svg class="clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 6"/></svg>`;

async function loadCounts() {
  const { buckets, starred } = await api('/api/mail/counts');
  const inbox = buckets.filter((b) => b.folder === 'inbox').reduce((n, b) => n + Number(b.unread), 0);
  $('[data-count="inbox"]').textContent = inbox || '';
  $('[data-count="starred"]').textContent = starred || '';
}

// ---------- reader ----------
async function openMessage(id) {
  state.openId = id;
  $$('.row').forEach((r) => r.classList.toggle('active', r.dataset.id === id));
  document.body.classList.add('reading');

  const { message: m } = await api(`/api/mail/${id}`);
  const bodyHtml = m.body_html
    ? `<div class="reader-body">${m.body_html}</div>`
    : `<div class="reader-body">${esc(m.body_text || '')}</div>`;

  $('#reader').innerHTML = `
    <div class="reader-inner">
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button class="btn btn-ghost back-btn" id="back-list">← Back</button>
        <div style="flex:1"></div>
        <button class="icon-btn ${m.starred ? 'on' : ''}" id="r-star" title="Star">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="${m.starred ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/></svg>
        </button>
        <button class="icon-btn" id="r-trash" title="Move to trash">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
        </button>
      </div>

      <h1>${esc(m.subject || '(no subject)')}</h1>

      <div class="reader-meta">
        <div class="avatar">${esc(initials(m.from_name || m.from_addr))}</div>
        <div class="who">
          <div class="name">${esc(m.from_name || m.from_addr)}</div>
          <div class="addr-line">${esc(m.from_addr)} → ${esc((m.to_addrs || []).join(', '))}</div>
        </div>
        <div class="when">${new Date(m.created_at).toLocaleString()}</div>
      </div>

      ${bodyHtml}

      ${m.attachments?.length ? `<div class="attachments">${m.attachments.map((a) => `
        <a class="att" href="/api/mail/${m.id}/attachments/${a.id}">
          ${clipIcon()}<span>${esc(a.filename)}</span><span class="sz">${bytes(a.size_bytes)}</span>
        </a>`).join('')}</div>` : ''}

      <div class="reader-actions">
        <button class="btn btn-primary" id="r-reply">Reply</button>
        <button class="btn" id="r-forward">Forward</button>
      </div>
    </div>`;

  $('#back-list').onclick = () => document.body.classList.remove('reading');
  $('#r-star').onclick = async () => {
    const { message } = await api(`/api/mail/${m.id}`, { method: 'PATCH', body: { starred: !m.starred } });
    m.starred = message.starred;
    openMessage(m.id);
    loadCounts();
  };
  $('#r-trash').onclick = async () => {
    await api(`/api/mail/${m.id}`, { method: 'DELETE' });
    toast(m.folder === 'trash' ? 'Deleted for good' : 'Moved to trash');
    state.openId = null;
    document.body.classList.remove('reading');
    $('#reader').innerHTML = `<div class="empty"><h3>Nothing open</h3><p>Pick a message on the left.</p></div>`;
    loadMessages(); loadCounts(); refreshMe();
  };
  $('#r-reply').onclick = () => openCompose({
    to: m.from_addr,
    subject: /^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`,
    body: `\n\n—\nOn ${new Date(m.created_at).toLocaleString()}, ${m.from_addr} wrote:\n> ${(m.body_text || '').split('\n').join('\n> ')}`,
    title: 'Reply',
  });
  $('#r-forward').onclick = () => openCompose({
    subject: /^fwd:/i.test(m.subject || '') ? m.subject : `Fwd: ${m.subject || ''}`,
    body: `\n\n— Forwarded message —\nFrom: ${m.from_addr}\nSubject: ${m.subject}\n\n${m.body_text || ''}`,
    title: 'Forward',
  });

  loadMessages();
  loadCounts();
}

// ---------- events: rail + list ----------
$('#rail').addEventListener('click', async (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav) {
    state.folder = nav.dataset.folder;
    if (state.folder === 'inbox') state.category = 'primary';
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n === nav));
    renderTabs();
    $('#rail').classList.remove('open');
    return loadMessages();
  }
  const addr = e.target.closest('[data-address]');
  if (addr) {
    state.addressId = state.addressId === addr.dataset.address ? null : addr.dataset.address;
    renderIdentity();
    return loadMessages();
  }
});

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  state.category = tab.dataset.cat;
  renderTabs();
  loadMessages();
});

$('#messages').addEventListener('click', async (e) => {
  const star = e.target.closest('[data-star]');
  if (star) {
    e.stopPropagation();
    const on = star.classList.toggle('on');
    star.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
    await api(`/api/mail/${star.dataset.star}`, { method: 'PATCH', body: { starred: on } });
    loadCounts();
    if (state.folder === 'starred') loadMessages();
    return;
  }
  const row = e.target.closest('.row');
  if (row) openMessage(row.dataset.id);
});

let searchTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadMessages(); }, 260);
});

$('#menu').addEventListener('click', () => $('#rail').classList.toggle('open'));

// ---------- modals ----------
const open = (id) => ($(id).hidden = false);
const close = (id) => ($(id).hidden = true);
$$('[data-close]').forEach((b) => b.addEventListener('click', () => (b.closest('.scrim').hidden = true)));
$$('.scrim').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s) s.hidden = true; }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.scrim').forEach((s) => (s.hidden = true));
});

// ---------- compose ----------
let pendingFiles = [];

function openCompose({ to = '', subject = '', body = '', title = 'New message' } = {}) {
  pendingFiles = [];
  $('#compose-title').textContent = title;
  $('#c-from').innerHTML = state.addresses.filter((a) => a.verified)
    .map((a) => `<option value="${esc(a.address)}" ${a.is_primary ? 'selected' : ''}>${esc(a.address)}</option>`).join('');
  $('#c-to').value = to;
  $('#c-cc').value = '';
  $('#c-sub').value = subject;
  $('#c-body').value = body;
  $('#c-files').innerHTML = '';
  $('#c-status').textContent = '';
  open('#compose-modal');
  setTimeout(() => (to ? $('#c-body') : $('#c-to')).focus(), 40);
}

$('#compose').addEventListener('click', () => openCompose());

$('#c-attach').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    if (file.size > 8 * 1024 * 1024) { toast(`${file.name} is over the 8 MB limit`); continue; }
    const content = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.readAsDataURL(file);
    });
    pendingFiles.push({ filename: file.name, contentType: file.type, content, size: file.size });
  }
  e.target.value = '';
  $('#c-files').innerHTML = pendingFiles.map((f, i) =>
    `<span class="att">${esc(f.filename)} <span class="sz">${bytes(f.size)}</span>
     <button class="icon-btn" data-drop="${i}" style="width:20px;height:20px" aria-label="Remove">✕</button></span>`).join('');
});

$('#c-files').addEventListener('click', (e) => {
  const b = e.target.closest('[data-drop]');
  if (!b) return;
  pendingFiles.splice(Number(b.dataset.drop), 1);
  $('#c-attach').dispatchEvent(new Event('change'));
});

$('#c-send').addEventListener('click', async () => {
  const btn = $('#c-send');
  btn.disabled = true; $('#c-status').textContent = 'Sending…';
  try {
    await api('/api/mail/send', {
      method: 'POST',
      body: {
        from: $('#c-from').value,
        to: $('#c-to').value.split(',').map((s) => s.trim()).filter(Boolean),
        cc: $('#c-cc').value.split(',').map((s) => s.trim()).filter(Boolean),
        subject: $('#c-sub').value,
        bodyText: $('#c-body').value,
        attachments: pendingFiles,
      },
    });
    close('#compose-modal');
    toast('Sent');
    refreshMe(); loadMessages(); loadCounts();
  } catch (err) {
    $('#c-status').textContent = err.message;
    if (err.code === 'quota') openPlans();
  } finally {
    btn.disabled = false;
  }
});

// ---------- addresses ----------
$('#add-address').addEventListener('click', () => {
  $('#address-msg').innerHTML = '';
  $('#handle').placeholder = `yourname`;
  open('#address-modal');
});

const addrMsg = (t, kind = 'error') => ($('#address-msg').innerHTML = `<div class="notice ${kind}">${esc(t)}</div>`);

$('#claim').addEventListener('click', async () => {
  try {
    const { address } = await api('/api/accounts/addresses/claim', { method: 'POST', body: { handle: $('#handle').value } });
    addrMsg(`${address.address} is yours.`, 'ok');
    $('#handle').value = '';
    refreshMe();
  } catch (e) { addrMsg(e.message); if (e.code === 'plan') setTimeout(openPlans, 900); }
});

$('#connect').addEventListener('click', async () => {
  try {
    await api('/api/accounts/addresses', { method: 'POST', body: { address: $('#external').value } });
    addrMsg('Check that inbox for a confirmation link.', 'ok');
    $('#external').value = '';
    refreshMe();
  } catch (e) { addrMsg(e.message); if (e.code === 'plan') setTimeout(openPlans, 900); }
});

// ---------- plans + Razorpay ----------
function openPlans() {
  $('#plans').innerHTML = Object.values(state.plans).map((p) => `
    <div class="plan ${state.me.plan === p.id ? 'current' : ''}">
      <div class="plan-top">
        <span class="plan-name">${p.name} ${state.me.plan === p.id ? '<span class="badge">Current</span>' : ''}</span>
        <span class="plan-price">${p.paise ? rupees(p.paise) : 'Free'}${p.period ? `<small> /${p.period}</small>` : ''}</span>
      </div>
      <ul>${p.perks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${state.me.plan === p.id || !p.paise ? '' :
        `<button class="btn btn-primary" data-buy="${p.id}">Switch to ${p.name}</button>`}
    </div>`).join('');
  $('#plans-msg').innerHTML = '';
  open('#plans-modal');
}

$('#open-plans').addEventListener('click', openPlans);

$('#plans').addEventListener('click', (e) => {
  const b = e.target.closest('[data-buy]');
  if (b) pay('plan', b.dataset.buy, () => { refreshMe(); toast('Plan updated'); close('#plans-modal'); });
});

async function pay(kind, sku, onDone) {
  if (!state.razorpayKeyId) return toast('Payments are not switched on yet.');
  try {
    const order = await api('/api/billing/order', { method: 'POST', body: { kind, sku } });
    const rzp = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: 'LSPMail',
      description: order.label,
      order_id: order.orderId,
      prefill: order.prefill,
      theme: { color: '#2D4BE0' },
      handler: async (resp) => {
        try { await api('/api/billing/verify', { method: 'POST', body: resp }); onDone?.(); }
        catch (e) { toast(e.message); }
      },
      modal: { ondismiss: () => toast('Payment cancelled') },
    });
    rzp.open();
  } catch (e) { toast(e.message); }
}

// ---------- domains ----------
$('#open-domains').addEventListener('click', async () => {
  $('#d-results').innerHTML = '';
  $('#d-msg').innerHTML = '';
  open('#domains-modal');
  loadOwnedDomains();
});

async function loadOwnedDomains() {
  const { domains } = await api('/api/domains');
  $('#d-owned').innerHTML = domains.length ? `
    <span class="eyebrow" style="margin-top:8px;display:block">Your domains</span>
    ${domains.map((d) => `
      <div class="domain-row">
        <span class="nm">${esc(d.domain)}</span>
        <span class="status ${d.status === 'active' ? 'free' : ''}">${esc(d.status)}</span>
        ${d.status === 'active' ? '' :
          `<button class="btn" data-connect="${esc(d.domain)}">${d.resend_id ? 'Check DNS' : 'Set up sending'}</button>`}
      </div>
      ${d.dns_records?.length ? dnsTable(d.dns_records) : ''}`).join('')}` : '';
}

const dnsTable = (records) => `
  <table class="dns"><thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead><tbody>
  ${records.map((r) => `<tr><td>${esc(r.type)}</td><td>${esc(r.name)}</td><td>${esc(r.value)}</td></tr>`).join('')}
  </tbody></table>`;

$('#d-search').addEventListener('click', async () => {
  const q = $('#d-query').value.trim();
  $('#d-results').innerHTML = `<p style="color:var(--faint);font-size:13px">Checking…</p>`;
  try {
    const { results } = await api(`/api/domains/search?q=${encodeURIComponent(q)}`);
    $('#d-results').innerHTML = results.map((r) => `
      <div class="domain-row">
        <span class="nm">${esc(r.domain)}</span>
        <span class="status ${r.available ? 'free' : 'taken'}">${r.available ? 'available' : 'taken'}</span>
        ${r.available ? `<button class="btn btn-primary" data-domain="${esc(r.domain)}">${rupees(r.pricePaise)} / yr</button>` : ''}
      </div>`).join('');
  } catch (e) { $('#d-msg').innerHTML = `<div class="notice error">${esc(e.message)}</div>`; }
});

$('#domains-modal').addEventListener('click', async (e) => {
  const buy = e.target.closest('[data-domain]');
  if (buy) {
    return pay('domain', buy.dataset.domain, async () => {
      toast(`${buy.dataset.domain} is yours`);
      await loadOwnedDomains(); refreshMe();
    });
  }
  const setup = e.target.closest('[data-connect]');
  if (setup) {
    const domain = setup.dataset.connect;
    const path = setup.textContent.includes('Check') ? 'verify' : 'connect';
    setup.disabled = true; setup.textContent = 'Working…';
    try {
      await api(`/api/domains/${encodeURIComponent(domain)}/${path}`, { method: 'POST' });
      await loadOwnedDomains();
      toast('Add the DNS records shown, then check again.');
    } catch (err) { toast(err.message); setup.disabled = false; }
  }
});

// ---------- polling for new mail ----------
setInterval(() => {
  if (document.hidden) return;
  loadCounts();
  if (state.folder === 'inbox' && !state.q) loadMessages();
}, 30000);

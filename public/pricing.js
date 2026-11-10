// ChannelScope — Pricing page. Tokens + Stripe plans.
// Free: 100 tokens/day. Starter $2/mo = 1,500 tokens/mo. Pro $5/mo = 5,000.
// Checkout goes through Stripe (server-side); if payments are not configured
// the page says so instead of showing a fake checkout button.
const $ = s => document.querySelector(s);
let me = null, billing = null, paymentsEnabled = false;

async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...(opts || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    const e = new Error(j.error || ('Request failed: ' + r.status));
    e.status = r.status; e.data = j;
    throw e;
  }
  return j;
}
function fmt(n) { return (+n || 0).toLocaleString(); }
function setMsg(el, text, ok) {
  el.innerHTML = text ? `<div class="status ${ok ? 'ok' : 'err'}">${text}</div>` : '';
}

async function loadMe() {
  me = await api('/api/auth/me');
  $('#userChip').textContent = me.loggedIn ? me.email : 'Guest';
  $('#loginBtn').classList.toggle('hidden', me.loggedIn);
  $('#logoutBtn').classList.toggle('hidden', !me.loggedIn);
  if (me.loggedIn) {
    billing = await api('/api/billing/me');
    const tc = $('#tokenChip');
    tc.classList.remove('hidden');
    // Admins never pay tokens (v1.3.2) — the chip says so.
    const chipLabel = billing.unlimited ? 'Admin · Unlimited' : `${fmt(billing.balance)} tokens · ${billing.planName}`;
    tc.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1.1-3 2.5 1 2 3 2.5 3 1.1 3 2.5-1.3 2.5-3 2.5-3-1.1-3-2.5"/></svg><a href="/pricing.html">${chipLabel}</a>`;
    const period = billing.periodEnd ? ` · renews ${new Date(billing.periodEnd).toLocaleDateString()}` : '';
    $('#balanceLine').innerHTML = billing.unlimited
      ? `<b>Admin · Unlimited</b> — as the site owner you are never charged tokens. Current plan: <b>Admin</b>.`
      : `<b>${fmt(billing.balance)} tokens</b> available — ${fmt(billing.freeLeft)} free left today, ${fmt(billing.paidTokens)} from your plan. Current plan: <b>${billing.planName}</b>${period}.`;
  } else {
    $('#tokenChip').classList.add('hidden');
  }
}
$('#loginBtn').onclick = () => { $('#authModal').classList.remove('hidden'); };
$('#logoutBtn').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
$('#authCancel').onclick = () => $('#authModal').classList.add('hidden');
$('#authModal').onclick = e => { if (e.target.id === 'authModal') $('#authModal').classList.add('hidden'); };

let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('#tabLogin').classList.toggle('active', mode === 'login');
  $('#tabRegister').classList.toggle('active', mode === 'register');
  $('#authTitle').textContent = mode === 'login' ? 'Login' : 'Register';
  $('#authSubmit').textContent = mode === 'login' ? 'Login' : 'Register';
  setMsg($('#authMsg'), '');
}
$('#tabLogin').onclick = () => setAuthMode('login');
$('#tabRegister').onclick = () => setAuthMode('register');
$('#authSubmit').onclick = async () => {
  const email = $('#authEmail').value.trim();
  const pass = $('#authPass').value;
  try {
    await api('/api/auth/' + authMode, { method: 'POST', body: JSON.stringify({ email, password: pass }) });
    $('#authModal').classList.add('hidden');
    await loadMe(); await renderPlans();
  } catch (e) { setMsg($('#authMsg'), e.message); }
};

async function renderPlans() {
  const cfg = await api('/api/billing/config');
  paymentsEnabled = cfg.paymentsEnabled === true;
  const banner = $('#payBanner');
  const params = new URLSearchParams(location.search);
  if (params.get('checkout') === 'success') {
    banner.innerHTML = '<div class="status ok">Payment successful — your plan and tokens are being activated. If they do not appear within a minute, refresh this page.</div>';
  } else if (params.get('checkout') === 'cancelled') {
    banner.innerHTML = '<div class="status err">Checkout was cancelled — no payment was taken. You can try again anytime.</div>';
  } else if (!paymentsEnabled) {
    banner.innerHTML = '<div class="status info">Payments coming soon — plans will be available once configured.</div>';
  }
  const current = (me && me.loggedIn && billing) ? billing.plan : 'free';
  document.querySelectorAll('.plan-card').forEach(card => {
    const plan = card.dataset.plan;
    const btn = card.querySelector('.buy-btn, #freeBtn');
    const isCurrent = plan === current;
    card.classList.toggle('current', isCurrent);
    if (!btn) return;
    // Admins never pay (v1.3.2) — no plan buttons for the site owner.
    if (billing && billing.unlimited) { btn.disabled = true; btn.textContent = plan === 'free' ? 'Admin — unlimited' : 'Admin — included'; return; }
    if (plan === 'free') {
      if (!me || !me.loggedIn) {
        btn.textContent = 'Get started free';
        btn.disabled = false;
        btn.onclick = () => $('#authModal').classList.remove('hidden');
      } else {
        btn.textContent = isCurrent ? 'Current plan' : 'Free plan';
        btn.disabled = true;
      }
      return;
    }
    if (!paymentsEnabled) {
      btn.disabled = true;
      btn.textContent = 'Coming soon';
      return;
    }
    btn.disabled = false;
    const label = plan.charAt(0).toUpperCase() + plan.slice(1);
    btn.textContent = isCurrent ? 'Current plan' : (current === 'free' ? 'Buy ' + label : 'Upgrade to ' + label);
    if (isCurrent) btn.disabled = true;
  });
}

document.querySelectorAll('.buy-btn').forEach(btn => {
  btn.onclick = async () => {
    if (!me || !me.loggedIn) {
      setMsg($('#payBanner'), 'Please log in first to buy a plan.');
      $('#authModal').classList.remove('hidden');
      return;
    }
    if (!paymentsEnabled) return;
    btn.disabled = true;
    btn.textContent = 'Opening checkout…';
    try {
      const r = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: btn.dataset.plan }) });
      location.href = r.url;
    } catch (e) {
      setMsg($('#payBanner'), e.message);
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  };
});

(async () => {
  await loadMe();
  await renderPlans();
})();

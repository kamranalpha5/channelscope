// ChannelScope — Admin panel (direct URL only, never linked from public pages).
// Sections unlock only after an admin login (or first-run setup while no
// admin exists). All strings are English.
const $ = s => document.querySelector(s);
function setMsg(el, text, ok) {
  el.innerHTML = text ? `<div class="status ${ok ? 'ok' : 'err'}">${text}</div>` : '';
}
async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...(opts || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('Request failed: ' + r.status));
  return j;
}

let isSetup = false;

async function refresh() {
  const me = await api('/api/auth/me');
  isSetup = me.setupNeeded === true;
  const authed = me.loggedIn && me.role === 'admin';
  $('#setupBox').classList.toggle('hidden', !isSetup);
  $('#authTitle').textContent = isSetup ? 'Create admin account' : 'Admin login';
  $('#authSub').textContent = isSetup
    ? 'No admin account exists yet. The first account becomes the site owner.'
    : 'This panel is for the site owner only.';
  $('#authSubmit').textContent = isSetup ? 'Create admin' : 'Login';
  $('#logoutBtn').classList.toggle('hidden', !me.loggedIn);
  $('#panel').classList.toggle('hidden', !authed);
  $('#authCard').classList.toggle('hidden', authed);
  if (authed) {
    $('#adminWho').textContent = 'Logged in as ' + me.email;
    await loadKeyState();
    await loadUsers();
    await loadAllowlist();
    await loadQuota();
  }
}

$('#authSubmit').onclick = async () => {
  const email = $('#adminEmail').value.trim();
  const pass = $('#adminPass').value;
  try {
    if (isSetup) {
      await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ email, password: pass }) });
    } else {
      const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: pass }) });
      if (r.role !== 'admin') throw new Error('This panel is for the site owner only.');
    }
    setMsg($('#authMsg'), '');
    await refresh();
  } catch (e) { setMsg($('#authMsg'), e.message); }
};
$('#logoutBtn').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };

async function loadKeyState() {
  try {
    const s = await api('/api/status');
    $('#keyState').textContent = s.hasKey
      ? 'A key is set. ' + s.quotaUsed.toLocaleString() + ' / ' + s.quotaLimit.toLocaleString() + ' units used today.'
      : 'No key set yet — maps and trending will show “Service is being set up” until you add one.';
    $('#keyState').className = 'key-state ' + (s.hasKey ? 'ok' : 'warn');
  } catch (e) { $('#keyState').textContent = 'Could not check key status.'; }
}
$('#saveKeyBtn').onclick = async () => {
  const key = $('#keyInput').value.trim();
  if (!key) return setMsg($('#keyMsg'), 'Paste a key first.');
  setMsg($('#keyMsg'), 'Checking key…', true);
  try {
    const r = await api('/api/settings/key', { method: 'POST', body: JSON.stringify({ key }) });
    $('#keyInput').value = '';
    setMsg($('#keyMsg'), r.message || 'API key saved.', true);
    loadKeyState(); loadQuota();
  } catch (e) { setMsg($('#keyMsg'), e.message); }
};
$('#removeKeyBtn').onclick = async () => {
  if (!confirm('Remove the site API key? Maps and trending will stop working until a new key is set.')) return;
  try {
    await api('/api/settings/key', { method: 'DELETE' });
    setMsg($('#keyMsg'), 'Key removed.', true);
    loadKeyState(); loadQuota();
  } catch (e) { setMsg($('#keyMsg'), e.message); }
};

async function loadUsers() {
  try {
    const r = await api('/api/auth/admin/users');
    $('#userTable').innerHTML = r.users.length ? `<table class="users-table"><thead><tr><th>Email</th><th>Role</th><th>Plan</th><th>Balance</th><th>Free left today</th><th>Paid tokens</th><th>Period ends</th></tr></thead><tbody>` + r.users.map(u => `
      <tr><td>${u.email}</td><td>${u.role}</td><td>${u.planName}</td><td>${u.unlimited ? 'Unlimited' : u.balance.toLocaleString()}</td><td>${u.freeLeft.toLocaleString()}</td><td>${u.paidTokens.toLocaleString()}</td><td>${u.periodEnd ? new Date(u.periodEnd).toLocaleDateString() : '—'}</td></tr>`).join('') + `</tbody></table>`
      : '<p class="muted">No users yet.</p>';
  } catch (e) { $('#userTable').innerHTML = '<p class="muted">Could not load users.</p>'; }
}
$('#grantBtn').onclick = async () => {
  const email = $('#grantEmail').value.trim();
  const tokens = +$('#grantAmount').value;
  if (!email || !(tokens > 0)) return setMsg($('#grantMsg'), 'Enter an email and a token amount greater than 0.');
  try {
    const r = await api('/api/auth/admin/grant', { method: 'POST', body: JSON.stringify({ email, tokens }) });
    setMsg($('#grantMsg'), 'Granted ' + tokens + ' tokens to ' + email + ' (paid balance now ' + r.paidTokens.toLocaleString() + ').', true);
    $('#grantEmail').value = ''; $('#grantAmount').value = '';
    loadUsers();
  } catch (e) { setMsg($('#grantMsg'), e.message); }
};
$('#setPlanBtn').onclick = async () => {
  const email = $('#planEmail').value.trim();
  const plan = $('#planSelect').value;
  if (!email) return setMsg($('#planMsg'), 'Enter a user email.');
  try {
    const r = await api('/api/auth/admin/set-plan', { method: 'POST', body: JSON.stringify({ email, plan }) });
    setMsg($('#planMsg'), 'Plan for ' + email + ' set to ' + (r.plan === 'free' ? 'Free' : r.plan) + '.', true);
    $('#planEmail').value = '';
    loadUsers();
  } catch (e) { setMsg($('#planMsg'), e.message); }
};

async function loadAllowlist() {
  try {
    const r = await api('/api/auth/admin/allowlist');
    $('#allowList').innerHTML = r.allowlist.length ? r.allowlist.map(e => `
      <div class="allow-row"><span>${e}</span><button class="btn small danger" data-del="${e}">Remove</button></div>`).join('')
      : '<p class="muted">Allowlist is empty — no user sees unblurred data yet.</p>';
    $('#allowList').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      await api('/api/auth/admin/allowlist/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
      loadAllowlist();
    });
  } catch (e) { setMsg($('#allowMsg'), e.message); }
}
$('#allowAddBtn').onclick = async () => {
  const email = $('#allowEmail').value.trim();
  if (!email) return;
  try {
    const r = await api('/api/auth/admin/allowlist', { method: 'POST', body: JSON.stringify({ email }) });
    $('#allowEmail').value = '';
    setMsg($('#allowMsg'), 'Added: ' + email, true);
    $('#allowList').innerHTML = r.allowlist.map(e => `
      <div class="allow-row"><span>${e}</span><button class="btn small danger" data-del="${e}">Remove</button></div>`).join('');
    loadAllowlist();
  } catch (e) { setMsg($('#allowMsg'), e.message); }
};

async function loadQuota() {
  try {
    const s = await api('/api/status');
    $('#quotaLine').textContent = s.quotaUsed.toLocaleString() + ' / ' + s.quotaLimit.toLocaleString() + ' units used today (' + (s.quotaLimit - s.quotaUsed).toLocaleString() + ' remaining).';
  } catch (e) { $('#quotaLine').textContent = 'Could not load quota.'; }
}

refresh();

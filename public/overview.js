// ChannelScope — Overview page (home). Data comes ONLY from our own maps +
// trending scans via GET /api/overview. Non-allowed users get server-side
// masked data (names "•••", numbers null) — the blur here is cosmetic only.
const $ = s => document.querySelector(s);
let me = null, ov = null;
let compWindow = '24h', viralWindow = '30d', langFilter = 'all';
let viralList = [];

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, '') + 'K';
  return String(Math.round(n));
}
function ago(iso) {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return '1 day ago';
  if (d < 30) return d + ' days ago';
  if (d < 365) return Math.floor(d / 30) + ' mo ago';
  return Math.floor(d / 365) + ' yr ago';
}
async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...(opts || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('Request failed: ' + r.status));
  return j;
}
function dpHtml(thumb, title) {
  if (thumb) return `<img class="dp" src="/api/thumb?u=${encodeURIComponent(thumb)}" onerror="this.outerHTML='<div class=\\'dp-ph\\'>•</div>'">`;
  return `<div class="dp-ph">•</div>`;
}
function setMsg(el, text, ok) {
  el.innerHTML = text ? `<div class="status ${ok ? 'ok' : 'err'}">${text}</div>` : '';
}

// ---------- auth state ----------
async function loadMe() {
  me = await api('/api/auth/me');
  $('#userChip').textContent = me.loggedIn ? me.email : 'Guest';
  $('#greeting').innerHTML = me.loggedIn ? `Welcome, <b>${me.email}</b>!` : 'Welcome, <b>Guest</b>!';
  $('#loginBtn').classList.toggle('hidden', me.loggedIn);
  $('#logoutBtn').classList.toggle('hidden', !me.loggedIn);
  $('#setupCard').classList.toggle('hidden', !me.setupNeeded);
  $('#adminPanel').classList.toggle('hidden', me.role !== 'admin');
  if (me.role === 'admin') loadAllowlist();
}
$('#loginBtn').onclick = () => { $('#authModal').classList.remove('hidden'); };
$('#logoutBtn').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
$('#authCancel').onclick = () => $('#authModal').classList.add('hidden');

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
    const r = await api('/api/auth/' + authMode, { method: 'POST', body: JSON.stringify({ email, password: pass }) });
    $('#authModal').classList.add('hidden');
    await loadMe(); await loadOverview();
    if (!r.allowed) alert('Login ho gaya — lekin aapki email allowlist mein nahi hai, is liye data blurred dikhega. Access ke liye admin se rabta karo.');
  } catch (e) { setMsg($('#authMsg'), e.message); }
};
$('#setupBtn').onclick = async () => {
  try {
    await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ email: $('#setupEmail').value.trim(), password: $('#setupPass').value }) });
    location.reload();
  } catch (e) { setMsg($('#setupMsg'), e.message); }
};

// ---------- admin: allowlist ----------
async function loadAllowlist() {
  try {
    const r = await api('/api/auth/admin/allowlist');
    $('#allowList').innerHTML = r.allowlist.length ? r.allowlist.map(e => `
      <div class="allow-row"><span>${e}</span><button class="btn small danger" data-del="${e}">Remove</button></div>`).join('')
      : '<p class="muted">Allowlist khaali hai — kisi ko bhi unblurred data nahi dikhega.</p>';
    $('#allowList').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      await api('/api/auth/admin/allowlist/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
      loadAllowlist(); loadOverview();
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
    loadAllowlist(); loadOverview();
  } catch (e) { setMsg($('#allowMsg'), e.message); }
};

// ---------- overview data ----------
async function loadOverview() {
  const r = await api(`/api/overview?window=${compWindow}&viralWindow=${viralWindow}`);
  ov = r;
  $('#statTotal').innerHTML = fmt(r.totalChannels) + (r.todayAdded ? ` <small>+${fmt(r.todayAdded)} today</small>` : '');
  $('#statToday').textContent = r.todayAdded ? `+${r.todayAdded} channels aaj add hue` : 'Aaj koi naya channel add nahi hua';
  $('#statMaps').textContent = fmt(r.mapsBuilt);
  $('#statRuns').textContent = fmt(r.trendingRuns);
  $('#statVideos').textContent = fmt(r.videosStored);
  const banner = $('#accessBanner');
  if (r.allowed) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    banner.innerHTML = `<b>🔒 Limited view.</b> ${r.accessNote} ${me && me.loggedIn ? 'Aapki email allowlist mein nahi hai.' : 'Login karo — ye data sirf allowed users ko dikhta hai.'}`;
  }
  for (const id of ['recentBody', 'compBody', 'viralBody']) {
    document.getElementById(id).classList.toggle('masked', !r.allowed);
  }
  // language filter options from the recent data
  const langs = [...new Set((r.recentOutliers || []).map(c => c.language).filter(Boolean))];
  const sel = $('#langFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="all">All languages</option>' + langs.map(l => `<option value="${l}">${l}</option>`).join('');
  sel.value = langs.includes(cur) ? cur : 'all';
  langFilter = sel.value;
  renderRecent(); renderCompetition(); renderViral();
}
$('#langFilter').onchange = e => { langFilter = e.target.value; renderRecent(); };
$('#compTabs').querySelectorAll('.tab').forEach(b => b.onclick = () => {
  $('#compTabs').querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  compWindow = b.dataset.window;
  loadOverview();
});
$('#viralWindow').onchange = e => { viralWindow = e.target.value; loadOverview(); };
$('#randomBtn').onclick = () => {
  // Shuffle the CURRENT viral grid (client-side only — no API call).
  viralList = [...viralList].sort(() => Math.random() - 0.5);
  renderViralGrid();
};

function renderRecent() {
  const list = (ov.recentOutliers || []).filter(c => langFilter === 'all' || c.language === langFilter);
  const body = $('#recentBody');
  if (!list.length) {
    body.innerHTML = '<p class="muted">Pichle 24h mein koi naya outlier channel nahi mila. Pehle Trending 24h chalao (allowed users ke liye) — ya koi aur language filter try karo.</p>';
    return;
  }
  const maxM = Math.max(...list.map(c => c.bestMultiple || 0), 1);
  body.innerHTML = list.map(c => `
    <div class="orow">
      ${dpHtml(c.thumbnail, c.title)}
      <div class="grow"><div class="t">${c.title}</div><div class="m">${c.subs == null ? '—' : fmt(c.subs) + ' subscribers'}${c.ageDays ? ' · ' + c.ageDays + ' days old' : ''}</div></div>
      <div class="obar"><i style="width:${c.bestMultiple == null ? 0 : Math.max(4, Math.round(c.bestMultiple / maxM * 100))}%"></i></div>
      <span class="mult">${c.bestMultiple == null ? '—' : c.bestMultiple + '×'}</span>
    </div>`).join('');
}
function renderCompetition() {
  const list = ov.competition || [];
  const body = $('#compBody');
  if (!list.length) {
    body.innerHTML = `<p class="muted">Is period (${compWindow}) ke liye hamare paas data nahi hai — no data yet. Koi fake number nahi dikhaya ja raha; map banao ya Trending chalao to ye bhar jayega.</p>`;
    return;
  }
  body.innerHTML = `
    <div class="comp-cols"><span>Channel</span><span>Subs</span><span>Avg views</span><span class="hide-m">Videos</span><span class="hide-m">Days</span><span>Outlier</span></div>` +
    list.map(c => `
    <div class="comp-row">
      <div class="cell chan-cell">${dpHtml(c.thumbnail, c.title)}<span class="t">${c.title}</span></div>
      <div class="cell">${c.subs == null ? '—' : fmt(c.subs)}</div>
      <div class="cell">${c.avgViews == null ? '—' : fmt(c.avgViews)}</div>
      <div class="cell hide-m">${c.videoCount == null ? '—' : c.videoCount}</div>
      <div class="cell hide-m">${c.ageDays == null ? '—' : c.ageDays}</div>
      <div class="cell"><b>${c.bestMultiple == null ? '—' : c.bestMultiple + '×'}</b></div>
    </div>`).join('');
}
function renderViral() {
  viralList = ov.viralVideos || [];
  renderViralGrid();
}
function renderViralGrid() {
  const body = $('#viralBody');
  if (!viralList.length) {
    body.innerHTML = '<p class="muted">Is window mein koi viral video nahi mili (small channels &lt; 100K subs). Map banao ya Trending chalao to videos yahan aayengi.</p>';
    return;
  }
  body.innerHTML = `<div class="vgrid">` + viralList.map(v => `
    <div class="vcard">
      <div class="vthumb">${v.thumbnail ? `<img src="/api/thumb?u=${encodeURIComponent(v.thumbnail)}" onerror="this.style.display='none'">` : ''}<span class="vdur">${v.duration || '—'}</span></div>
      <div class="vbody">
        <div class="t">${v.title}</div>
        <div class="vchan">${dpHtml(v.channelThumbnail, v.channelTitle)}<span>${v.channelTitle}</span></div>
        <div class="vmeta">${v.views == null ? '—' : fmt(v.views) + ' views'} · ${ago(v.publishedAt)}<br>VPH: <b>${v.vph == null ? '—' : fmt(v.vph) + '/hr'}</b> · ${v.subs == null ? '—' : fmt(v.subs) + ' subs'}</div>
      </div>
    </div>`).join('') + `</div>`;
}

// ---------- init ----------
(async function init() {
  await loadMe();
  await loadOverview();
})();

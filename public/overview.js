// ChannelScope — Overview page (home). Data comes ONLY from our own maps +
// trending scans via GET /api/overview. Non-allowed users get server-side
// masked data (names "•••", numbers null) — the blur here is cosmetic only.
const $ = s => document.querySelector(s);
let me = null, ov = null;
function ytWatch(id) { return id ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(id) : null; }
function ytChannel(id, customUrl) {
  if (customUrl && String(customUrl).trim().startsWith('@')) return 'https://www.youtube.com/' + String(customUrl).trim();
  return id ? 'https://www.youtube.com/channel/' + encodeURIComponent(id) : null;
}
function linkOrText(url, inner, cls) {
  return url ? `<a class="${cls || 'yt-link'}" href="${url}" target="_blank" rel="noopener">${inner}</a>` : inner;
}
const SKEL_ROWS = '<div class="skel-row"><i class="skel skel-dp"></i><i class="skel skel-line" style="width:55%"></i><i class="skel skel-line" style="width:18%"></i></div><div class="skel-row"><i class="skel skel-dp"></i><i class="skel skel-line" style="width:45%"></i><i class="skel skel-line" style="width:22%"></i></div><div class="skel-row"><i class="skel skel-dp"></i><i class="skel skel-line" style="width:60%"></i><i class="skel skel-line" style="width:15%"></i></div>';
const SKEL_CARDS = '<div class="vgrid"><div class="skel-card"><i class="skel skel-thumb"></i><i class="skel skel-line" style="width:80%"></i><i class="skel skel-line" style="width:55%"></i></div><div class="skel-card"><i class="skel skel-thumb"></i><i class="skel skel-line" style="width:70%"></i><i class="skel skel-line" style="width:50%"></i></div><div class="skel-card"><i class="skel skel-thumb"></i><i class="skel skel-line" style="width:85%"></i><i class="skel skel-line" style="width:45%"></i></div></div>';
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
  const tc = $('#tokenChip');
  if (tc) {
    if (me.loggedIn) {
      try {
        const b = await api('/api/billing/me');
        tc.classList.remove('hidden');
        // Admins never pay tokens (v1.3.2) — the chip says so.
        const label = b.unlimited ? 'Admin · Unlimited' : `${fmt(b.balance)} tokens · ${b.planName}`;
        tc.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1.1-3 2.5 1 2 3 2.5 3 1.1 3 2.5-1.3 2.5-3 2.5-3-1.1-3-2.5"/></svg><a href="/pricing.html">${label}</a>`;
      } catch (e) { tc.classList.add('hidden'); }
    } else {
      tc.classList.add('hidden');
    }
  }
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
    if (!r.allowed) alert('Logged in — but your email does not have access yet, so data stays blurred. Contact the site owner for access.');
  } catch (e) { setMsg($('#authMsg'), e.message); }
};
// ---------- overview data ----------
async function loadOverview() {
  document.getElementById('recentBody').innerHTML = SKEL_ROWS;
  document.getElementById('compBody').innerHTML = SKEL_ROWS;
  document.getElementById('viralBody').innerHTML = SKEL_CARDS;
  const r = await api(`/api/overview?window=${compWindow}&viralWindow=${viralWindow}`);
  ov = r;
  $('#statTotal').innerHTML = fmt(r.totalChannels) + (r.todayAdded ? ` <small>+${fmt(r.todayAdded)} today</small>` : '');
  $('#statToday').textContent = r.todayAdded ? `+${r.todayAdded} channels added today` : 'No new channels added today';
  $('#statMaps').textContent = fmt(r.mapsBuilt);
  $('#statRuns').textContent = fmt(r.trendingRuns);
  $('#statVideos').textContent = fmt(r.videosStored);
  const banner = $('#accessBanner');
  if (r.allowed) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    banner.innerHTML = `<b>Limited view.</b> ${r.accessNote} ${me && me.loggedIn ? 'Your email does not have access yet.' : 'Log in — this data is only visible to users with access.'}`;
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
    body.innerHTML = '<p class="muted">No new outlier channels in the last 24h. Run Trending 24h first — or try a different language filter.</p>';
    return;
  }
  const maxM = Math.max(...list.map(c => c.bestMultiple || 0), 1);
  body.innerHTML = list.map(c => `
    <div class="orow">
      ${dpHtml(c.thumbnail, c.title)}
      <div class="grow"><div class="t">${linkOrText(ytChannel(c.id), c.title)}</div><div class="m">${c.subs == null ? '—' : fmt(c.subs) + ' subscribers'}${c.ageDays ? ' · ' + c.ageDays + ' days old' : ''}</div></div>
      <div class="obar"><i style="width:${c.bestMultiple == null ? 0 : Math.max(4, Math.round(c.bestMultiple / maxM * 100))}%"></i></div>
      <span class="mult">${c.bestMultiple == null ? '—' : c.bestMultiple + '×'}</span>
    </div>`).join('');
}
function renderCompetition() {
  const list = ov.competition || [];
  const body = $('#compBody');
  if (!list.length) {
    body.innerHTML = `<p class="muted">No data for this period (${compWindow}) yet — no made-up numbers are shown. Build a map or run Trending and this will fill in.</p>`;
    return;
  }
  body.innerHTML = `
    <div class="comp-cols"><span>Channel</span><span>Subs</span><span>Avg views</span><span class="hide-m">Videos</span><span class="hide-m">Days</span><span>Outlier</span></div>` +
    list.map(c => `
    <div class="comp-row">
      <div class="cell chan-cell">${linkOrText(ytChannel(c.id), dpHtml(c.thumbnail, c.title), 'dp-link')}<span class="t">${linkOrText(ytChannel(c.id), c.title)}</span></div>
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
    body.innerHTML = '<p class="muted">No viral videos in this window (small channels &lt; 100K subscribers, 100,000+ views). Build a map or run Trending and videos will appear here.</p>';
    return;
  }
  body.innerHTML = `<div class="vgrid">` + viralList.map(v => {
    const watch = ytWatch(v.id);
    const chan = ytChannel(v.channelId);
    return `
    <div class="vcard">
      <div class="vthumb">${watch && v.thumbnail ? `<a href="${watch}" target="_blank" rel="noopener"><img src="/api/thumb?u=${encodeURIComponent(v.thumbnail)}" onerror="this.style.display='none'"></a>` : (v.thumbnail ? `<img src="/api/thumb?u=${encodeURIComponent(v.thumbnail)}" onerror="this.style.display='none'">` : '')}<span class="vdur">${v.duration || '—'}</span></div>
      <div class="vbody">
        <div class="t">${linkOrText(watch, v.title)}</div>
        <div class="vchan">${chan ? `<a href="${chan}" target="_blank" rel="noopener">${dpHtml(v.channelThumbnail, v.channelTitle)}</a>` : dpHtml(v.channelThumbnail, v.channelTitle)}<span>${linkOrText(chan, v.channelTitle)}</span></div>
        <div class="vmeta">${v.views == null ? '—' : fmt(v.views) + ' views'} · ${ago(v.publishedAt)}<br>VPH: <b>${v.vph == null ? '—' : fmt(v.vph) + '/hr'}</b> · ${v.subs == null ? '—' : fmt(v.subs) + ' subs'}</div>
      </div>
    </div>`;
  }).join('') + `</div>`;
}

// ---------- init ----------
(async function init() {
  await loadMe();
  await loadOverview();
})();

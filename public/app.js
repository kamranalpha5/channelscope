// ChannelScope frontend — vanilla JS, talks only to this PC's own server.
const $ = s => document.querySelector(s);
let currentMapId = null;
let currentMap = null;
let hasKey = false;
let expanding = false;

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
  return data;
}
function fmt(n) { return (+n || 0).toLocaleString(); }
// Thumbnails load through the server (same origin) — cross-origin yt3 images
// inside an SVG <image> on a localhost page fail in the browser, so the raw
// yt3 URL is never used as an <img>/<image> src any more.
function thumbUrl(url) { return url ? '/api/thumb?u=' + encodeURIComponent(url) : ''; }
const AVATAR_COLORS = ['#0ea5e9', '#f59e0b', '#22c55e', '#a855f7', '#ec4899', '#14b8a6', '#f97316'];
function avatarColor(name) { let h = 0; for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; }
function avatarDataUri(name) {
  const initial = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" fill="${avatarColor(name)}"/><text x="44" y="58" font-size="44" font-family="Arial,sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">${initial.replace(/[<>&"']/g, '')}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
const THUMB_PLACEHOLDER = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="68"><rect width="120" height="68" fill="#0b1a33"/><text x="60" y="44" font-size="26" fill="#38bdf8" text-anchor="middle">▶</text></svg>');
function imgFallback(el, name) { el.onerror = null; el.src = avatarDataUri(name); } // channel DP fallback
function thumbFallback(el) { el.onerror = null; el.src = THUMB_PLACEHOLDER; } // video thumb fallback
function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;'); }
function escInitial(s) { return (String(s || '?').trim().charAt(0) || '?').toUpperCase().replace(/[<>&]/g, ''); }
function ago(iso) {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : d < 30 ? d + ' days ago' : Math.floor(d / 30) + ' mo ago';
}
function setStatus(el, msg, kind) {
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------- status / key ----------
async function loadStatus() {
  try {
    const s = await api('/api/status');
    hasKey = s.hasKey;
    $('#quotaUsed').textContent = fmt(s.quotaUsed);
    $('#keyWarn').classList.toggle('hidden', hasKey);
    $('#removeKeyBtn').classList.toggle('hidden', !hasKey);
    $('#apiKeyInput').value = '';
    $('#apiKeyInput').placeholder = hasKey ? 'Key saved ✓ (change karne ke liye nayi key paste karo)' : 'AIzaSy... (apni key yahan paste karo)';
  } catch (e) { /* server down */ }
}
$('#saveKeyBtn').onclick = async () => {
  const key = $('#apiKeyInput').value.trim();
  if (!key) return setStatus($('#keyStatus'), 'Key paste karo pehle.', 'err');
  setStatus($('#keyStatus'), 'Key check ho rahi hai…');
  try {
    const r = await api('/api/settings/key', { method: 'POST', body: JSON.stringify({ key }) });
    setStatus($('#keyStatus'), r.message, 'ok');
    loadStatus(); loadResults();
  } catch (e) { setStatus($('#keyStatus'), e.message, 'err'); }
};
$('#removeKeyBtn').onclick = async () => {
  await api('/api/settings/key', { method: 'DELETE' });
  setStatus($('#keyStatus'), 'Key remove kar di.', 'ok');
  loadStatus();
};
$('#keyBtn').onclick = () => { $('#keySection').scrollIntoView({ behavior: 'smooth' }); $('#apiKeyInput').focus(); };
$('#keyWarnBtn').onclick = () => { $('#keySection').scrollIntoView({ behavior: 'smooth' }); $('#apiKeyInput').focus(); };

// ---------- depth slider ----------
const DEPTHS = { 1: 'Depth 1 · up to ~16 channels', 2: 'Depth 2 · up to ~70 channels', 3: 'Depth 4 · up to ~273 channels' };
$('#depthSlider').oninput = e => { $('#depthLabel').textContent = DEPTHS[e.target.value]; };
function depthValue() { return { 1: 1, 2: 2, 3: 4 }[$('#depthSlider').value]; }

// ---------- map build (progressive) ----------
$('#buildBtn').onclick = async () => {
  if (!hasKey) { $('#keySection').scrollIntoView({ behavior: 'smooth' }); return setStatus($('#buildStatus'), 'Pehle API key save karo.', 'err'); }
  const input = $('#seedInput').value.trim();
  if (!input) return setStatus($('#buildStatus'), 'Seed channel likho (jaise @EconomyPuzzle).', 'err');
  setStatus($('#buildStatus'), 'Seed dhoond rahe hain…');
  $('#progress').classList.remove('hidden');
  try {
    const r = await api('/api/maps', { method: 'POST', body: JSON.stringify({ input, depth: depthValue() }) });
    currentMapId = r.map.id;
    currentMap = r.map;
    renderMap();
    setStatus($('#buildStatus'), 'Seed mil gaya — rings bhar rahe hain…', 'ok');
    await expandLoop();
    loadResults();
  } catch (e) {
    setStatus($('#buildStatus'), e.message, 'err');
    $('#progress').classList.add('hidden');
  }
};

async function expandLoop() {
  if (expanding || !currentMapId) return;
  expanding = true;
  $('#mapBadge').classList.remove('hidden');
  $('#continueBtn').classList.add('hidden');
  try {
    while (currentMap && currentMap.status === 'building') {
      const total = currentMap.depth;
      const done = currentMap.builtDepth;
      $('#progressText').textContent = `Depth ${done} of ${total} ready — ${currentMap.channels.length} channels`;
      $('#progressBar').style.width = Math.round((done / total) * 100) + '%';
      const r = await api(`/api/maps/${currentMapId}/expand`, { method: 'POST', body: '{}' });
      currentMap = r.map;
      renderMap();
      setStatus($('#buildStatus'), r.message, 'ok');
      if (r.done) break;
    }
    $('#progressBar').style.width = '100%';
    $('#progressText').textContent = `Complete — ${currentMap.channels.length} channels`;
    $('#mapBadge').classList.add('hidden');
    $('#continueBtn').classList.add('hidden');
    renderBreakouts(); renderTopics();
  } catch (e) {
    setStatus($('#buildStatus'), 'Build ruk gaya: ' + e.message + ' — Continue building dabao.', 'err');
    $('#continueBtn').classList.remove('hidden');
    $('#mapBadge').classList.add('hidden');
  } finally { expanding = false; }
}
$('#continueBtn').onclick = () => expandLoop();

// ---------- map render (inline SVG, real DPs) ----------
function renderMap() {
  const svg = $('#mapSvg'), empty = $('#mapEmpty');
  if (!currentMap || !currentMap.channels.length) { svg.classList.add('hidden'); empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  svg.classList.remove('hidden');
  $('#nicheChips').innerHTML = (currentMap.nicheKeywords || []).map(k => `<span class="chip">${k}</span>`).join('');
  const cx = 450, cy = 300;
  const rings = { 0: 0, 1: 150, 2: 235, 3: 285, 4: 285 };
  const byDepth = {};
  for (const c of currentMap.channels) { (byDepth[c.depth || 0] = byDepth[c.depth || 0] || []).push(c); }
  let html = `<defs><clipPath id="dpClip"><circle r="22" cx="0" cy="0"/></clipPath><clipPath id="dpClipBig"><circle r="34" cx="0" cy="0"/></clipPath></defs>`;
  html += `<circle cx="${cx}" cy="${cy}" r="150" fill="none" stroke="#1e3a5f"/><circle cx="${cx}" cy="${cy}" r="235" fill="none" stroke="#1e3a5f"/><circle cx="${cx}" cy="${cy}" r="285" fill="none" stroke="#1e3a5f" stroke-dasharray="4 6"/>`;
  // edges seed -> depth1, depth1 -> depth2 (approx: connect in list order)
  const placed = {};
  for (const [d, list] of Object.entries(byDepth)) {
    const depth = +d;
    list.forEach((c, i) => {
      const angle = (i / list.length) * Math.PI * 2 - Math.PI / 2 + depth * 0.35;
      const r = rings[depth] || 0;
      const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
      placed[c.id] = { x, y, depth };
    });
  }
  for (const c of currentMap.channels) {
    if (!c.depth) continue;
    const p = placed[c.id];
    const parent = currentMap.channels.find(x => x.depth === c.depth - 1);
    if (parent && placed[parent.id]) {
      html += `<line x1="${placed[parent.id].x}" y1="${placed[parent.id].y}" x2="${p.x}" y2="${p.y}" stroke="#1e3a5f"/>`;
    }
  }
  for (const c of currentMap.channels) {
    const p = placed[c.id];
    const seed = c.depth === 0;
    const R = seed ? 34 : 22;
    const clip = seed ? 'dpClipBig' : 'dpClip';
    const name = (c.title || '').length > 18 ? c.title.slice(0, 17) + '…' : c.title;
    // Letter avatar sits UNDER the photo: if the photo fails, the initial shows
    // instead of a broken-image icon. Photo loads through the same-origin proxy.
    html += `<g class="map-node${seed ? ' seed' : ''}${c.depth >= 2 ? ' lbl-hide' : ''}" data-id="${c.id}" transform="translate(${p.x},${p.y})">` +
      `<circle class="node-ring" r="${R + 3}"/>` +
      `<circle r="${R}" fill="${avatarColor(c.title)}"/>` +
      `<text class="avatar-initial" y="${Math.round(R * 0.35)}" style="font-size:${R}px;fill:#fff;font-weight:700">${escInitial(c.title)}</text>` +
      (c.thumbnail ? `<image href="${thumbUrl(c.thumbnail)}" x="${-R}" y="${-R}" width="${R * 2}" height="${R * 2}" clip-path="url(#${clip})" onerror="this.remove()"/>` : '') +
      `<text class="node-label" y="${R + 16}">${name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></g>`;
  }
  svg.innerHTML = html;
  svg.querySelectorAll('.map-node').forEach(g => {
    g.addEventListener('mouseenter', e => showHover(e, g.dataset.id));
    g.addEventListener('mouseleave', () => $('#hoverCard').classList.add('hidden'));
    g.addEventListener('click', () => showChannelDetail(g.dataset.id));
  });
}

function showHover(e, channelId) {
  const c = currentMap.channels.find(x => x.id === channelId);
  if (!c) return;
  const card = $('#hoverCard');
  const best = c.videos.length ? Math.max(...c.videos.map(v => v.multiple || 0)) : 0;
  card.innerHTML = `<img src="${thumbUrl(c.thumbnail)}" onerror="imgFallback(this,'${escAttr(c.title)}')" alt=""><h4>${c.title}</h4>` +
    `<p>${fmt(c.subs)} subscribers</p><p>Median views: ${fmt(c.medianViews)}</p>` +
    `<p>Biggest breakout: <span class="mult">${best.toFixed(1)}×</span></p><p>${fmt(c.videoCount)} videos</p>`;
  const wrap = document.querySelector('.map-wrap').getBoundingClientRect();
  let x = e.clientX - wrap.left + 14, y = e.clientY - wrap.top + 14;
  if (x + 260 > wrap.width) x = e.clientX - wrap.left - 264;
  card.style.left = x + 'px'; card.style.top = y + 'px';
  card.classList.remove('hidden');
}

// ---------- channel detail + JSON download ----------
async function showChannelDetail(channelId) {
  const c = currentMap.channels.find(x => x.id === channelId);
  if (!c) return;
  const panel = $('#channelDetail');
  panel.classList.remove('hidden');
  panel.innerHTML = `<p>Loading detail…</p>`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const r = await api(`/api/maps/${currentMapId}/channels/${channelId}`);
    const b = r.breakdown, ch = b.channel;
    const top = b.topVideos.map(v => `<div class="bitem"><img class="thumb" src="${thumbUrl(v.thumbnail)}" onerror="thumbFallback(this)"><div class="grow"><div class="t">${v.title}</div><div class="m">${fmt(v.views)} views · ${v.multipleVsMedian}× median · ${ago(v.publishedAt)}</div></div><span class="badge-amber">${v.multipleVsMedian}×</span><button class="btn small" onclick="replicateVideo('${v.id}','${v.title.replace(/'/g, '')}')">Replicate script</button></div>`).join('');
    panel.innerHTML = `
      <div class="row"><img src="${thumbUrl(ch.thumbnail)}" onerror="imgFallback(this,'${escAttr(ch.title)}')" style="width:56px;height:56px;border-radius:50%">
      <div><h3 style="margin:0">${ch.title}</h3><p class="muted" style="margin:2px 0">${ch.customUrl || ''} · ${ch.country || ''} · since ${ch.publishedAt ? ch.publishedAt.slice(0, 10) : ''}</p></div>
      <a class="btn primary" style="margin-left:auto;text-decoration:none" href="/api/maps/${currentMapId}/channels/${channelId}/json" download>⬇ Download JSON</a></div>
      <div class="detail-grid">
        <div class="stat"><b>${fmt(ch.subs)}</b><span>Subscribers</span></div>
        <div class="stat"><b>${fmt(ch.totalViews)}</b><span>Total views</span></div>
        <div class="stat"><b>${fmt(ch.medianViews)}</b><span>Median views</span></div>
        <div class="stat"><b>${fmt(ch.viewsPerDay)}</b><span>Views / day</span></div>
        <div class="stat"><b>${fmt(ch.videoCount)}</b><span>Videos</span></div>
        <div class="stat"><b>${b.postingCadence}</b><span>Cadence</span></div>
      </div>
      <h4>Core engine (inferred from this channel's own data)</h4>
      <p class="muted">Format: ${b.core_engine.format} · Hook: ${b.core_engine.hookStyle} · Pacing: ${b.core_engine.pacing}<br>
      Retention: ${b.core_engine.retentionDevices.join(', ')}<br>${b.core_engine.packagingNotes}</p>
      <h4>Top videos</h4>${top || '<p class="muted">No videos loaded for this channel.</p>'}
      <p class="muted" style="font-size:12px">${b.note}</p>`;
  } catch (e) { panel.innerHTML = `<p class="status err">${e.message}</p>`; }
}

// ---------- breakouts ----------
async function renderBreakouts() {
  if (!currentMapId) { $('#breakoutList').innerHTML = '<p class="muted">Pehle map banao — phir yahan breakout videos dikhengi.</p>'; return; }
  const min = $('#minBreakout').value;
  try {
    const r = await api(`/api/maps/${currentMapId}/breakouts?min=${min}`);
    $('#breakoutCount').textContent = r.count + ' videos ≥ ' + min + '×';
    $('#breakoutList').innerHTML = r.breakouts.length ? r.breakouts.map(b => `
      <div class="bitem">
        <img class="thumb" src="${thumbUrl(b.thumbnail)}" onerror="thumbFallback(this)">
        <img class="dp" src="${thumbUrl(b.channelThumbnail)}" onerror="imgFallback(this,'${escAttr(b.channelTitle)}')">
        <div class="grow"><div class="t">${b.title}</div><div class="m">${b.channelTitle} · ${fmt(b.views)} views · ${ago(b.publishedAt)} · ${b.duration}</div></div>
        <span class="badge-amber">${b.multiple}×</span>
        <button class="btn small" onclick="replicateVideo('${b.videoId}','')">Replicate script</button>
      </div>`).join('') : '<p class="muted">Is threshold par koi breakout nahi — minimum kam karke dekho.</p>';
  } catch (e) { $('#breakoutList').innerHTML = `<p class="status err">${e.message}</p>`; }
}
$('#minBreakout').onchange = renderBreakouts;

// ---------- topics ----------
async function renderTopics() {
  if (!currentMapId) { $('#topicList').innerHTML = '<p class="muted">Pehle map banao — topics tumhare map ke breakout data se banenge.</p>'; return; }
  try {
    const r = await api(`/api/maps/${currentMapId}/topics`);
    $('#topicList').innerHTML = r.topics.length ? r.topics.map(t => `
      <div class="topic"><h3>${t.topic} <span class="score">${t.score}/10</span></h3>
      <p>Expected: <b>${t.expectedViewsMonthly}</b> views/month</p><p>${t.why}</p>
      <ul>${t.titles.map(x => `<li>${x}</li>`).join('')}</ul></div>`).join('')
      : '<p class="muted">Abhi topics ke liye kaafi breakout data nahi — map ko depth 2 tak bharo.</p>';
  } catch (e) { $('#topicList').innerHTML = `<p class="status err">${e.message}</p>`; }
}

// ---------- map chat ----------
$('#chatBtn').onclick = async () => {
  const q = $('#chatInput').value.trim();
  if (!q || !currentMapId) { $('#chatAnswer').classList.remove('hidden'); $('#chatAnswer').innerHTML = '<p>Pehle map banao, phir sawal poocho.</p>'; return; }
  const box = $('#chatAnswer');
  box.classList.remove('hidden');
  box.innerHTML = '<p>Searching your map…</p>';
  try {
    const r = await api(`/api/maps/${currentMapId}/chat`, { method: 'POST', body: JSON.stringify({ question: q }) });
    if (r.analysis && r.html) { box.innerHTML = r.html; return; }
    box.innerHTML = `<p>${r.answer}</p>` +
      (r.channels.map(c => `<div class="bitem"><img class="dp" src="${thumbUrl(c.thumbnail)}" onerror="imgFallback(this,'${escAttr(c.title)}')"><div class="grow"><div class="t">${c.title}</div><div class="m">${fmt(c.subs)} subs · median ${fmt(c.medianViews)} views · best breakout ${c.bestMultiple.toFixed(1)}×</div></div><button class="btn small" onclick="showChannelDetail('${c.id}')">Open</button></div>`).join('')) +
      (r.videos.map(v => `<div class="bitem"><img class="thumb" src="${thumbUrl(v.thumbnail)}" onerror="thumbFallback(this)"><div class="grow"><div class="t">${v.title}</div><div class="m">${v.channelTitle} · ${fmt(v.views)} views · ${v.multiple}×</div></div><button class="btn small" onclick="replicateVideo('${v.id}','')">Replicate script</button></div>`).join(''));
  } catch (e) { box.innerHTML = `<p class="status err">${e.message}</p>`; }
};

// Suggested first prompt: full channel analysis (Makina-style, deterministic).
$('#chatSuggestChip').onclick = () => {
  if (!currentMapId) {
    const box = $('#chatAnswer');
    box.classList.remove('hidden');
    box.innerHTML = '<p>Pehle map banao, phir analysis poocho.</p>';
    return;
  }
  $('#chatInput').value = 'Analyze my channel and suggest my next video topic — suggest videos from small and new channels with top outliers';
  $('#chatBtn').click();
};

// ---------- script replicate ----------
let currentScript = '';
async function replicateVideo(videoId, title) {
  if (!currentMapId) return;
  const modal = $('#scriptModal');
  modal.classList.remove('hidden');
  $('#scriptTitle').textContent = 'Replicated script — ' + (title || videoId);
  $('#scriptMeta').textContent = 'Original script ban raha hai (same structure, fresh wording)…';
  $('#scriptBody').textContent = 'Please wait…';
  try {
    const r = await api(`/api/maps/${currentMapId}/videos/${videoId}/replicate`, { method: 'POST', body: '{}' });
    currentScript = r.script;
    $('#scriptMeta').textContent = `Source: ${r.sourceTitle} — ${r.sourceChannel} · Target ~${r.minutes} min (~${r.words} words) · 100% fresh wording, structure only.`;
    $('#scriptBody').textContent = r.script;
  } catch (e) {
    $('#scriptBody').textContent = 'Error: ' + e.message;
  }
}
$('#scriptClose').onclick = () => $('#scriptModal').classList.add('hidden');
$('#scriptModal').onclick = e => { if (e.target.id === 'scriptModal') $('#scriptModal').classList.add('hidden'); };
$('#scriptCopy').onclick = async () => { try { await navigator.clipboard.writeText(currentScript); $('#scriptCopy').textContent = 'Copied ✓'; setTimeout(() => $('#scriptCopy').textContent = 'Copy script', 1500); } catch (e) { alert('Copy nahi hua — text select karke copy karo.'); } };
$('#scriptDownload').onclick = () => {
  const blob = new Blob([currentScript], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'channelscope-script.md';
  a.click();
};

// ---------- results ----------
async function loadResults() {
  try {
    const r = await api('/api/results');
    const v = r.results;
    $('#resultsGrid').innerHTML = `
      <div class="stat"><b>${v.maps}</b><span>Maps built</span></div>
      <div class="stat"><b>${fmt(v.channels)}</b><span>Channels mapped</span></div>
      <div class="stat"><b>${fmt(v.videos)}</b><span>Videos analysed</span></div>
      <div class="stat"><b>${fmt(v.breakouts)}</b><span>Breakouts found (≥3×)</span></div>
      <div class="stat"><b>${fmt(v.quotaUsed)}</b><span>Quota used today / ${fmt(v.quotaLimit)}</span></div>`;
  } catch (e) { /* ignore */ }
}

// ---------- resume latest map on load ----------
async function init() {
  await loadStatus();
  loadResults();
  try {
    const r = await api('/api/maps');
    if (r.maps && r.maps.length) {
      const full = await api('/api/maps/' + r.maps[0].id);
      currentMapId = full.map.id;
      currentMap = full.map;
      renderMap(); renderBreakouts(); renderTopics();
      if (currentMap.status === 'building') {
        setStatus($('#buildStatus'), 'Pichla map adhoora tha — Continue building se resume karo.', 'ok');
        $('#continueBtn').classList.remove('hidden');
        $('#progress').classList.remove('hidden');
        $('#progressText').textContent = `Depth ${currentMap.builtDepth} of ${currentMap.depth} ready — ${currentMap.channels.length} channels`;
      }
    } else {
      renderBreakouts(); renderTopics();
    }
  } catch (e) { renderBreakouts(); renderTopics(); }
}
init();

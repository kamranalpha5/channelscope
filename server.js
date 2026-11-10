// ChannelScope (standalone) — YouTube competitor-mapping tool.
// Runs on your own PC. Uses YOUR YouTube Data API v3 key (stored locally only).
// Neighbour discovery NEVER uses relatedToVideoId (YouTube removed it Aug 2023).
// Niche is derived per seed channel from that channel's own titles/tags/category.

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
// Under pkg the code runs from a read-only snapshot (__dirname = /snapshot/...).
// Writable data must live next to the exe on disk instead.
const IS_PKG = typeof process.pkg !== 'undefined';
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MAPS_FILE = path.join(DATA_DIR, 'maps.json');
const YT = 'https://www.googleapis.com/youtube/v3';
const QUOTA_LIMIT = 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- storage (plain JSON files, no native modules) ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function saveJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function getSettings() {
  return loadJson(SETTINGS_FILE, { apiKey: '', quotaUsed: 0, quotaDate: '' });
}
function saveSettings(s) { saveJson(SETTINGS_FILE, s); }
function getMaps() { return loadJson(MAPS_FILE, { maps: [] }).maps; }
function saveMaps(maps) { saveJson(MAPS_FILE, { maps }); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function quotaResetIfNeeded(s) {
  if (s.quotaDate !== todayStr()) { s.quotaUsed = 0; s.quotaDate = todayStr(); }
  return s;
}
function addQuota(s, units) {
  quotaResetIfNeeded(s);
  s.quotaUsed = (s.quotaUsed || 0) + units;
  saveSettingsSoon(s);
}
// Disk writes are debounced: parallel API storms used to do one sync write per
// call (and parallel increments could clobber each other). Flushed at the end
// of a map build / ring expand.
let settingsSaveTimer = null;
function saveSettingsSoon(s) {
  if (settingsSaveTimer) return;
  settingsSaveTimer = setTimeout(() => { settingsSaveTimer = null; try { saveSettings(s); } catch (e) { /* ignore */ } }, 400);
}
function flushSettings(s) {
  if (settingsSaveTimer) { clearTimeout(settingsSaveTimer); settingsSaveTimer = null; }
  try { saveSettings(s); } catch (e) { /* ignore */ }
}

// Run async jobs with a small concurrency pool (parallel YouTube API calls).
async function mapPool(items, fn, limit) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- YouTube API client (key via header, never in a URL) ----------
async function yt(endpoint, params, key) {
  const url = new URL(YT + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { 'X-goog-api-key': key, 'Accept': 'application/json' }
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* ignore */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('YouTube API error ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.isInvalidKey = res.status === 400 && /API key not valid/i.test(msg);
    throw err;
  }
  return data;
}
function ytCost(endpoint) { return endpoint.startsWith('/search') ? 100 : 1; }

// ---------- text helpers ----------
const STOP_EN = new Set(('a,an,the,and,or,of,to,in,on,for,with,by,at,from,as,is,are,was,were,it,its,this,that,these,those,how,why,what,when,where,which,who,whom,can,could,should,would,will,just,not,no,yes,you,your,we,our,they,their,he,she,his,her,i,me,my,do,does,did,have,has,had,be,been,being,all,any,more,most,other,some,such,only,own,same,so,than,too,very,about,into,through,after,over,between,out,up,down,off,again,further,then,once,here,there,all,also,new,top,best,video,videos,part,episode,watch,official,full,hd,4k').split(','));
const STOP_KO = new Set(('이,그,저,것,수,등,와,과,은,는,을,를,에,에서,의,가,도,으로,로,하고,이다,입니다,있는,있다,없다,하다,되다,보다,위해,때문,정도,아주,너무,정말,진짜,왜,어떻게,무엇,누가,언제,어디,오늘,내일,어제,이번,다음,처음,마지막,그리고,하지만,그래서,그러나,지금,여기,저기,우리,나,너,그녀,그들,바로,아직,벌써,벌써,많이,조금,다,모두,영상,채널,구독,좋아요,알림,설정,보기,설명,댓글,공유,재생,목록,전체,무료,최신,인기,추천,정보,방법,후기,리뷰,정리,완벽,쉽게,빠르게,바로,알아보기,알아보자,알려드립니다,알려드릴게요,해보자,해봅시다,시작,끝,결론,요약,정리해드릴게요').split(','));

function tokenize(text) {
  if (!text) return [];
  return (text.toLowerCase().match(/[a-z0-9]+|[\uac00-\ud7a3]+/g) || [])
    .filter(t => t.length >= 2 && !STOP_EN.has(t) && !STOP_KO.has(t) && !/^\d+$/.test(t));
}
function topTokens(texts, limit) {
  const freq = new Map();
  for (const t of texts) for (const tok of tokenize(t)) freq.set(tok, (freq.get(tok) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(e => e[0]);
}
function isKorean(text) {
  if (!text) return false;
  const ko = (text.match(/[\uac00-\ud7a3]/g) || []).length;
  const latin = (text.match(/[a-z]/gi) || []).length;
  return ko > latin * 0.5 && ko >= 3;
}
function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
function mean(nums) {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}
function esc(s) { return String(s == null ? '' : s); }
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function cap(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function fmt(n) { return (+n || 0).toLocaleString(); }

// ---------- channel resolution ----------
function parseChannelInput(input) {
  input = (input || '').trim();
  if (!input) return null;
  let m = input.match(/youtube\.com\/channel\/(UC[\w-]{10,})/);
  if (m) return { type: 'id', value: m[1] };
  m = input.match(/youtube\.com\/@([\w.\-]+)/);
  if (m) return { type: 'handle', value: '@' + m[1] };
  m = input.match(/youtube\.com\/(?:c|user)\/([\w.\-]+)/);
  if (m) return { type: 'name', value: m[1] };
  if (/^UC[\w-]{10,}$/.test(input)) return { type: 'id', value: input };
  if (input.startsWith('@')) return { type: 'handle', value: input };
  return { type: 'name', value: input };
}

async function resolveChannel(input, key, settings) {
  const parsed = parseChannelInput(input);
  if (!parsed) throw new Error('Channel handle, URL ya ID likho (jaise @EconomyPuzzle).');
  let channelId = null;
  if (parsed.type === 'id') {
    channelId = parsed.value;
  } else if (parsed.type === 'handle') {
    const d = await yt('/channels', { part: 'id', forHandle: parsed.value }, key);
    addQuota(settings, ytCost('/channels'));
    if (d.items && d.items.length) channelId = d.items[0].id;
  }
  if (!channelId) {
    // Fallback: search by name/handle text (100 units).
    const d = await yt('/search', { part: 'snippet', type: 'channel', q: parsed.value.replace(/^@/, ''), maxResults: 5 }, key);
    addQuota(settings, ytCost('/search'));
    const exact = (d.items || []).find(it =>
      (it.snippet.channelTitle || '').toLowerCase() === parsed.value.replace(/^@/, '').toLowerCase());
    channelId = (exact || (d.items || [])[0] || {}).channelId || (d.items && d.items[0] && d.items[0].snippet && d.items[0].snippet.channelId);
    if (!channelId) throw new Error('Channel nahi mila: ' + input);
  }
  return channelId;
}

async function fetchChannelDetails(ids, key, settings, cache) {
  // With a build cache, already-fetched channels are never fetched twice.
  const fetchIds = cache ? ids.filter(id => !cache.channels.has(id)) : ids;
  if (fetchIds.length) {
    const chunks = [];
    for (let i = 0; i < fetchIds.length; i += 50) chunks.push(fetchIds.slice(i, i + 50));
    const results = await mapPool(chunks, async (chunk) => {
      const d = await yt('/channels', {
        part: 'snippet,statistics,topicDetails,contentDetails',
        id: chunk.join(',')
      }, key);
      addQuota(settings, ytCost('/channels'));
      return d.items || [];
    }, 4);
    for (const items of results) for (const it of (items || [])) if (cache) cache.channels.set(it.id, it);
    if (!cache) return results.flat();
  }
  return ids.map(id => cache.channels.get(id)).filter(Boolean);
}

async function fetchChannelVideos(channelId, uploadsPlaylistId, key, settings, max = 20, cache) {
  const cacheKey = channelId + ':' + max;
  if (cache && cache.videos.has(cacheKey)) return cache.videos.get(cacheKey);
  let videoIds = [];
  let pageToken = '';
  try {
    while (videoIds.length < max) {
      const d = await yt('/playlistItems', {
        part: 'contentDetails', playlistId: uploadsPlaylistId,
        maxResults: Math.min(50, max - videoIds.length), pageToken
      }, key);
      addQuota(settings, ytCost('/playlistItems'));
      for (const it of (d.items || [])) videoIds.push(it.contentDetails.videoId);
      pageToken = d.nextPageToken || '';
      if (!pageToken) break;
    }
  } catch (e) { /* playlist may be empty/private — return what we have */ }
  if (!videoIds.length) { if (cache) cache.videos.set(cacheKey, []); return []; }
  const chunks = [];
  for (let i = 0; i < videoIds.length; i += 50) chunks.push(videoIds.slice(i, i + 50));
  const results = await mapPool(chunks, async (chunk) => {
    const d = await yt('/videos', {
      part: 'snippet,statistics,contentDetails',
      id: chunk.join(',')
    }, key);
    addQuota(settings, ytCost('/videos'));
    return (d.items || []).map(v => ({
      id: v.id,
      title: v.snippet.title,
      description: v.snippet.description || '',
      publishedAt: v.snippet.publishedAt,
      channelId: v.snippet.channelId,
      channelTitle: v.snippet.channelTitle,
      thumbnail: (v.snippet.thumbnails && v.snippet.thumbnails.medium && v.snippet.thumbnails.medium.url) || '',
      views: +(v.statistics.viewCount || 0),
      likes: +(v.statistics.likeCount || 0),
      comments: +(v.statistics.commentCount || 0),
      durationSec: parseDuration(v.contentDetails && v.contentDetails.duration),
      tags: v.snippet.tags || []
    }));
  }, 4);
  const videos = results.flat();
  if (cache) cache.videos.set(cacheKey, videos);
  return videos;
}

function channelSummary(item, videos) {
  const sn = item.snippet || {};
  const st = item.statistics || {};
  const views = videos.map(v => v.views);
  const med = median(views);
  const totalViews = +(st.viewCount || 0);
  const subs = +(st.subscriberCount || 0);
  const published = sn.publishedAt ? new Date(sn.publishedAt) : null;
  const ageDays = published ? Math.max(1, Math.round((Date.now() - published.getTime()) / 86400000)) : 0;
  return {
    id: item.id,
    title: sn.title || '',
    description: sn.description || '',
    customUrl: sn.customUrl || '',
    country: sn.country || '',
    publishedAt: sn.publishedAt || '',
    thumbnail: (sn.thumbnails && (sn.thumbnails.high || sn.thumbnails.medium || sn.thumbnails.default) || {}).url || '',
    subs, totalViews,
    videoCount: +(st.videoCount || 0),
    hiddenSubs: !!st.hiddenSubscriberCount,
    topicCategories: ((item.topicDetails && item.topicDetails.topicCategories) || []).map(u => u.split('/').pop().replace(/_/g, ' ')),
    uploadsPlaylist: (item.contentDetails && item.contentDetails.relatedPlaylists && item.contentDetails.relatedPlaylists.uploads) || '',
    medianViews: med,
    meanViews: mean(views),
    viewsPerDay: ageDays ? Math.round(totalViews / ageDays) : 0,
    videos: videos.map(v => ({ ...v, multiple: med ? +(v.views / med).toFixed(1) : 0 }))
  };
}

// ---------- niche derivation + niche test ----------
function deriveNiche(seedChannel, seedVideos) {
  const texts = [seedChannel.title, seedChannel.description];
  for (const v of seedVideos) { texts.push(v.title, v.description, (v.tags || []).join(' ')); }
  const keywords = topTokens(texts, 12);
  const categories = seedChannel.topicCategories || [];
  const korean = isKorean(seedVideos.map(v => v.title).join(' ') + ' ' + seedChannel.title);
  return { keywords, categories, korean, language: korean ? 'ko' : 'en' };
}

function nicheTest(candidate, candidateVideos, niche) {
  // Candidate must show the seed's niche in its OWN videos/tags/category.
  const texts = [candidate.title, candidate.description];
  for (const v of candidateVideos) { texts.push(v.title, (v.tags || []).join(' ')); }
  const toks = new Set(tokenize(texts.join(' ')));
  const hits = niche.keywords.filter(k => toks.has(k.toLowerCase()));
  const catHit = (candidate.topicCategories || []).some(c =>
    niche.categories.some(nc => c.toLowerCase().includes(nc.toLowerCase().split(' ')[0]) || nc.toLowerCase().includes(c.toLowerCase().split(' ')[0])));
  const candKorean = isKorean(candidateVideos.map(v => v.title).join(' '));
  const langOk = niche.korean ? (candKorean || hits.length >= 3) : true;
  const pass = langOk && (hits.length >= 2 || (hits.length >= 1 && catHit));
  return { pass, hits, catHit, langOk };
}

async function discoverNeighbours(niche, excludeIds, limit, key, settings) {
  const found = [];
  const seen = new Set(excludeIds);
  // Build-scoped cache: a channel/video is never fetched twice in one build.
  const cache = { channels: new Map(), videos: new Map() };
  // Search each top niche keyword for channels + videos (keyword-anchored, never relatedToVideoId).
  // The 12 searches used to run one-by-one; they now run in a pool of 6.
  const queries = niche.keywords.slice(0, 6);
  const searchJobs = [];
  for (const q of queries) { searchJobs.push({ q, type: 'channel' }); searchJobs.push({ q, type: 'video' }); }
  const searchResults = await mapPool(searchJobs, async (job) => {
    try {
      const d = await yt('/search', { part: 'snippet', type: job.type, q: job.q, maxResults: 10 }, key);
      addQuota(settings, ytCost('/search'));
      return (d.items || []).map(it => it.snippet.channelId).filter(Boolean);
    } catch (e) { return []; } // one failed keyword must not kill the build
  }, 6);
  const candidateIds = [];
  for (const ids of searchResults) {
    for (const id of ids) { if (!seen.has(id)) { seen.add(id); candidateIds.push(id); } }
    if (candidateIds.length >= limit * 2) break;
  }
  // Vet every candidate against the niche before it enters the map.
  // Chunks run in parallel (pool 3); inside a chunk, per-channel video fetches
  // run in parallel (pool 6) — that sequential loop was the biggest bottleneck:
  // up to 2 API calls per channel, one channel after another.
  const chunks = [];
  for (let i = 0; i < candidateIds.length; i += 10) chunks.push(candidateIds.slice(i, i + 10));
  const chunkResults = await mapPool(chunks, async (chunk) => {
    let details = [];
    try { details = await fetchChannelDetails(chunk, key, settings, cache); } catch (e) { return []; }
    const vetted = await mapPool(details, async (item) => {
      const ch = channelSummary(item, []);
      let vids = [];
      try { if (ch.uploadsPlaylist) vids = await fetchChannelVideos(item.id, ch.uploadsPlaylist, key, settings, 10, cache); } catch (e) { /* ignore */ }
      const test = nicheTest(ch, vids, niche);
      if (!test.pass) return null;
      const full = channelSummary(item, vids);
      full.nicheHits = test.hits;
      return full;
    }, 6);
    return vetted.filter(Boolean);
  }, 3);
  for (const list of chunkResults) {
    for (const ch of list) { if (found.length < limit) found.push(ch); }
    if (found.length >= limit) break;
  }
  return found;
}

// ---------- helpers for routes ----------
function needKey(res) {
  const s = quotaResetIfNeeded(getSettings());
  if (!s.apiKey) {
    res.status(400).json({ ok: false, error: 'API key saved nahi hai. Pehle Settings mein apni YouTube Data API v3 key daalo.' });
    return null;
  }
  return s;
}
function findMap(id) {
  const maps = getMaps();
  const map = maps.find(m => m.id === id);
  return { maps, map };
}
function ringCap(depth) { return depth >= 4 ? 273 : depth >= 2 ? 70 : 16; }
function nextRingTarget(map) {
  if (map.builtDepth === 0) return 16;
  if (map.depth >= 2 && map.builtDepth === 1) return 70;
  if (map.depth >= 4 && map.builtDepth === 2) return 273;
  return null;
}

// ---------- thumbnail proxy (same-origin DPs) ----------
// ROOT CAUSE of the broken map icons: the server stores a valid YouTube
// thumbnail URL per channel (snippet.thumbnails.high, field `thumbnail` — the
// frontend reads the same field, so the mapping matches), and that URL returns
// HTTP 200 when fetched directly (verified with curl). The failure happens in
// the browser: cross-origin yt3 images inside an SVG <image> on a localhost
// page do not load reliably there. Serving the bytes from this server (same
// origin) removes every client-side variable. Only YouTube image CDNs allowed.
const THUMB_HOSTS = new Set(['yt3.ggpht.com', 'yt3.googleusercontent.com', 'i.ytimg.com']);
const thumbCache = new Map(); // url -> { buf, type, at }
app.get('/api/thumb', async (req, res) => {
  const u = req.query.u || '';
  let parsed;
  try { parsed = new URL(u); } catch (e) { return res.status(400).send('bad url'); }
  if (parsed.protocol !== 'https:' || !THUMB_HOSTS.has(parsed.hostname)) return res.status(400).send('host not allowed');
  const hit = thumbCache.get(u);
  if (hit && Date.now() - hit.at < 3600000) {
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(hit.buf);
  }
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(502).send('thumbnail fetch failed');
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (thumbCache.size > 300) thumbCache.clear();
    thumbCache.set(u, { buf, type, at: Date.now() });
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (e) { res.status(502).send('thumbnail fetch failed'); }
});

// ---------- settings / API key ----------
app.get('/api/status', (req, res) => {
  const s = quotaResetIfNeeded(getSettings());
  res.json({ ok: true, hasKey: !!s.apiKey, quotaUsed: s.quotaUsed || 0, quotaLimit: QUOTA_LIMIT, quotaDate: s.quotaDate });
});

app.post('/api/settings/key', async (req, res) => {
  const key = (req.body && req.body.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'Key khaali hai.' });
  // Validate with one cheap 1-unit call.
  try {
    await yt('/channels', { part: 'id', id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' }, key);
  } catch (e) {
    if (e.isInvalidKey) return res.status(400).json({ ok: false, error: 'API key not valid — Google ne key reject kar di. Key dobara check karo.' });
    return res.status(400).json({ ok: false, error: 'Key check nahi ho saki: ' + e.message });
  }
  const s = quotaResetIfNeeded(getSettings());
  s.apiKey = key;
  saveSettings(s);
  res.json({ ok: true, message: 'API key save ho gayi (sirf is PC par).' });
});

app.delete('/api/settings/key', (req, res) => {
  const s = getSettings();
  s.apiKey = '';
  saveSettings(s);
  res.json({ ok: true });
});

// ---------- maps ----------
app.get('/api/maps', (req, res) => {
  const maps = getMaps().map(m => ({
    id: m.id, seedTitle: m.seedTitle, seedChannelId: m.seedChannelId,
    seedThumbnail: m.seedThumbnail, depth: m.depth, builtDepth: m.builtDepth,
    status: m.status, channelCount: m.channels.length, quotaUsed: m.quotaUsed || 0,
    nicheKeywords: m.nicheKeywords || [], createdAt: m.createdAt
  }));
  res.json({ ok: true, maps });
});

app.get('/api/maps/:id', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  res.json({ ok: true, map });
});

app.delete('/api/maps/:id', (req, res) => {
  const { maps, map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  saveMaps(maps.filter(m => m.id !== map.id));
  res.json({ ok: true });
});

// Create map: resolve seed, derive niche, return seed IMMEDIATELY (fast first result).
app.post('/api/maps', async (req, res) => {
  const settings = needKey(res);
  if (!settings) return;
  const input = (req.body && req.body.input || '').trim();
  const depth = [1, 2, 4].includes(+req.body.depth) ? +req.body.depth : 2;
  if (!input) return res.status(400).json({ ok: false, error: 'Channel handle, URL ya ID likho.' });
  try {
    const channelId = await resolveChannel(input, settings.apiKey, settings);
    const details = await fetchChannelDetails([channelId], settings.apiKey, settings);
    if (!details.length) return res.status(404).json({ ok: false, error: 'Channel nahi mila.' });
    const item = details[0];
    const seedVideos = await fetchChannelVideos(channelId, (item.contentDetails.relatedPlaylists || {}).uploads, settings.apiKey, settings, 20);
    const seed = channelSummary(item, seedVideos);
    const niche = deriveNiche(seed, seedVideos);
    const map = {
      id: 'map_' + Date.now().toString(36),
      seedChannelId: channelId,
      seedTitle: seed.title,
      seedThumbnail: seed.thumbnail,
      depth, niche,
      nicheKeywords: niche.keywords,
      status: 'building',
      builtDepth: 0,
      quotaUsed: 0,
      createdAt: new Date().toISOString(),
      channels: [Object.assign(seed, { depth: 0 })]
    };
    const maps = getMaps();
    maps.unshift(map);
    saveMaps(maps);
    flushSettings(settings);
    res.json({ ok: true, map, message: 'Seed mil gaya — ab rings bhar rahe hain.' });
  } catch (e) {
    res.status(e.status === 403 ? 403 : 400).json({ ok: false, error: e.message || 'Map banate hue error aaya.' });
  }
});

// Expand ONE ring per request (progressive build — no single long request).
app.post('/api/maps/:id/expand', async (req, res) => {
  const settings = needKey(res);
  if (!settings) return;
  const { maps, map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  const target = nextRingTarget(map);
  if (target === null) {
    map.status = 'complete';
    saveMaps(maps);
    return res.json({ ok: true, map, done: true, message: 'Map complete hai.' });
  }
  try {
    const exclude = map.channels.map(c => c.id);
    const limit = target - map.channels.length;
    const ringDepth = map.builtDepth + 1;
    const neighbours = await discoverNeighbours(map.niche, exclude, Math.max(limit, 0), settings.apiKey, settings);
    for (const n of neighbours) { n.depth = ringDepth; map.channels.push(n); }
    map.builtDepth = ringDepth;
    map.status = nextRingTarget(map) === null ? 'complete' : 'building';
    map.quotaUsed = (map.quotaUsed || 0);
    saveMaps(maps);
    flushSettings(settings);
    res.json({
      ok: true, map, done: map.status === 'complete',
      message: `Depth ${ringDepth} of ${map.depth} ready — ${map.channels.length} channels.`
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Ring bharte hue error aaya.' });
  }
});

// ---------- channel detail + JSON download ----------
function coreEngine(ch) {
  const titles = ch.videos.map(v => v.title);
  const q = titles.filter(t => /\?/.test(t)).length;
  const num = titles.filter(t => /^\s*\d+/.test(t) || /\b\d+\s*(reasons|ways|things|mistakes|tips|secrets)\b/i.test(t)).length;
  const howWhy = titles.filter(t => /^(how|why|what)\b/i.test(t)).length;
  const vs = titles.filter(t => /\bvs\b\.?/i.test(t)).length;
  const avgDur = ch.videos.length ? Math.round(ch.videos.reduce((a, v) => a + (v.durationSec || 0), 0) / ch.videos.length) : 0;
  const dates = ch.videos.map(v => new Date(v.publishedAt).getTime()).sort((a, b) => a - b);
  let cadence = 'unknown (estimate)';
  if (dates.length >= 3) {
    const gaps = [];
    for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / 86400000);
    const avgGap = mean(gaps);
    cadence = avgGap <= 1.5 ? 'daily (estimate)' : avgGap <= 4 ? 'every 2–4 days (estimate)' : avgGap <= 8 ? 'weekly (estimate)' : `every ~${Math.round(avgGap)} days (estimate)`;
  }
  const hookStyle = q >= titles.length * 0.3 ? 'question-led hooks (estimate)'
    : num >= titles.length * 0.3 ? 'number-led / list hooks (estimate)'
    : howWhy >= titles.length * 0.3 ? 'explainer hooks — How/Why (estimate)'
    : 'statement-led hooks (estimate)';
  const retention = [];
  if (num) retention.push('listicles / numbered promises');
  if (vs) retention.push('versus / comparison framing');
  if (q) retention.push('open questions as curiosity gaps');
  if (!retention.length) retention.push('topic authority / direct explainers');
  return {
    format: avgDur ? `talking-head / explainer, avg video ${fmtDuration(avgDur)} (estimate)` : 'format unknown (estimate)',
    hookStyle,
    pacing: avgDur ? (avgDur < 300 ? 'fast, short-form pacing (estimate)' : avgDur < 900 ? 'medium pacing (estimate)' : 'slow, long-form pacing (estimate)') : 'unknown (estimate)',
    postingCadence: cadence,
    retentionDevices: retention,
    packagingNotes: 'Thumbnail design is NOT analysed by this tool — check the channel page directly. Titles lean on: ' +
      (titles.length ? topTokens(titles, 5).join(', ') : 'n/a') + ' (from titles).'
  };
}

function channelBreakdown(ch) {
  const vids = [...ch.videos].sort((a, b) => b.views - a.views);
  const med = ch.medianViews || 1;
  return {
    channel: {
      id: ch.id, title: ch.title, customUrl: ch.customUrl || '', country: ch.country || '',
      publishedAt: ch.publishedAt, subs: ch.subs, totalViews: ch.totalViews,
      videoCount: ch.videoCount, medianViews: ch.medianViews, meanViews: ch.meanViews,
      viewsPerDay: ch.viewsPerDay, thumbnail: ch.thumbnail,
      topicCategories: ch.topicCategories || []
    },
    postingCadence: coreEngine(ch).postingCadence,
    topVideos: vids.slice(0, 10).map(v => ({
      id: v.id, title: v.title, views: v.views,
      multipleVsMedian: +(v.views / med).toFixed(1),
      publishedAt: v.publishedAt, duration: fmtDuration(v.durationSec || 0)
    })),
    breakoutVideos: vids.filter(v => v.views >= med * 3).slice(0, 10).map(v => ({
      id: v.id, title: v.title, views: v.views,
      multipleVsMedian: +(v.views / med).toFixed(1), publishedAt: v.publishedAt
    })),
    titlePatterns: {
      questionTitles: ch.videos.filter(v => /\?/.test(v.title)).length,
      numberLedTitles: ch.videos.filter(v => /^\s*\d+/.test(v.title)).length,
      howWhyTitles: ch.videos.filter(v => /^(how|why|what)\b/i.test(v.title)).length,
      topWords: topTokens(ch.videos.map(v => v.title), 10)
    },
    topicClusters: topTokens(ch.videos.map(v => v.title + ' ' + (v.tags || []).join(' ')), 10),
    core_engine: coreEngine(ch),
    note: 'core_engine fields marked (estimate) are inferred from this channel\'s own public data only — not measured inside the videos.'
  };
}

app.get('/api/maps/:id/channels/:channelId', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  const ch = map.channels.find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ ok: false, error: 'Channel is map mein nahi hai.' });
  res.json({ ok: true, breakdown: channelBreakdown(ch) });
});

app.get('/api/maps/:id/channels/:channelId/json', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  const ch = map.channels.find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ ok: false, error: 'Channel is map mein nahi hai.' });
  const data = Object.assign({ exportedAt: new Date().toISOString(), mapSeed: map.seedTitle, nicheKeywords: map.nicheKeywords }, channelBreakdown(ch));
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="channelscope-${ch.title.replace(/[^\w\-]+/g, '_')}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// ---------- breakouts ----------
app.get('/api/maps/:id/breakouts', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  const min = parseFloat(req.query.min || '3') || 3;
  const rows = [];
  for (const ch of map.channels) {
    const med = ch.medianViews || 0;
    if (!med) continue;
    for (const v of ch.videos) {
      const mult = v.views / med;
      if (mult >= min) rows.push({
        videoId: v.id, title: v.title, views: v.views, multiple: +mult.toFixed(1),
        publishedAt: v.publishedAt, duration: fmtDuration(v.durationSec || 0),
        thumbnail: v.thumbnail, channelId: ch.id, channelTitle: ch.title,
        channelThumbnail: ch.thumbnail, channelSubs: ch.subs
      });
    }
  }
  rows.sort((a, b) => b.multiple - a.multiple);
  res.json({ ok: true, min, count: rows.length, breakouts: rows });
});

// ---------- topics (data-driven, no LLM key) ----------
app.get('/api/maps/:id/topics', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  const allVideos = map.channels.flatMap(c => c.videos.map(v => ({ ...v, channelMedian: c.medianViews, channelTitle: c.title })));
  const breakout = allVideos.filter(v => v.channelMedian && v.views >= v.channelMedian * 3);
  const clusters = new Map();
  for (const v of breakout) {
    for (const tok of topTokens([v.title], 3)) {
      if (!clusters.has(tok)) clusters.set(tok, []);
      clusters.get(tok).push(v);
    }
  }
  const topics = [...clusters.entries()]
    .filter(([, vs]) => vs.length >= 1)
    .map(([kw, vs]) => {
      const mults = vs.map(v => v.views / (v.channelMedian || 1));
      const best = Math.max(...mults);
      const avgMult = mean(mults.map(m => Math.round(m)));
      const medViews = median(vs.map(v => v.views));
      const low = Math.max(100, Math.round(medViews * 0.3));
      const high = Math.round(medViews * 2);
      const score = Math.min(10, Math.max(3, Math.round(3 + Math.min(5, best / 20) + Math.min(2, vs.length / 2))));
      const kwTitle = kw.charAt(0).toUpperCase() + kw.slice(1);
      return {
        topic: kwTitle,
        keyword: kw,
        score,
        expectedViewsMonthly: `${low.toLocaleString()} – ${high.toLocaleString()}`,
        why: `${vs.length} breakout video(s) in your map use this angle; best performed ${best.toFixed(0)}× its channel median. Pattern: ${topTokens(vs.map(v => v.title), 4).join(', ')}.`,
        proofCount: vs.length,
        bestMultiple: +best.toFixed(1),
        titles: [
          `Why ${kwTitle} Is Changing Everything`,
          `The Hidden Truth About ${kwTitle}`,
          `${kwTitle}: What Nobody Tells You`,
          `How ${kwTitle} Actually Works — Explained Simply`,
          `${kwTitle} in ${Math.max(5, Math.min(15, Math.round((vs[0].durationSec || 600) / 60)))} Minutes`
        ]
      };
    })
    .sort((a, b) => b.score - a.score || b.bestMultiple - a.bestMultiple)
    .slice(0, 6);
  res.json({ ok: true, nicheKeywords: map.nicheKeywords, topics, note: 'Topics are generated from YOUR map\'s own breakout data — no AI key needed.' });
});

// ---------- analysis chat (deterministic, from stored map data — no LLM key) ----------
// Intent: user asks for channel analysis / next video topic / small-channel outliers,
// in English or Roman Urdu. Returns structured HTML, all numbers from the stored map.
function isAnalysisIntent(q) {
  const s = ' ' + String(q || '').toLowerCase() + ' ';
  const en = ['analy', 'next video', 'suggest', 'outlier', 'small channel', 'new channel',
    'small and new', 'what to make', 'grow my channel', 'topic idea', 'next topic'];
  const ur = ['agle video', 'agli video', 'kya bana', 'chhota channel', 'chhote channel',
    'chhoti channel', 'naya channel', 'naye channel', 'topic bata', 'mujhe topic', 'mera channel'];
  if (en.some(k => s.includes(k)) || ur.some(k => s.includes(k))) return true;
  if (s.includes(' topic') && (s.includes(' next') || s.includes(' small') || s.includes(' best'))) return true;
  return false;
}

function channelAgeDays(ch) {
  const dates = (ch.videos || []).map(v => new Date(v.publishedAt).getTime()).filter(t => !isNaN(t));
  const first = dates.length ? Math.min(...dates)
    : (ch.publishedAt ? new Date(ch.publishedAt).getTime() : Date.now());
  return Math.max(1, Math.round((Date.now() - first) / 86400000));
}
function ageLabel(days) {
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`;
  if (days < 60) { const w = Math.max(1, Math.round(days / 7)); return `${w} week${w === 1 ? '' : 's'} old`; }
  if (days < 365) { const m = Math.round(days / 30); return `${m} month${m === 1 ? '' : 's'} old`; }
  const y = Math.round(days / 365 * 10) / 10;
  return `${y} year${y === 1 ? '' : 's'} old`;
}
function multOf(v, med) { return med ? +(v.views / med).toFixed(1) : 0; }
function bestMultiple(ch) {
  const med = ch.medianViews || 0;
  if (!med || !(ch.videos || []).length) return 0;
  return Math.max(0, ...ch.videos.map(v => v.views / med));
}

function seedPattern(seed) {
  const vids = [...(seed.videos || [])].sort((a, b) => b.views - a.views);
  if (vids.length < 2) return 'Not enough videos yet to see a pattern.';
  const top = vids.slice(0, Math.min(2, vids.length));
  const bottom = vids.slice(-Math.min(2, vids.length));
  const specific = t => /\?/.test(t) || /\d/.test(t);
  const topSpecific = top.filter(v => specific(v.title)).length;
  const botSpecific = bottom.filter(v => specific(v.title)).length;
  const topNames = top.map(v => '"' + v.title + '"').join(', ');
  const botNames = bottom.map(v => '"' + v.title + '"').join(', ');
  if (topSpecific > botSpecific) {
    return `Your strongest videos are specific stories or questions (${topNames}), while the broadest ones stalled (${botNames}).`;
  }
  if (topSpecific > 0) {
    return `Your best videos (${topNames}) and your weakest (${botNames}) both use specific angles — the difference is the subject, not the format.`;
  }
  return `Your best videos so far are ${topNames}. The weakest are ${botNames} — specific stories are beating general explainers so far.`;
}

// Data-based model judgement only: re-upload/archive signals + niche test, from stored data.
function modelVerdict(c, map) {
  const vids = c.videos || [];
  const flags = [];
  const latest = vids.length ? Math.max(...vids.map(v => new Date(v.publishedAt).getTime())) : 0;
  const daysSinceLatest = latest ? Math.round((Date.now() - latest) / 86400000) : 9999;
  if (daysSinceLatest > 180 && vids.length >= 5) {
    flags.push(`no uploads in ${daysSinceLatest} days (${vids.length} videos stored) — looks like an archive / re-upload channel (data-based)`);
  }
  const test = nicheTest(c, vids, map.niche);
  if (!test.pass) flags.push('off-niche (data-based: its videos do not match your niche keywords)');
  const best = bestMultiple(c);
  if (!flags.length) {
    if (channelAgeDays(c) <= 730 && best >= 10) {
      return { good: true, note: `Good model — ${ageLabel(channelAgeDays(c))}, best breakout ${best.toFixed(1)}×.` };
    }
    return { good: true, note: `Possible model — ${ageLabel(channelAgeDays(c))}.` };
  }
  return { good: false, note: 'Poor model — ' + flags.join('; ') + '.' };
}

function nextTopicIdeas(map, seed) {
  const seedTop = [...(seed.videos || [])].sort((a, b) => b.views - a.views)[0];
  const seedTopToks = seedTop ? new Set(tokenize(seedTop.title)) : new Set();
  const breakout = [];
  for (const c of map.channels) {
    if (c.id === seed.id) continue;
    const med = c.medianViews || 0;
    if (!med) continue;
    for (const v of c.videos) {
      const m = v.views / med;
      if (m >= 3) breakout.push({ ...v, multiple: +m.toFixed(1), channelTitle: c.title });
    }
  }
  const clusters = new Map();
  for (const v of breakout) {
    for (const tok of topTokens([v.title], 3)) {
      if (!clusters.has(tok)) clusters.set(tok, []);
      clusters.get(tok).push(v);
    }
  }
  const TEMPLATES = [
    kw => `Why ${cap(kw)} matters right now — and what happens next`,
    kw => `${cap(kw)} explained through one real person's story`,
    kw => `The ${kw} question everyone is asking, answered simply`,
    kw => `What ${cap(kw)} means for your viewers — the clear follow-up`
  ];
  return [...clusters.entries()]
    .map(([kw, vs]) => {
      vs.sort((a, b) => b.multiple - a.multiple);
      return { kw, proof: vs[0], best: vs[0].multiple };
    })
    .sort((a, b) => b.best - a.best)
    .reduce((picked, it) => {
      // Each idea must cite a DIFFERENT proof video (avoid 4 ideas from one viral video).
      if (picked.length >= 4) return picked;
      if (picked.some(p => p.proof.id === it.proof.id)) return picked;
      picked.push(it);
      return picked;
    }, [])
    .map((it, i) => ({
      title: TEMPLATES[i % TEMPLATES.length](it.kw),
      proof: it.proof,
      tieIn: (seedTop && seedTopToks.has(it.kw.toLowerCase()))
        ? `Builds on your own video "${seedTop.title}" (${fmt(seedTop.views)} views).`
        : ''
    }));
}

function buildAnalysis(map) {
  const seed = map.channels.find(c => c.depth === 0) || map.channels[0];
  if (!seed) return null;
  const vids = [...(seed.videos || [])].sort((a, b) => b.views - a.views);
  let h = `<div class="analysis">`;

  // 1. Seed channel analysis
  h += `<h3>Your channel so far</h3>`;
  h += `<p><b>${escHtml(seed.title)}</b> is ${ageLabel(channelAgeDays(seed))} with ${fmt(seed.videoCount || vids.length)} videos (${vids.length} loaded here), ${fmt(seed.subs)} subscribers.</p>`;
  if (vids.length) {
    h += `<table class="an-table"><tr><th>Video</th><th>Duration</th><th>Views</th></tr>`;
    for (const v of vids) {
      h += `<tr><td>${escHtml(v.title)}</td><td>${fmtDuration(v.durationSec || 0)}</td><td><b>${fmt(v.views)}</b></td></tr>`;
    }
    h += `</table>`;
    h += `<p>Strongest so far: <b>${escHtml(vids[0].title)}</b> — ${fmt(vids[0].views)} views.</p>`;
    h += `<p><b>Pattern:</b> ${escHtml(seedPattern(seed))}</p>`;
  } else {
    h += `<p>No videos loaded for your channel yet.</p>`;
  }

  // 2. Small + new channels with top outliers
  const small = map.channels.filter(c => c.id !== seed.id && (c.subs || 0) < 100000);
  small.sort((a, b) => channelAgeDays(a) - channelAgeDays(b) || bestMultiple(b) - bestMultiple(a));
  h += `<h3>Small &amp; new channels with top outliers</h3>`;
  if (!small.length) {
    h += `<p>No channels under 100K subscribers on your map yet — build the map to depth 2 to find them.</p>`;
  } else {
    for (const c of small.slice(0, 4)) {
      const med = c.medianViews || 1;
      const top = [...(c.videos || [])]
        .map(v => ({ ...v, multiple: multOf(v, med) }))
        .sort((a, b) => b.multiple - a.multiple).slice(0, 4);
      const verdict = modelVerdict(c, map);
      h += `<div class="an-channel"><b>${escHtml(c.title)}</b> — ${fmt(c.subs)} subs · ${ageLabel(channelAgeDays(c))} · ${verdict.good ? '✅ Good model' : '⚠️ Poor model'}<br><span class="muted">${escHtml(verdict.note)}</span>`;
      if (top.length) {
        h += `<ul>` + top.map(v => `<li><b>${fmt(v.views)}</b> (${v.multiple.toFixed(1)}×) — ${escHtml(v.title)}</li>`).join('') + `</ul>`;
      } else {
        h += `<p class="muted">No videos loaded for this channel.</p>`;
      }
      h += `</div>`;
    }
    if (small.length > 4) h += `<p class="muted">${small.length - 4} more small channel(s) on the map.</p>`;
  }

  // 3. What to make next
  h += `<h3>What to make next</h3>`;
  const ideas = nextTopicIdeas(map, seed);
  if (!ideas.length) {
    h += `<p>Not enough breakout data on your map yet to prove a topic — build the map to depth 2, then ask again.</p>`;
  } else {
    h += `<ol>` + ideas.map(it =>
      `<li><b>${escHtml(it.title)}</b><br><span class="muted">Proof: ${escHtml(it.proof.channelTitle)} — ${fmt(it.proof.views)} views, ${it.proof.multiple.toFixed(1)}× its channel median.${it.tieIn ? ' ' + escHtml(it.tieIn) : ''}</span></li>`
    ).join('') + `</ol>`;
  }
  h += `<p class="muted" style="font-size:12px">Computed only from your own map data (YouTube Data API v3). Topic titles are original phrasings built from breakout subjects — no competitor title is copied. For full topic cards with scores, use Topics.</p>`;
  h += `</div>`;
  return h;
}

// ---------- map chat (keyword matching over own map data) ----------
app.post('/api/maps/:id/chat', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  const q = (req.body && req.body.question || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'Sawal likho.' });
  // Makina-style analysis: structured report from stored map data (no LLM).
  if (isAnalysisIntent(q)) {
    const html = buildAnalysis(map);
    if (!html) return res.status(400).json({ ok: false, error: 'Map mein channel data nahi hai.' });
    return res.json({ ok: true, analysis: true, html, note: 'Analysis computed from your own map data — no AI key used.' });
  }
  const qtoks = tokenize(q);
  const scoreText = (text) => {
    const toks = new Set(tokenize(text));
    return qtoks.filter(t => toks.has(t)).length;
  };
  const chanHits = map.channels.map(c => ({
    type: 'channel', id: c.id, title: c.title, subs: c.subs,
    medianViews: c.medianViews, thumbnail: c.thumbnail,
    score: scoreText(c.title + ' ' + c.description + ' ' + c.videos.map(v => v.title).join(' ')),
    bestMultiple: c.videos.length ? Math.max(...c.videos.map(v => v.multiple || 0)) : 0
  })).filter(h => h.score > 0).sort((a, b) => b.score - a.score || b.bestMultiple - a.bestMultiple).slice(0, 5);
  const vidHits = [];
  for (const c of map.channels) for (const v of c.videos) {
    const s = scoreText(v.title + ' ' + v.description);
    if (s > 0) vidHits.push({
      type: 'video', id: v.id, title: v.title, views: v.views, multiple: v.multiple || 0,
      channelTitle: c.title, channelId: c.id, thumbnail: v.thumbnail, score: s
    });
  }
  vidHits.sort((a, b) => b.score - a.score || b.multiple - a.multiple);
  const answer = chanHits.length || vidHits.length
    ? `Tumhare map ke data se (${map.channels.length} channels): "${q}" se mutabiq ${chanHits.length} channel(s) aur ${vidHits.length} video(s) mili hain — neeche breakout multiple ke hisaab se ranked hain.`
    : `Tumhare map mein "${q}" se mutabiq kuch nahi mila. Map mein ${map.channels.length} channels hain — koi aur lafz try karo ya pehle map ko depth 2 tak bharo.`;
  res.json({ ok: true, answer, channels: chanHits, videos: vidHits.slice(0, 8), note: 'Answers come only from your own map data.' });
});

// ---------- script replicate (ORIGINAL script, same structure — never a copy) ----------
async function fetchTranscript(videoId) {
  // Public timedtext endpoint (no key). Used ONLY as analysis material for beats.
  for (const lang of ['en', 'en-US', 'ko']) {
    try {
      const r = await fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const d = await r.json();
      const lines = ((d.events || []).map(e => (e.segs || []).map(s => s.utf8 || '').join('')).join(' ')).trim();
      if (lines.length > 50) return { lang, text: lines.slice(0, 12000) };
    } catch (e) { /* transcript not available — continue without it */ }
  }
  return null;
}

app.post('/api/maps/:id/videos/:videoId/replicate', async (req, res) => {
  const settings = needKey(res);
  if (!settings) return;
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map nahi mila.' });
  let video = null, owner = null;
  for (const c of map.channels) {
    const v = c.videos.find(v => v.id === req.params.videoId);
    if (v) { video = v; owner = c; break; }
  }
  if (!video) return res.status(404).json({ ok: false, error: 'Video is map mein nahi hai.' });
  try {
    // Fresh metadata from YouTube (description chapters + duration).
    let meta = null;
    try {
      const d = await yt('/videos', { part: 'snippet,contentDetails,statistics', id: video.id }, settings.apiKey);
      addQuota(settings, ytCost('/videos'));
      meta = (d.items || [])[0] || null;
    } catch (e) { /* use stored data */ }
    const desc = (meta && meta.snippet.description) || video.description || '';
    const durationSec = (meta && meta.contentDetails) ? parseDuration(meta.contentDetails.duration) : (video.durationSec || 600);
    const chapters = [];
    for (const line of desc.split('\n')) {
      const m = line.match(/^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s+[-–—.]?\s*(.+?)\s*$/);
      if (m) {
        const sec = (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]);
        if (m[4].length > 2 && m[4].length < 80) chapters.push({ at: sec, label: m[4] });
      }
    }
    const transcript = await fetchTranscript(video.id);
    const beatTopics = topTokens([
      video.title, desc,
      transcript ? transcript.text : '',
      ...(chapters.map(c => c.label))
    ], 8);
    const minutes = Math.max(1, Math.round(durationSec / 60));
    const words = Math.round((durationSec / 60) * 150); // ~150 wpm narration pace
    const beats = chapters.length >= 3
      ? chapters.slice(0, 6).map(c => c.label)
      : beatTopics.slice(0, 5).map(t => t.charAt(0).toUpperCase() + t.slice(1));
    const kw = beatTopics[0] || map.nicheKeywords[0] || 'this topic';
    const hook = `What if everything you believed about ${kw} was only half the story?`;
    const lines = [];
    lines.push(`# Replicated Script — ORIGINAL (structure only)`);
    lines.push(``);
    lines.push(`**Source video (for structure only):** ${video.title} — ${owner.title}`);
    lines.push(`**Target length:** ~${minutes} min (~${words} words at natural narration pace)`);
    lines.push(`**Niche:** ${map.nicheKeywords.join(', ') || '—'}`);
    lines.push(`**Rule applied:** wording and names are 100% fresh — no line, title or dialogue is copied from the source video.`);
    lines.push(``);
    lines.push(`## HOOK (0:00 – 0:30)`);
    lines.push(`${hook} In the next ${minutes} minutes, you will see the full picture — step by step, with proof at every turn.`);
    lines.push(``);
    lines.push(`## SETUP (0:30 – 1:30)`);
    lines.push(`Most people stop at the surface of ${kw}. But the real story starts one layer deeper — and it affects ${map.nicheKeywords.slice(0, 3).join(', ') || 'everyone in this niche'}.`);
    lines.push(``);
    beats.forEach((b, i) => {
      lines.push(`## BEAT ${i + 1} — ${b}`);
      lines.push(`Here is where the story turns. Take the idea of ${b.toLowerCase()} and show it with one clear example the viewer can check themselves — a number, a date, or a before-and-after. End the beat on a small open question so the viewer stays for the next one.`);
      lines.push(``);
    });
    lines.push(`## PAYOFF (last 60 seconds)`);
    lines.push(`So the full picture is this: ${kw} is not what it first looks like — and now you can spot it yourself. If this helped, the next video in this series goes one step further.`);
    lines.push(``);
    lines.push(`---`);
    lines.push(`*Generated by ChannelScope from public metadata (title, description${transcript ? ', transcript beats' : ''}, duration). Transcript, where used, was analysis material only — no source lines are reproduced.*`);
    res.json({ ok: true, script: lines.join('\n'), sourceTitle: video.title, sourceChannel: owner.title, durationSec, minutes, words });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Script banate hue error aaya.' });
  }
});

// ---------- results ----------
app.get('/api/results', (req, res) => {
  const maps = getMaps();
  const channels = maps.reduce((a, m) => a + m.channels.length, 0);
  const videos = maps.reduce((a, m) => a + m.channels.reduce((x, c) => x + c.videos.length, 0), 0);
  let breakouts = 0;
  for (const m of maps) for (const c of m.channels) {
    const med = c.medianViews || 0;
    if (med) breakouts += c.videos.filter(v => v.views >= med * 3).length;
  }
  const s = quotaResetIfNeeded(getSettings());
  res.json({
    ok: true, results: {
      maps: maps.length, channels, videos, breakouts,
      quotaUsed: s.quotaUsed || 0, quotaLimit: QUOTA_LIMIT
    }
  });
});

// ---------- start ----------
async function openBrowserWhenReady(url, port) {
  // Wait until the server actually answers before opening the browser, so the
  // user never lands on "localhost refused to connect" (e.g. a slow first
  // start while the runtime is still warming up).
  if (process.platform !== 'win32' || process.env.CHANNELSCOPE_NO_BROWSER) return;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/api/status`);
      if (r.ok) break;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  try {
    require('child_process').exec(`cmd /c start "" "${url}"`, () => {});
  } catch (e) { /* ignore */ }
}

function startServer(port, attemptsLeft) {
  const server = app.listen(port, () => {
    console.log(`ChannelScope running at http://localhost:${port}`);
    console.log('Open this URL in your browser. Paste your YouTube Data API v3 key in Settings.');
    openBrowserWhenReady(`http://localhost:${port}`, port);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} busy — trying ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else {
      console.error('Server start failed:', err.message);
      process.exit(1);
    }
  });
}
startServer(PORT, 5);

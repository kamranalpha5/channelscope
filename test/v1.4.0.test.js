// ChannelScope v1.4.0 verification tests (temp servers, stubbed YouTube API,
// fake Postgres pool — NO live database, NO real key; all values below fake).
// Run: node test/v1.4.0.test.js
// What it proves:
//  A. Version bump: APP_VERSION + package.json are 1.4.0, pg is a dependency,
//     cache TTLs are 24h (channel/video) and 6h (trending).
//  B. JSON-fallback mode (DATABASE_URL unset): storage 'json', maps + search
//     cache still persist to data/*.json files — behaviour unchanged.
//  C. DB mode with a fake pool: initStore creates all 9 tables; setup /
//     register / maps land in the fake Postgres tables, NOT in data/*.json.
//  D. Database-first, fully cached build: map create + expand make ZERO
//     YouTube calls — but the token charge still applies (100 spent).
//  E. Cache miss: the first expand runs each uncached search ONCE, saves it,
//     and a second expand reuses the cache (0 new searches).
//  F. TTL expiry: a stale (25h-old) channel row is re-fetched and re-saved;
//     a fresh row is served without a call.
//  G. DB mode, refund + search guard + admin exemption unchanged: a 429
//     quotaExceeded on expand refunds in full, the block is persisted in
//     Postgres (not search-blocked.json), new builds get 503, admins pay 0.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..');
const SEARCH_BLOCKED_MSG = "YouTube's daily search limit is exhausted — please try again tomorrow. Your tokens were not charged.";
const FAKE_KEY = 'FAKE-KEY-140';
const TODAY = new Date().toISOString().slice(0, 10);

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// ---------- fake Postgres pool (in-memory tables, records every query) ----------
const TABLES = ['cs_settings', 'cs_users', 'cs_allowlist', 'cs_maps', 'cs_search_cache', 'cs_search_blocked', 'cs_secret', 'cs_trending', 'cs_yt_cache'];
const PK = { cs_settings: 'key', cs_users: 'email', cs_allowlist: 'email', cs_maps: 'id', cs_search_cache: 'cache_key', cs_search_blocked: 'id', cs_secret: 'id', cs_trending: 'cache_key', cs_yt_cache: 'cache_key' };
class FakePool {
  constructor(seed) {
    this.tables = {};
    for (const t of TABLES) this.tables[t] = {};
    if (seed) for (const [t, rows] of Object.entries(seed)) for (const r of rows) this.tables[t][r[PK[t]]] = r;
    this.log = [];
    this.ended = false;
  }
  async query(sql, params) {
    this.log.push({ sql: String(sql), params: params || [] });
    const s = String(sql);
    if (/^CREATE TABLE/i.test(s)) return { rows: [] };
    let m;
    if ((m = s.match(/^INSERT INTO (\w+) \(([^)]+)\)/i))) {
      const table = m[1];
      const cols = m[2].split(',').map(c => c.trim());
      const row = {};
      cols.forEach((c, i) => { row[c] = (params || [])[i]; });
      this.tables[table][row[cols[0]]] = row;
      return { rows: [] };
    }
    if ((m = s.match(/^DELETE FROM (\w+)(?: WHERE (.+))?$/i))) {
      const table = m[1];
      const where = m[2];
      if (!where) { this.tables[table] = {}; return { rows: [] }; }
      const wm = where.match(/^(\w+) (<>|=|<) \$1$/);
      if (!wm) throw new Error('FakePool: unsupported WHERE: ' + where);
      const col = wm[1], op = wm[2], val = (params || [])[0];
      for (const k of Object.keys(this.tables[table])) {
        const v = this.tables[table][k][col];
        const drop = op === '=' ? v === val : op === '<>' ? v !== val : v < val;
        if (drop) delete this.tables[table][k];
      }
      return { rows: [] };
    }
    if ((m = s.match(/^SELECT .* FROM (\w+)/i))) {
      return { rows: Object.values(this.tables[m[1]] || {}) };
    }
    throw new Error('FakePool: unsupported SQL: ' + s);
  }
  async end() { this.ended = true; }
  creates() { return this.log.filter(e => /^CREATE TABLE/i.test(e.sql)).map(e => e.sql); }
  inserts(table) { return this.log.filter(e => new RegExp('^INSERT INTO ' + table + '\\b', 'i').test(e.sql)); }
}

// ---------- stubbed YouTube API ----------
const realFetch = globalThis.fetch;
const ytCalls = { search: 0, channels: 0, playlistItems: 0, videos: 0 };
let ytMode = 'live'; // 'live' | 'quota' (search 429s) | 'throw' (any googleapis call throws)
function resetYtCalls() { ytCalls.search = 0; ytCalls.channels = 0; ytCalls.playlistItems = 0; ytCalls.videos = 0; }
function ytTotal() { return ytCalls.search + ytCalls.channels + ytCalls.playlistItems + ytCalls.videos; }

function chanItem(id, o) {
  return {
    id,
    snippet: {
      title: o.title, description: o.desc || '', customUrl: o.handle || '',
      country: o.country || 'US', publishedAt: o.publishedAt || '2020-01-05T00:00:00Z',
      thumbnails: { medium: { url: 'https://i.ytimg.com/vi/x/mqdefault.jpg' }, high: { url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' } },
      tags: o.tags || []
    },
    statistics: { subscriberCount: o.subs, viewCount: o.views || '1000000', videoCount: o.videoCount || '50' },
    topicDetails: { topicCategories: o.cats || [] },
    contentDetails: { relatedPlaylists: { uploads: o.uploads || '' } }
  };
}
function vidItem(id, o) {
  return {
    id,
    snippet: {
      title: o.title, description: o.desc || '', publishedAt: o.publishedAt || '2026-11-01T00:00:00Z',
      channelId: o.channelId, channelTitle: o.channelTitle,
      thumbnails: { medium: { url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' } },
      tags: o.tags || []
    },
    statistics: { viewCount: String(o.views || 5000), likeCount: '100', commentCount: '10' },
    contentDetails: { duration: o.duration || 'PT5M30S' }
  };
}
function mappedVid(id, o) {
  return {
    id, title: o.title, description: o.desc || '', publishedAt: o.publishedAt || '2026-11-01T00:00:00Z',
    channelId: o.channelId, channelTitle: o.channelTitle,
    thumbnail: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
    views: o.views || 5000, likes: 100, comments: 10, durationSec: 330, tags: o.tags || []
  };
}
const CATS = ['https://en.wikipedia.org/wiki/Timelapse_photography'];
const CHANNELS = {
  UC_SEED1: chanItem('UC_SEED1', { title: 'Seed Timelapse', handle: '@SeedTimelapse', desc: 'Timelapse films of world cities', subs: '5000', cats: CATS, uploads: 'UU_SEED1' }),
  UC_NBR1: chanItem('UC_NBR1', { title: 'City Timelapse Daily', handle: '@CityTimelapseDaily', desc: 'timelapse city films every day', subs: '9000', cats: CATS, uploads: 'UU_NBR1' })
};
const VIDEOS = {
  'SEED-VID1': vidItem('SEED-VID1', { title: 'New York City Timelapse 4K', channelId: 'UC_SEED1', channelTitle: 'Seed Timelapse', tags: ['timelapse', 'new york', 'city', 'skyline'], views: 5000 }),
  'SEED-VID2': vidItem('SEED-VID2', { title: 'London Streets Timelapse', channelId: 'UC_SEED1', channelTitle: 'Seed Timelapse', tags: ['timelapse', 'london', 'streets'], views: 3000, duration: 'PT4M10S', publishedAt: '2026-10-20T00:00:00Z' }),
  'NBR-VID1': vidItem('NBR-VID1', { title: 'Tokyo City Timelapse', channelId: 'UC_NBR1', channelTitle: 'City Timelapse Daily', tags: ['timelapse', 'city', 'tokyo'], views: 80000 }),
  'NBR-VID2': vidItem('NBR-VID2', { title: 'Paris City Timelapse', channelId: 'UC_NBR1', channelTitle: 'City Timelapse Daily', tags: ['timelapse', 'city', 'paris'], views: 60000 })
};
const MAPPED = {
  'UC_SEED1:20': [
    mappedVid('SEED-VID1', { title: 'New York City Timelapse 4K', channelId: 'UC_SEED1', channelTitle: 'Seed Timelapse', tags: ['timelapse', 'new york', 'city', 'skyline'], views: 5000 }),
    mappedVid('SEED-VID2', { title: 'London Streets Timelapse', channelId: 'UC_SEED1', channelTitle: 'Seed Timelapse', tags: ['timelapse', 'london', 'streets'], views: 3000, publishedAt: '2026-10-20T00:00:00Z' })
  ],
  'UC_NBR1:10': [
    mappedVid('NBR-VID1', { title: 'Tokyo City Timelapse', channelId: 'UC_NBR1', channelTitle: 'City Timelapse Daily', tags: ['timelapse', 'city', 'tokyo'], views: 80000 }),
    mappedVid('NBR-VID2', { title: 'Paris City Timelapse', channelId: 'UC_NBR1', channelTitle: 'City Timelapse Daily', tags: ['timelapse', 'city', 'paris'], views: 60000 })
  ]
};
const PLAYLISTS = { UU_SEED1: ['SEED-VID1', 'SEED-VID2'], UU_NBR1: ['NBR-VID1', 'NBR-VID2'] };
function ytResp(status, obj) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('127.0.0.1') || u.includes('localhost')) return realFetch(url, opts);
  if (!u.includes('googleapis.com')) throw new Error('unexpected fetch: ' + u);
  if (ytMode === 'throw') throw new Error('UNEXPECTED YouTube call in fully-cached mode: ' + u);
  const parsed = new URL(u);
  const p = parsed.searchParams;
  if (parsed.pathname.endsWith('/channels')) {
    ytCalls.channels++;
    if (p.get('forHandle')) return ytResp(200, { items: [{ id: 'UC_SEED1' }] });
    const ids = (p.get('id') || '').split(',').filter(Boolean);
    return ytResp(200, { items: ids.map(id => CHANNELS[id] || chanItem(id, { title: 'Channel ' + id, subs: '100' })) });
  }
  if (parsed.pathname.endsWith('/playlistItems')) {
    ytCalls.playlistItems++;
    const vids = PLAYLISTS[p.get('playlistId')] || [];
    return ytResp(200, { items: vids.map(id => ({ contentDetails: { videoId: id } })) });
  }
  if (parsed.pathname.endsWith('/videos')) {
    ytCalls.videos++;
    const ids = (p.get('id') || '').split(',').filter(Boolean);
    return ytResp(200, { items: ids.map(id => VIDEOS[id]).filter(Boolean) });
  }
  if (parsed.pathname.endsWith('/search')) {
    ytCalls.search++;
    if (ytMode === 'quota') {
      return ytResp(429, { error: { code: 429, status: 'PERMISSION_DENIED', message: "Quota exceeded for quota metric 'Search Queries' and limit 'Search Queries per day'.", errors: [{ reason: 'quotaExceeded', domain: 'usageLimits', message: "Quota exceeded for quota metric 'Search Queries'." }] } });
    }
    return ytResp(200, { items: [{ id: { channelId: 'UC_NBR1' }, snippet: { channelId: 'UC_NBR1', channelTitle: 'City Timelapse Daily', title: 'Tokyo City Timelapse', publishedAt: '2026-11-05T00:00:00Z', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/NBR-VID1/mqdefault.jpg' } } } }] });
  }
  throw new Error('unexpected endpoint: ' + parsed.pathname);
};

// ---------- temp servers ----------
function makeServer(dbMode, fakePool) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs140-'));
  fs.cpSync(SRC, dir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== '.git' && base !== 'node_modules' && base !== 'data' && base !== 'test' && !base.startsWith('deploy-');
    }
  });
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const savedEnv = process.env.DATABASE_URL;
  if (dbMode) process.env.DATABASE_URL = 'postgres://fake-test-only:5432/fake';
  else delete process.env.DATABASE_URL;
  const mod = require(path.join(dir, 'server.js'));
  if (savedEnv === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedEnv;
  return { dir, mod, fakePool, server: null, port: 0 };
}
async function startServer(S) {
  if (S.fakePool) await S.mod.initStore(S.fakePool);
  S.mod.ensureAdminFromEnv();
  await new Promise((resolve) => {
    S.server = S.mod.app.listen(0, '127.0.0.1', () => { S.port = S.server.address().port; resolve(); });
  });
  return S;
}
function httpClient(S) {
  let cookie = '';
  return {
    setCookie(c) { cookie = c; },
    getCookie() { return cookie; },
    async call(method, p, body) {
      const res = await realFetch(`http://127.0.0.1:${S.port}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* html */ }
      return { status: res.status, json, text };
    }
  };
}

// Seed helpers for the fake pool.
function settingsRow(key) {
  return { key: 'settings', value: { apiKey: key, quotaUsed: 0, quotaDate: TODAY, searchUsed: 0, searchDate: TODAY } };
}
function searchRowsFor(queries, value) {
  const rows = [];
  for (const q of queries) for (const kind of ['ch', 'vid']) rows.push({ cache_key: kind + '|' + q, value, cache_date: TODAY });
  return rows;
}
const SEARCH_QUERIES = ['timelapse', 'york', 'city', 'london', 'streets', 'tokyo', 'paris', 'seed', 'films', 'world', 'cities', 'skyline'];
function ytSeedRows(staleNbrChannel) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  return [
    { cache_key: 'handle|@seedtimelapse', value: 'UC_SEED1', fetched_at: now },
    { cache_key: 'channel|UC_SEED1', value: CHANNELS.UC_SEED1, fetched_at: now },
    { cache_key: 'videos|UC_SEED1:20', value: MAPPED['UC_SEED1:20'], fetched_at: now },
    { cache_key: 'channel|UC_NBR1', value: CHANNELS.UC_NBR1, fetched_at: staleNbrChannel ? stale : now },
    { cache_key: 'videos|UC_NBR1:10', value: MAPPED['UC_NBR1:10'], fetched_at: now }
  ];
}

async function main() {
  // ---------- A. version + TTL constants (JSON-mode require of SRC) ----------
  delete process.env.DATABASE_URL;
  const srcMod = require(path.join(SRC, 'server.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  check('APP_VERSION is 1.4.0', srcMod.APP_VERSION === '1.4.0', String(srcMod.APP_VERSION));
  check('package.json version is 1.4.0', pkg.version === '1.4.0', pkg.version);
  check('package.json depends on pg ^8', typeof pkg.dependencies.pg === 'string' && pkg.dependencies.pg.startsWith('^8'), pkg.dependencies.pg);
  check('channel/video TTL is 24h', srcMod.CHANNEL_TTL_MS === 24 * 3600 * 1000 && srcMod.VIDEO_TTL_MS === 24 * 3600 * 1000);
  check('trending TTL is shorter (6h)', srcMod.TRENDING_TTL_MS === 6 * 3600 * 1000);
  check('effectiveApiKey still works in JSON mode (v1.3.4 preserved)',
    srcMod.effectiveApiKey({ apiKey: '' }) === '' && srcMod.effectiveApiKey({ apiKey: 'FAKE-K-140' }) === 'FAKE-K-140');

  // ---------- B. JSON-fallback mode: files are still the source of truth ----------
  ytMode = 'live';
  resetYtCalls();
  const B = await startServer(makeServer(false, null));
  const b = httpClient(B);
  let r = await b.call('GET', '/api/status');
  check('[JSON] status: version 1.4.0 + storage json', r.json.version === '1.4.0' && r.json.storage === 'json',
    JSON.stringify({ version: r.json.version, storage: r.json.storage }));
  r = await b.call('POST', '/api/auth/setup', { email: 'admin@test.com', password: 'password123' });
  check('[JSON] setup admin -> 200', r.status === 200 && r.json.role === 'admin');
  r = await b.call('POST', '/api/settings/key', { key: FAKE_KEY });
  check('[JSON] save key -> 200', r.status === 200 && r.json.ok, 'status ' + r.status);
  r = await b.call('POST', '/api/auth/register', { email: 'user@test.com', password: 'password123' });
  check('[JSON] register user -> 200', r.status === 200 && r.json.role === 'user');
  resetYtCalls();
  r = await b.call('POST', '/api/maps', { input: '@SeedTimelapse', depth: 2 });
  check('[JSON] create map -> 200, no searches yet (create only resolves the seed)',
    r.status === 200 && ytCalls.search === 0,
    'status ' + r.status + ' searches=' + ytCalls.search);
  const mapB = r.json.map.id;
  r = await b.call('POST', '/api/maps/' + mapB + '/expand');
  check('[JSON] expand -> 200 with neighbour, live searches ran',
    r.status === 200 && r.json.map.channels.length === 2 && ytCalls.search > 0,
    'status ' + r.status + ' searches=' + ytCalls.search);
  const mapsFile = path.join(B.dir, 'data', 'maps.json');
  const searchFile = path.join(B.dir, 'data', 'search-cache.json');
  check('[JSON] map persisted to data/maps.json',
    fs.existsSync(mapsFile) && fs.readFileSync(mapsFile, 'utf8').includes(mapB));
  check('[JSON] search cache persisted to data/search-cache.json', fs.existsSync(searchFile));
  B.server.close();

  // ---------- C + D. DB mode, fully seeded cache: setup + zero-call build ----------
  ytMode = 'throw'; // any YouTube call from here on is a failure
  resetYtCalls();
  const fakeCD = new FakePool({
    cs_settings: [settingsRow(FAKE_KEY)],
    cs_search_cache: searchRowsFor(SEARCH_QUERIES, ['UC_NBR1']),
    cs_yt_cache: ytSeedRows(false)
  });
  const CD = await startServer(makeServer(true, fakeCD));
  const cd = httpClient(CD);
  const creates = fakeCD.creates();
  check('[DB] initStore issued CREATE TABLE IF NOT EXISTS for all 9 tables',
    creates.length === 9 && TABLES.every(t => creates.some(s => s.includes(t))),
    'creates=' + creates.length);
  r = await cd.call('GET', '/api/status');
  check('[DB] status: version 1.4.0 + storage postgres + hasKey from seeded row',
    r.json.version === '1.4.0' && r.json.storage === 'postgres' && r.json.hasKey === true,
    JSON.stringify({ version: r.json.version, storage: r.json.storage, hasKey: r.json.hasKey }));
  r = await cd.call('POST', '/api/auth/setup', { email: 'admin@test.com', password: 'password123' });
  check('[DB] setup admin -> 200', r.status === 200 && r.json.role === 'admin', 'status ' + r.status);
  const adminCookie = cd.getCookie();
  r = await cd.call('POST', '/api/auth/register', { email: 'user@test.com', password: 'password123' });
  check('[DB] register user -> 200', r.status === 200 && r.json.role === 'user');
  const userCookie = cd.getCookie();
  check('[DB] users landed in cs_users (admin + user)',
    Object.keys(fakeCD.tables.cs_users).length === 2 &&
    !!fakeCD.tables.cs_users['admin@test.com'] && !!fakeCD.tables.cs_users['user@test.com'],
    'rows=' + Object.keys(fakeCD.tables.cs_users).join(','));
  check('[DB] no data/*.json files were created in DB mode',
    !fs.existsSync(path.join(CD.dir, 'data', 'maps.json')) &&
    !fs.existsSync(path.join(CD.dir, 'data', 'users.json')) &&
    !fs.existsSync(path.join(CD.dir, 'data', 'settings.json')) &&
    !fs.existsSync(path.join(CD.dir, 'data', 'search-cache.json')));
  // Fully-cached build: create + expand with ZERO YouTube calls.
  r = await cd.call('POST', '/api/maps', { input: '@SeedTimelapse', depth: 2 });
  check('[DB] cached map create -> 200, tokens STILL charged 100 (pricing unchanged)',
    r.status === 200 && r.json.tokens.spent === 100 && r.json.tokens.balance === 0,
    'status ' + r.status + ' ' + JSON.stringify(r.json.tokens || r.json));
  check('[DB] cached map create made ZERO YouTube calls', ytTotal() === 0, 'calls=' + ytTotal());
  const mapCD = r.json.map.id;
  check('[DB] map row saved to cs_maps', !!fakeCD.tables.cs_maps[mapCD], 'rows=' + Object.keys(fakeCD.tables.cs_maps).join(','));
  r = await cd.call('POST', '/api/maps/' + mapCD + '/expand');
  check('[DB] cached expand -> 200 with neighbour, still ZERO YouTube calls',
    r.status === 200 && r.json.map.channels.length === 2 && ytTotal() === 0,
    'status ' + r.status + ' channels=' + (r.json.map && r.json.map.channels.length) + ' calls=' + ytTotal());
  check('[DB] expand served the neighbour from the DB cache (UC_NBR1 in map)',
    (r.json.map.channels || []).some(c => c.id === 'UC_NBR1'));
  await CD.mod.flushStoreWrites();
  CD.server.close();

  // ---------- Restart survival: same fake pool, fresh server, state is back ----------
  const CD2 = await startServer(makeServer(true, fakeCD));
  const cd2 = httpClient(CD2);
  r = await cd2.call('GET', '/api/status');
  check('[DB] after restart: storage postgres + hasKey true (key survived)',
    r.json.storage === 'postgres' && r.json.hasKey === true, JSON.stringify({ storage: r.json.storage, hasKey: r.json.hasKey }));
  r = await cd2.call('GET', '/api/auth/me');
  check('[DB] after restart: admin still exists (setupNeeded false)',
    r.json.setupNeeded === false, 'setupNeeded=' + r.json.setupNeeded);
  cd2.setCookie(userCookie); // cookie value is a signed session; secret row survived too
  r = await cd2.call('GET', '/api/status');
  check('[DB] after restart: user session still valid, balance still 0 (spent, not refunded)',
    r.json.me.loggedIn === true && r.json.tokens.balance === 0,
    JSON.stringify({ loggedIn: r.json.me && r.json.me.loggedIn, balance: r.json.tokens && r.json.tokens.balance }));
  r = await cd2.call('GET', '/api/maps/' + mapCD);
  check('[DB] after restart: map survived with both channels',
    r.status === 200 && r.json.map.channels.length === 2, 'status ' + r.status);
  CD2.server.close();
  void adminCookie;

  // ---------- E. Cache miss: search runs once, is saved, second expand reuses ----------
  ytMode = 'live';
  resetYtCalls();
  const fakeE = new FakePool({ cs_settings: [settingsRow(FAKE_KEY)] });
  const E = await startServer(makeServer(true, fakeE));
  const e = httpClient(E);
  r = await e.call('POST', '/api/auth/setup', { email: 'admin@test.com', password: 'password123' });
  check('[E] setup admin -> 200', r.status === 200);
  r = await e.call('POST', '/api/auth/register', { email: 'user@test.com', password: 'password123' });
  check('[E] register user -> 200', r.status === 200);
  r = await e.call('POST', '/api/maps', { input: '@SeedTimelapse', depth: 2 });
  check('[E] create map -> 200, no searches yet (handle/details/videos only)',
    r.status === 200 && ytCalls.search === 0, 'status ' + r.status + ' searches=' + ytCalls.search);
  const mapE = r.json.map.id;
  r = await e.call('POST', '/api/maps/' + mapE + '/expand');
  check('[E] first expand -> 200 with neighbour, searches ran',
    r.status === 200 && r.json.map.channels.length === 2 && ytCalls.search > 0,
    'status ' + r.status + ' searches=' + ytCalls.search);
  const searchesAfterFirst = ytCalls.search;
  check('[E] searches were saved to cs_search_cache',
    Object.keys(fakeE.tables.cs_search_cache).length === searchesAfterFirst,
    'rows=' + Object.keys(fakeE.tables.cs_search_cache).length + ' searches=' + searchesAfterFirst);
  r = await e.call('POST', '/api/maps/' + mapE + '/expand');
  check('[E] second expand runs ZERO new searches (cache reuse)',
    ytCalls.search === searchesAfterFirst, 'searches=' + ytCalls.search + ' afterFirst=' + searchesAfterFirst);
  check('[E] second expand stalls on zero new neighbours (not a search failure)',
    r.json.stalled === true, 'status ' + r.status + ' stalled=' + r.json.stalled);
  r = await e.call('GET', '/api/status');
  check('[E] zero-neighbour stall refunded in DB mode (balance back to 100)',
    r.json.tokens.balance === 100, 'balance ' + r.json.tokens.balance);
  E.server.close();

  // ---------- F. TTL expiry: stale channel row is re-fetched and re-saved ----------
  ytMode = 'live';
  resetYtCalls();
  const fakeF = new FakePool({
    cs_settings: [settingsRow(FAKE_KEY)],
    cs_search_cache: searchRowsFor(SEARCH_QUERIES, ['UC_NBR1']),
    cs_yt_cache: ytSeedRows(true) // UC_NBR1 channel row is 25h old
  });
  const F = await startServer(makeServer(true, fakeF));
  check('[F] unit: stale channel row reads as a miss', F.mod.ytCacheGet('channel', 'UC_NBR1') === null);
  check('[F] unit: fresh channel row reads as a hit',
    F.mod.ytCacheGet('channel', 'UC_SEED1') && F.mod.ytCacheGet('channel', 'UC_SEED1').id === 'UC_SEED1');
  const f = httpClient(F);
  r = await f.call('POST', '/api/auth/setup', { email: 'admin@test.com', password: 'password123' });
  check('[F] setup admin -> 200', r.status === 200);
  r = await f.call('POST', '/api/auth/register', { email: 'user@test.com', password: 'password123' });
  check('[F] register user -> 200', r.status === 200);
  r = await f.call('POST', '/api/maps', { input: '@SeedTimelapse', depth: 2 });
  check('[F] cached seed create -> 200, ZERO YouTube calls', r.status === 200 && ytTotal() === 0, 'calls=' + ytTotal());
  const mapF = r.json.map.id;
  const channelsBefore = ytCalls.channels;
  r = await f.call('POST', '/api/maps/' + mapF + '/expand');
  check('[F] expand re-fetched the stale channel (channels call made)',
    r.status === 200 && ytCalls.channels > channelsBefore,
    'status ' + r.status + ' channelsCalls=' + ytCalls.channels);
  check('[F] expand used ZERO searches (search rows were fresh)',
    ytCalls.search === 0, 'searches=' + ytCalls.search);
  const refreshed = fakeF.tables.cs_yt_cache['channel|UC_NBR1'];
  check('[F] stale row was re-saved fresh in cs_yt_cache',
    !!refreshed && (Date.now() - new Date(refreshed.fetched_at).getTime()) < 120000,
    'fetched_at=' + (refreshed && refreshed.fetched_at));
  F.server.close();

  // ---------- G. DB mode: refund + search guard + admin exemption ----------
  ytMode = 'quota'; // every search answers 429 quotaExceeded
  resetYtCalls();
  const fakeG = new FakePool({ cs_settings: [settingsRow(FAKE_KEY)] });
  const G = await startServer(makeServer(true, fakeG));
  const gAdmin = httpClient(G);
  const gUser = httpClient(G);
  r = await gAdmin.call('POST', '/api/auth/setup', { email: 'admin@test.com', password: 'password123' });
  check('[G] setup admin -> 200', r.status === 200);
  r = await gAdmin.call('POST', '/api/maps', { input: '@SeedTimelapse', depth: 2 });
  check('[G] ADMIN map: 200, spent 0, unlimited (exemption unchanged in DB mode)',
    r.status === 200 && r.json.tokens.spent === 0 && r.json.tokens.unlimited === true,
    'status ' + r.status + ' ' + JSON.stringify(r.json.tokens || r.json));
  r = await gUser.call('POST', '/api/auth/register', { email: 'user@test.com', password: 'password123' });
  check('[G] register user -> 200', r.status === 200);
  r = await gUser.call('POST', '/api/maps', { input: '@SeedTimelapse', depth: 2 });
  check('[G] USER map: 200, charged 100', r.status === 200 && r.json.tokens.balance === 0,
    'status ' + r.status + ' ' + JSON.stringify(r.json.tokens || r.json));
  const mapG = r.json.map.id;
  r = await gUser.call('POST', '/api/maps/' + mapG + '/expand');
  check('[G] expand with 429 search quota -> 400 stalled + refunded',
    r.status === 400 && r.json.refunded === true,
    'status ' + r.status + ' refunded=' + r.json.refunded);
  r = await gUser.call('GET', '/api/status');
  check('[G] REFUND in DB mode: balance back to 100', r.json.tokens.balance === 100, 'balance ' + r.json.tokens.balance);
  check('[G] search block persisted in cs_search_blocked (Postgres, not a file)',
    fakeG.tables.cs_search_blocked.blocked &&
    fakeG.tables.cs_search_blocked.blocked.blocked_date === TODAY,
    JSON.stringify(fakeG.tables.cs_search_blocked.blocked));
  check('[G] no data/search-blocked.json file was created in DB mode',
    !fs.existsSync(path.join(G.dir, 'data', 'search-blocked.json')));
  r = await gUser.call('POST', '/api/maps', { input: '@SeedTimelapse', depth: 2 });
  check('[G] GUARD in DB mode: new build while blocked -> 503 exact message',
    r.status === 503 && r.json.error === SEARCH_BLOCKED_MSG,
    'status ' + r.status + ' ' + (r.json.error || '').slice(0, 80));
  r = await gUser.call('GET', '/api/status');
  check('[G] GUARD: balance unchanged at 100', r.json.tokens.balance === 100, 'balance ' + r.json.tokens.balance);
  G.server.close();

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });

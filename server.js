// ChannelScope (standalone) — YouTube competitor-mapping tool.
// Runs on your own PC. Uses YOUR YouTube Data API v3 key (stored locally only,
// or from the YOUTUBE_API_KEY env var — v1.3.4, survives free-plan restarts).
// Neighbour discovery NEVER uses relatedToVideoId (YouTube removed it Aug 2023).
// Niche is derived per seed channel from that channel's own titles/tags/category.

const express = require('express');
const crypto = require('crypto');
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
// YouTube has a SEPARATE, much smaller quota for search.list: "Search Queries
// per day" = 100 (the 10,000-unit quota does NOT cover it). Live finding
// 2026-11-11 (Cloud Console, project NexGen): usage was 112/100 — OVER
// LIMIT — which is why search.list fails while channels/videos work.
// Everything below is built around that number: searches are cached per day
// and guarded, so the site never burns a search call it does not need.
const SEARCH_LIMIT = 100;

// ---------- Stripe billing (webhook FIRST — before express.json) ----------
// Stripe verifies the webhook signature over the RAW request body, so this
// route must be registered before express.json() parses the body. If Stripe
// is not configured (no STRIPE_SECRET_KEY), the route answers 503 and
// payments stay disabled — the rest of the site works normally.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).json({ ok: false, error: 'Payments are not configured.' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error('Stripe webhook signature verification failed:', e.message);
    return res.status(400).json({ ok: false, error: 'Invalid signature.' });
  }
  try { await handleStripeEvent(event); } catch (e) { console.error('Stripe webhook handler failed:', e.message); }
  res.json({ received: true });
});

// Privacy Policy — public page (no login, no allowlist). Required for the
// YouTube Audit and Quota Extension Form: https://<host>/privacy
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
// Terms of Service — public page (v1.3.2), linked from the same footers as /privacy.
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

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
// ---------- YouTube API key (v1.3.4) ----------
// The site's ONE key can come from two places. The admin-panel-saved key in
// settings.json wins when present; otherwise the YOUTUBE_API_KEY env var
// (Render dashboard) is used. The env route survives free-plan restarts,
// which wipe data/settings.json. This is a pure resolver: it never writes
// anything, so the env key is never persisted into settings.json (quota
// saves via saveSettingsSoon would otherwise copy it there). The key value
// is NEVER logged or included in any response — only the boolean hasKey
// is ever exposed.
function effectiveApiKey(settings) {
  const s = settings || getSettings();
  if (s.apiKey && String(s.apiKey).trim()) return s.apiKey;
  const envKey = (process.env.YOUTUBE_API_KEY || '').trim();
  return envKey || '';
}
function getMaps() { return loadJson(MAPS_FILE, { maps: [] }).maps; }
function saveMaps(maps) { saveJson(MAPS_FILE, { maps }); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ---------- auth: email + password, allowlist-gated Overview/Trending ----------
// Passwords: node:crypto scrypt (no new npm dependency). Sessions: HMAC-signed
// cookie token. Users + allowlist live in data/users.json — on the free Render
// plan a restart can reset data/, so the admin may need to re-add them
// (see README caveat; ADMIN_EMAIL/ADMIN_PASSWORD env vars re-create the admin
// automatically on every boot).
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.json');
function getUsers() { return loadJson(USERS_FILE, { users: [], allowlist: [] }); }
function saveUsers(u) { saveJson(USERS_FILE, u); }
function getSecret() {
  let s = loadJson(SECRET_FILE, null);
  if (!s || !s.secret) { s = { secret: crypto.randomBytes(32).toString('hex') }; saveJson(SECRET_FILE, s); }
  return s.secret;
}
function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const h = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
function signSession(email) {
  const exp = Date.now() + 7 * 86400 * 1000; // 7 days
  const payload = Buffer.from(email, 'utf8').toString('base64url') + '.' + exp;
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return payload + '.' + sig;
}
function verifySession(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [b64, exp, sig] = parts;
    if (Date.now() > +exp) return null;
    const expect = crypto.createHmac('sha256', getSecret()).update(b64 + '.' + exp).digest('hex');
    const a = Buffer.from(sig, 'hex'), b = Buffer.from(expect, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { email: Buffer.from(b64, 'base64url').toString('utf8'), exp: +exp };
  } catch (e) { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getAuth(req) {
  const s = verifySession(parseCookies(req).cs_session);
  if (!s) return { loggedIn: false, email: null, role: null, allowed: false };
  const store = getUsers();
  const user = store.users.find(u => u.email === normEmail(s.email));
  if (!user) return { loggedIn: false, email: null, role: null, allowed: false };
  const allowed = user.role === 'admin' || store.allowlist.includes(normEmail(user.email));
  return { loggedIn: true, email: user.email, role: user.role, allowed };
}
function setSessionCookie(res, email) {
  res.setHeader('Set-Cookie', `cs_session=${signSession(email)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 86400}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'cs_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}
// First admin from env (Render dashboard: ADMIN_EMAIL + ADMIN_PASSWORD).
// Re-runs on every boot, so a free-plan restart re-creates the admin.
function ensureAdminFromEnv() {
  const email = normEmail(process.env.ADMIN_EMAIL);
  const pass = process.env.ADMIN_PASSWORD;
  if (!email || !pass || !validEmail(email) || pass.length < 8) return;
  const store = getUsers();
  if (store.users.some(u => u.email === email)) return;
  store.users.push({ email, password: hashPassword(pass), role: 'admin', createdAt: new Date().toISOString() });
  saveUsers(store);
  console.log('Admin account created from env for', email);
}
const ACCESS_NOTE = 'This data is only visible to users with access — contact the site owner for access.';
// SERVER-SIDE MASKING: non-allowed users never receive real channel/video
// data in Overview/Trending responses — names become "•••", DPs/numbers null.
// CSS blur alone would still leak the data in the JSON; this does not.
function maskChannelRow(r) {
  return { ...r, id: null, title: '•••', thumbnail: null, subs: null, ageDays: null, medianViews: null, bestMultiple: null, bestViews: null, avgViews: null, videoCount: null, bestPublishedAt: null };
}
function maskVideoCard(v) {
  return { ...v, id: null, title: '•••', thumbnail: null, duration: null, views: null, publishedAt: null, channelId: null, channelTitle: '•••', channelThumbnail: null, subs: null, vph: null };
}
function maskTrendingChannel(c) {
  return {
    ...c, channelId: null, title: '•••', thumbnail: null, subs: null, ageDays: null,
    channelPublishedAt: null, medianViews: null, bestMultiple: null, bestViews: null,
    videos: (c.videos || []).map(v => ({ ...v, id: null, title: '•••', views: null, multiple: null, publishedAt: null, duration: null, thumbnail: null }))
  };
}

function quotaResetIfNeeded(s) {
  if (s.quotaDate !== todayStr()) { s.quotaUsed = 0; s.quotaDate = todayStr(); }
  if (s.searchDate !== todayStr()) { s.searchUsed = 0; s.searchDate = todayStr(); }
  return s;
}
function addQuota(s, units) {
  quotaResetIfNeeded(s);
  s.quotaUsed = (s.quotaUsed || 0) + units;
  saveSettingsSoon(s);
}
// One real search.list call = 1 of the 100 daily searches. Call this at every
// search site (resolve fallback, neighbour discovery, trending) — and ONLY
// there, never for a cached result. Charged BEFORE the call: Google counts a
// search that reaches the API even when it answers quotaExceeded, so
// counting only successes would under-report exactly when it matters most.
// (An invalid-key call is likely not counted by Google, so the counter can
// run slightly high until the key is fixed — conservative and self-correcting
// at the daily reset.)
function chargeSearch(settings) {
  quotaResetIfNeeded(settings);
  settings.searchUsed = (settings.searchUsed || 0) + 1;
  saveSettingsSoon(settings);
}
function searchRemaining(settings) {
  quotaResetIfNeeded(settings);
  return SEARCH_LIMIT - (settings.searchUsed || 0);
}
// Fail fast before starting work the search quota cannot cover, so the user
// never pays tokens for a build that is doomed to stall on search.
const SEARCH_BLOCKED_MSG = 'YouTube\'s daily search limit is exhausted — please try again tomorrow. Your tokens were not charged.';
function searchGuardError(settings, needed) {
  // Real-quota block (v1.3.2): if YouTube already answered a search with
  // quotaExceeded today, block before charging. A build whose searches are
  // all cached (needed === 0) still runs — it needs no new search.
  if (needed > 0 && isSearchBlockedToday()) return SEARCH_BLOCKED_MSG;
  const left = searchRemaining(settings);
  if (left < needed) {
    return `Daily search quota is exhausted — only ${left} of ${SEARCH_LIMIT} search calls remain today. Please try again tomorrow.`;
  }
  return null;
}
// Plain-English hint appended whenever YouTube answers quotaExceeded on a
// search — the raw error is still surfaced alongside it (see /api/diag).
function quotaExceededHint(ytErr) {
  return ytErr && ytErr.reason === 'quotaExceeded' ? ' The daily search quota (100 searches/day) is exhausted — please try again tomorrow.' : '';
}

// ---------- daily search cache ----------
// The same query (same type) is never paid for twice in one day. This is the
// big saving: a Depth-2 map's ring 2 re-searches ring 1's exact queries, so
// with the cache it costs 0 searches; a retried stalled ring costs 0 too.
// Cache file: data/search-cache.json (gitignored). Entries expire daily.
// Values are the minimal data each caller needs (channel IDs / video objects).
// All helpers are synchronous (read-modify-write with no await inside) so
// parallel search jobs can never clobber each other's entries.
const SEARCH_CACHE_FILE = path.join(DATA_DIR, 'search-cache.json');
const SEARCH_CACHE_MAX = 1000;
function getSearchCache() {
  const c = loadJson(SEARCH_CACHE_FILE, { date: '', entries: {} });
  if (c.date !== todayStr()) return { date: todayStr(), entries: {} };
  return c;
}
function searchCacheKey(kind, q) { return kind + '|' + String(q || '').trim().toLowerCase(); }
function searchCacheGet(kind, q) {
  const c = getSearchCache();
  const v = c.entries[searchCacheKey(kind, q)];
  return v === undefined ? null : v;
}
function searchCacheSet(kind, q, value) {
  const c = getSearchCache();
  c.entries[searchCacheKey(kind, q)] = value;
  const keys = Object.keys(c.entries);
  if (keys.length > SEARCH_CACHE_MAX) { for (const k of keys.slice(0, keys.length - SEARCH_CACHE_MAX)) delete c.entries[k]; }
  saveJson(SEARCH_CACHE_FILE, c);
}
// Disk writes are debounced: parallel API storms used to do one sync write per
// call (and parallel increments could clobber each other). Flushed at the end
// of a map build / ring expand.
let settingsSaveTimer = null;
function saveSettingsSoon(s) {
  if (settingsSaveTimer) return;
  settingsSaveTimer = setTimeout(() => { settingsSaveTimer = null; try { saveSettings(s); } catch (e) { /* ignore */ } }, 400);
}
// ---------- real search-quota block (v1.3.2) ----------
// YouTube's real "Search Queries per day" usage is NOT visible locally:
// the local searchUsed counter restarts at 0 after every fresh deploy,
// while Google's counter may already be over 100. So once YouTube answers
// a search with 429 quotaExceeded, that fact is remembered for the rest of
// the day — persisted to disk (data/search-blocked.json) so it survives
// restarts. The block clears when the date changes, when a later search
// succeeds, or when the admin saves a new API key.
const SEARCH_BLOCKED_FILE = path.join(DATA_DIR, 'search-blocked.json');
function searchBlockedDate() {
  const b = loadJson(SEARCH_BLOCKED_FILE, { date: '' });
  return b.date || '';
}
function isSearchBlockedToday() { return searchBlockedDate() === todayStr(); }
function markSearchBlocked() {
  if (searchBlockedDate() === todayStr()) return;
  saveJson(SEARCH_BLOCKED_FILE, { date: todayStr() });
}
function clearSearchBlocked() {
  if (!searchBlockedDate()) return;
  saveJson(SEARCH_BLOCKED_FILE, { date: '' });
}

// ---------- tokens + quota protection ----------
// TOKEN MODEL (v1.3.1): tokens are the site's own currency. Every logged-in
// user gets 100 free tokens per day (refreshes every 24h, never accumulates).
// Paid plans (Stripe, monthly) add a monthly grant: Starter $2/mo = 1,500
// tokens/mo, Pro $5/mo = 5,000 tokens/mo. Costs: map build Depth 1 = 50,
// Depth 2 = 100, Depth 4 = 200 tokens; a fresh Trending 24h run = 50.
// Cached data (Overview panels, existing maps, breakouts, results, JSON
// download, script replicate) costs 0 tokens. Building needs login + tokens
// — the allowlist only controls Overview blur/unblur, NOT building.
// The global YouTube quota guard still applies on top: the server never
// spends more than the shared daily YouTube quota (10,000 units/day by
// default), even if the user still has tokens.
const FREE_DAILY_TOKENS = 100;
const PLANS = {
  starter: { id: 'starter', name: 'Starter', price: 2, tokens: 1500, priceEnv: 'STRIPE_PRICE_1500' },
  pro: { id: 'pro', name: 'Pro', price: 5, tokens: 5000, priceEnv: 'STRIPE_PRICE_5000' }
};
const TOKEN_COST = { 1: 50, 2: 100, 4: 200, trending: 50 };
// User billing fields (data/users.json, all optional — missing fields mean
// the free plan with no paid tokens): plan ('free'|'starter'|'pro'),
// paidTokens, freeUsed, freeDate, periodEnd, stripeCustomerId,
// stripeSubscriptionId.
function tokenStateFor(user, today) {
  // ADMIN EXEMPTION (v1.3.2): the site owner never pays tokens — the old
  // build-count system exempted the admin and the token system dropped it
  // by accident. Admins have unlimited tokens. The shared YouTube quota
  // guard still applies to them (it is checked separately, not here), and
  // the admin panel's grant/set-plan still works for non-admin users.
  if (user.role === 'admin') {
    return {
      plan: 'admin', planName: 'Admin',
      freeAllowance: FREE_DAILY_TOKENS, freeUsed: 0, freeLeft: FREE_DAILY_TOKENS,
      paidTokens: 0, balance: null, unlimited: true,
      periodEnd: null
    };
  }
  const freeUsed = (user.freeDate === today) ? (user.freeUsed || 0) : 0;
  const freeLeft = Math.max(0, FREE_DAILY_TOKENS - freeUsed);
  const paidTokens = user.paidTokens || 0;
  const plan = PLANS[user.plan] || null;
  return {
    plan: user.plan || 'free', planName: plan ? plan.name : 'Free',
    freeAllowance: FREE_DAILY_TOKENS, freeUsed, freeLeft,
    paidTokens, balance: freeLeft + paidTokens, unlimited: false,
    periodEnd: user.periodEnd || null
  };
}
function tokenState(email) {
  const store = getUsers();
  const user = store.users.find(u => u.email === normEmail(email));
  if (!user) return null;
  return tokenStateFor(user, todayStr());
}
function checkTokens(email, amount) {
  const st = tokenState(email);
  if (!st) return 'Please log in to continue.';
  if (st.unlimited) return null; // admins are never charged
  if (st.balance < amount) {
    return `Not enough tokens — this costs ${amount} tokens and your balance is ${st.balance}. Your free allowance of ${FREE_DAILY_TOKENS} tokens refreshes tomorrow, or upgrade your plan for more.`;
  }
  return null;
}
// Spend tokens: free daily allowance first (it expires), then paid tokens.
// Returns {ok, balance, freeTaken, paidTaken, spent} or {ok:false, error}.
function spendTokens(email, amount) {
  const store = getUsers();
  const user = store.users.find(u => u.email === normEmail(email));
  if (!user) return { ok: false, error: 'Please log in to continue.' };
  // Admins are never charged (v1.3.2) — no freeUsed/paidTokens is recorded.
  if (user.role === 'admin') return { ok: true, balance: null, freeTaken: 0, paidTaken: 0, spent: 0, unlimited: true };
  const today = todayStr();
  const st = tokenStateFor(user, today);
  if (st.balance < amount) return { ok: false, error: `Not enough tokens — this costs ${amount} tokens and your balance is ${st.balance}.`, balance: st.balance };
  let remaining = amount;
  const freeTaken = Math.min(st.freeLeft, remaining);
  user.freeUsed = ((user.freeDate === today) ? (user.freeUsed || 0) : 0) + freeTaken;
  user.freeDate = today;
  remaining -= freeTaken;
  const paidTaken = remaining;
  if (paidTaken > 0) user.paidTokens = (user.paidTokens || 0) - paidTaken;
  saveUsers(store);
  return { ok: true, balance: st.balance - amount, freeTaken, paidTaken, spent: amount };
}
// Reverse a spend (e.g. a build that was charged but then failed).
function refundTokens(email, freeTaken, paidTaken) {
  const store = getUsers();
  const user = store.users.find(u => u.email === normEmail(email));
  if (!user) return;
  const today = todayStr();
  if (freeTaken > 0 && user.freeDate === today) user.freeUsed = Math.max(0, (user.freeUsed || 0) - freeTaken);
  if (paidTaken > 0) user.paidTokens = (user.paidTokens || 0) + paidTaken;
  saveUsers(store);
}
// Refund a charged build exactly once (v1.3.2). A build that stalls or fails
// after being charged gets its tokens back IN FULL — the searches it did run
// are cached for the day, so a retry costs ~0 new searches anyway. Safe on
// uncharged maps (no paidBy, e.g. built before v1.3.2) and on maps that were
// already refunded: the `refunded` flag is the single-refund guarantee.
function refundMapOnce(map) {
  if (!map || map.refunded || !map.paidBy) return false;
  refundTokens(map.paidBy, map.paidFree || 0, map.paidPaid || 0);
  map.refunded = true;
  upsertMap(map);
  return true;
}
// Cost estimates (measured: one Depth-2 map ≈ 2,283 units; a trending run
// ≈ 335 units). Deliberately conservative so the guard trips before the
// shared daily quota is actually gone.
function estimateForDepth(depth) { return depth >= 4 ? 5000 : depth >= 2 ? 3000 : 1600; }
function estimateForRing() { return 1600; }
function estimateForTrending() { return 500; }
function quotaRemaining(settings) {
  quotaResetIfNeeded(settings);
  return QUOTA_LIMIT - (settings.quotaUsed || 0);
}
function quotaGuardError(settings, estimate) {
  if (quotaRemaining(settings) < estimate) {
    return 'Daily quota is nearly exhausted — please try again tomorrow.';
  }
  return null;
}
// Gate for starting a new build/scan: must be logged in (the allowlist
// does NOT gate building — it only controls Overview blur/unblur).
// Returns the auth object or sends the error.
function requireLogin(req, res) {
  const auth = getAuth(req);
  if (!auth.loggedIn) { res.status(401).json({ ok: false, error: 'Please log in to build maps.', needLogin: true }); return null; }
  return auth;
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

// ---------- YouTube API client ----------
// Auth: the key is sent BOTH as the documented `?key=` query parameter AND
// as the `X-goog-api-key` header. The header alone was verified working for
// search.list (dummy-key test: 400 API_KEY_INVALID on both hosts), but the
// query parameter is the documented method — sending both removes any
// gateway/header-stripping quirk as a variable. The key never appears in
// any log or error payload (see recordYtError — endpoint + reason only).
// Every YouTube failure is recorded (status + reason + message) so the exact
// cause is visible in server logs, API responses and GET /api/diag instead
// of a generic "searches failed" guess.
const lastYtErrors = []; // newest first, max 5 — no keys, no URLs, no bodies
function recordYtError(endpoint, status, reason, message) {
  const e = { endpoint, status, reason, message: String(message || '').slice(0, 300), at: new Date().toISOString() };
  lastYtErrors.unshift(e);
  if (lastYtErrors.length > 5) lastYtErrors.pop();
  // Real-quota block (v1.3.2): a search answered with quotaExceeded means
  // Google's daily search quota is gone — remember it for today so the
  // search guard can block new builds BEFORE charging tokens for them.
  if (reason === 'quotaExceeded' && String(endpoint || '').startsWith('/search')) markSearchBlocked();
  console.error(`[yt-error] ${endpoint} -> ${status} ${reason}: ${e.message}`);
  return e;
}
async function yt(endpoint, params, key) {
  const url = new URL(YT + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', key);
  const res = await fetch(url.toString(), {
    headers: { 'X-goog-api-key': key, 'Accept': 'application/json' }
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* ignore */ }
  if (!res.ok) {
    const errBody = (data && data.error) || {};
    const reason = (errBody.errors && errBody.errors[0] && errBody.errors[0].reason)
      || (errBody.details && errBody.details.find(d => d.reason) && errBody.details.find(d => d.reason).reason)
      || errBody.status || ('HTTP_' + res.status);
    const msg = errBody.message || ('YouTube API error ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.reason = reason;
    err.endpoint = endpoint;
    err.yt = recordYtError(endpoint, res.status, reason, msg);
    err.isInvalidKey = res.status === 400 && /API key not valid/i.test(msg);
    throw err;
  }
  // A search that succeeds clears the real-quota block (v1.3.2) — e.g. the
  // admin saved a key from a project whose search quota is still open.
  if (endpoint.startsWith('/search')) clearSearchBlocked();
  return data;
}
function ytCost(endpoint) { return endpoint.startsWith('/search') ? 100 : 1; }

// ---------- text helpers ----------
const STOP_EN = new Set(('a,an,the,and,or,of,to,in,on,for,with,by,at,from,as,is,are,was,were,it,its,this,that,these,those,how,why,what,when,where,which,who,whom,can,could,should,would,will,just,not,no,yes,you,your,we,our,they,their,he,she,his,her,i,me,my,do,does,did,have,has,had,be,been,being,all,any,more,most,other,some,such,only,own,same,so,than,too,very,about,into,through,after,over,between,out,up,down,off,again,further,then,once,here,there,all,also,new,top,best,video,videos,part,episode,watch,official,full,hd,4k').split(','));
const STOP_KO = new Set(('이,그,저,것,수,등,와,과,은,는,을,를,에,에서,의,가,도,으로,로,하고,이다,입니다,있는,있다,없다,하다,되다,보다,위해,때문,정도,아주,너무,정말,진짜,왜,어떻게,무엇,누가,언제,어디,오늘,내일,어제,이번,다음,처음,마지막,그리고,하지만,그래서,그러나,지금,여기,저기,우리,나,너,그녀,그들,바로,아직,벌써,벌써,많이,조금,다,모두,영상,채널,구독,좋아요,알림,설정,보기,설명,댓글,공유,재생,목록,전체,무료,최신,인기,추천,정보,방법,후기,리뷰,정리,완벽,쉽게,빠르게,바로,알아보기,알아보자,알려드립니다,알려드릴게요,해보자,해봅시다,시작,끝,결론,요약,정리해드릴게요').split(','));
// Spanish stopwords — v1.2.0 filtered only EN + KO, so Spanish stopwords
// ("que / de / se / con / el / es / la / una / por") became niche keywords,
// which made neighbour search + vetting meaningless (ButacaSalvaje2 map).
const STOP_ES = new Set(('de,la,el,los,las,un,una,unos,unas,que,en,y,o,u,es,son,se,su,sus,al,del,con,por,para,como,más,mas,pero,este,esta,estos,estas,eso,esa,ese,aquel,aquella,yo,tú,él,ella,nosotros,vosotros,ellos,ellas,mi,mis,tu,tus,nos,os,le,les,me,te,lo,ya,no,sí,si,también,tampoco,muy,mucho,mucha,muchos,muchas,poco,poca,estoy,estás,está,estamos,están,era,eran,fue,fueron,ser,tiene,tienen,tengo,puedes,puede,pueden,hacer,dice,dicen,año,años,vez,veces,hoy,ayer,mañana,siempre,nunca,donde,cuando,porque,pues,hasta,desde,entre,sobre,sin,tras,ante,bajo,hacia,según,cada,otro,otra,otros,otras,mismo,misma,todos,todas,nadie,alguien,algo,nada,quien,quienes,cual,cuales,cuánto,cuánta,cuántos,cuántas,cómo,dónde,cuándo,qué,cuál,quién,completo,completa,completos,completas,capitulo,capítulo,episodio,temporada,parte,ver,mira,suscribete,suscribirse,gracias,bueno,buena,creo,quiero,puedo').split(','));
const STOP_FR = new Set(('le,la,les,de,des,du,un,une,et,est,dans,pour,que,qui,sur,pas,plus,ce,cet,cette,ces,il,ils,elle,elles,nous,vous,je,tu,on,au,aux,en,à,a,y,se,son,sont,être,avoir,avec,sans,chez,par,comme,tout,tous,toute,toutes,même,aussi,bien,mal,très,peu,beaucoup,jour,jours,ans,an,fois,aujourd,hui,hier,demain,toujours,jamais,où,quand,pourquoi,comment,complet,complète,complets,complètes,épisode,saison,partie,officiel,gratuit,ligne,regarder,voir,abonnez,merci,bon,bonne,je,suis,faire,dire,peut,peuvent').split(','));
const STOP_DE = new Set(('der,die,das,den,dem,des,ein,eine,einen,einem,einer,und,ist,sind,war,waren,von,zu,mit,sich,für,auf,an,in,im,aus,bei,nach,über,unter,durch,vor,als,wie,was,wer,wo,wann,warum,nicht,kein,keine,auch,nur,noch,schon,sehr,mehr,viel,wenig,alle,alles,man,es,ich,du,er,sie,wir,ihr,mein,dein,sein,haben,hat,kann,können,wird,werden,wurde,folge,staffel,teil,offiziell,kostenlos,online,schauen,sehen,abonnieren,danke,gut,geht,machen,sagen').split(','));
const STOP_PT = new Set(('de,a,o,os,as,um,uma,uns,umas,que,em,e,é,são,se,seu,sua,seus,suas,ao,do,da,dos,das,com,por,para,como,mais,mas,este,esta,estes,estas,isso,esse,essa,aquele,aquela,eu,tu,ele,ela,nós,vós,eles,elas,meu,minha,meus,minhas,teu,tua,lhe,lhes,me,te,nos,vos,já,não,sim,também,muito,muita,muitos,muitas,pouco,pouca,estou,está,estamos,estão,era,eram,foi,foram,ser,tem,têm,tenho,pode,podem,fazer,diz,dizem,ano,anos,vez,vezes,hoje,ontem,amanhã,sempre,nunca,onde,quando,porque,até,desde,entre,sobre,sem,cada,outro,outra,outros,outras,mesmo,mesma,todos,todas,ninguém,alguém,algo,nada,quem,qual,quais,quanto,quanta,quantos,quantas,completo,completa,completos,completas,episódio,temporada,parte,oficial,grátis,assistir,ver,inscreva,inscrever,obrigado,obrigada,bom,boa').split(','));
// Generic words that are never a niche on their own (any language).
const GENERIC = new Set(('movie,movies,film,films,trailer,trailers,clip,clips,live,shorts,short,channel,free,download,online,review,reviews,unboxing,vlog,vlogs,remix,cover,lyrics,audio,show,shows,series,season,tv,episode,episodes,full,hd,hq,4k,1080p,720p,480p,official,best,new,top,watch,video,videos,complete,completed,pelicula,película,peliculas,películas,vidéo,vidéos,vídeo,vídeos,filme,filmes,video,vídeo').split(','));

function isStopword(t) {
  return STOP_EN.has(t) || STOP_KO.has(t) || STOP_ES.has(t) || STOP_FR.has(t) || STOP_DE.has(t) || STOP_PT.has(t) || GENERIC.has(t);
}

function tokenize(text) {
  if (!text) return [];
  // Accented Latin letters (\u00c0-\u00ff) stay inside tokens: "película" must
  // not split into "pel"+"cula" (that broke Spanish keyword extraction).
  return (text.toLowerCase().match(/[a-z0-9\u00c0-\u00ff]+|[\uac00-\ud7a3]+/g) || [])
    .map(stripKoParticle)
    .filter(t => t.length >= 2 && !isStopword(t) && !/^\d+$/.test(t));
}

// Light Korean particle stemmer: 경제를 / 경제는 / 경제의 → 경제, 월급은 → 월급.
// Without it, every particle form becomes a separate "keyword" and the base
// word's document frequency fragments. Only strips when the particle fits
// the preceding syllable (이/을/은/과/으로 after a consonant-final syllable,
// 가/를/는/와/로 after a vowel-final one); never strips to a 1-char result.
function koHasFinal(ch) {
  const code = ch.charCodeAt(0) - 0xAC00;
  return code >= 0 && code < 11172 && (code % 28) !== 0;
}
function stripKoParticle(t) {
  if (!/[\uac00-\ud7a3]/.test(t) || t.length < 3) return t;
  const multi = ['에서', '으로', '로서', '으로서', '로써', '에게', '한테', '부터', '까지', '처럼', '보다', '이랑', '하고'];
  for (const p of multi) {
    if (t.endsWith(p) && t.length - p.length >= 2) return t.slice(0, -p.length);
  }
  const last = t[t.length - 1];
  const prev = t[t.length - 2];
  const final = koHasFinal(prev);
  const one = final
    ? { '을': 1, '은': 1, '이': 1, '과': 1 }
    : { '를': 1, '는': 1, '가': 1, '와': 1, '로': 1 };
  if (one[last] && t.length - 1 >= 2) return t.slice(0, -1);
  if ('의에도만랑'.includes(last) && t.length - 1 >= 2) return t.slice(0, -1);
  return t;
}

// Language family of a text: 'ko' | 'es' | 'fr' | 'de' | 'pt' | 'en'.
// Used by the niche test: a candidate must share the seed's language family
// OR its YouTube category — a loose keyword match alone is not enough.
function detectLangFamily(text) {
  const t = (text || '').toLowerCase();
  const ko = (t.match(/[\uac00-\ud7a3]/g) || []).length;
  const latin = (t.match(/[a-z\u00c0-\u00ff]/g) || []).length;
  if (ko > latin * 0.5 && ko >= 3) return 'ko';
  const toks = t.match(/[a-z\u00c0-\u00ff]+/g) || [];
  const counts = { es: 0, fr: 0, de: 0, pt: 0 };
  const MARK = {
    es: new Set(['de', 'la', 'el', 'los', 'las', 'que', 'una', 'con', 'para', 'del', 'su', 'sus', 'por', 'es', 'son', 'como', 'pero', 'este', 'esta', 'película', 'cine', 'está']),
    fr: new Set(['le', 'les', 'des', 'une', 'est', 'dans', 'pour', 'qui', 'sur', 'pas', 'plus', 'ces', 'aux', 'avec', 'vous', 'nous', 'tout', 'tous', 'très']),
    de: new Set(['der', 'die', 'das', 'den', 'und', 'ist', 'sind', 'von', 'mit', 'für', 'auf', 'ein', 'eine', 'nicht', 'auch', 'noch', 'wie', 'haben', 'wird', 'werden']),
    pt: new Set(['que', 'uma', 'com', 'para', 'não', 'você', 'seus', 'suas', 'dos', 'das', 'como', 'mais', 'este', 'esta', 'filme', 'muito', 'são'])
  };
  if (/[ñ¿¡]/.test(t)) counts.es += 3;
  if (/[ãõç]/.test(t)) counts.pt += 3;
  if (/[àâçèéêëîïôûù]/.test(t)) counts.fr += 2;
  if (/[äöüß]/.test(t)) counts.de += 2;
  for (const tok of toks) for (const k of Object.keys(MARK)) if (MARK[k].has(tok)) counts[k]++;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (best[1] >= 3) return best[0];
  return 'en';
}
function topTokens(texts, limit) {
  const freq = new Map();
  for (const t of texts) for (const tok of tokenize(t)) freq.set(tok, (freq.get(tok) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(e => e[0]);
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
// Subscriber counts: null (hidden/unknown) renders as "—", never as 0.
function fmtSubs(n) { return n == null ? '—' : fmt(n); }

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
  if (!parsed) throw new Error('Enter a channel handle, URL or ID (e.g. @EconomyPuzzle).');
  let channelId = null;
  if (parsed.type === 'id') {
    channelId = parsed.value;
  } else if (parsed.type === 'handle') {
    const d = await yt('/channels', { part: 'id', forHandle: parsed.value }, key);
    addQuota(settings, ytCost('/channels'));
    if (d.items && d.items.length) channelId = d.items[0].id;
  }
  if (!channelId) {
    // Fallback: search by name/handle text (100 units) — cached per day,
    // so a retried seed never pays for the same lookup twice.
    const cacheKey = parsed.value.replace(/^@/, '');
    const cached = searchCacheGet('resolve', cacheKey);
    if (cached) {
      channelId = cached;
    } else {
      chargeSearch(settings);
      const d = await yt('/search', { part: 'snippet', type: 'channel', q: cacheKey, maxResults: 5 }, key);
      addQuota(settings, ytCost('/search'));
      const exact = (d.items || []).find(it =>
        (it.snippet.channelTitle || '').toLowerCase() === cacheKey.toLowerCase());
      channelId = (exact || (d.items || [])[0] || {}).channelId || (d.items && d.items[0] && d.items[0].snippet && d.items[0].snippet.channelId);
      if (channelId) searchCacheSet('resolve', cacheKey, channelId);
    }
    if (!channelId) throw new Error('Channel not found: ' + input);
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
  // Subscriber count: null when hidden or absent. YouTube OMITS
  // statistics.subscriberCount for channels that hide it (e.g.
  // @BedrockTimelapse — its public page shows no subscriber count), so
  // coercing to 0 made the UI print a wrong "0 subs". Null means unknown
  // and renders as "—" everywhere; it must never display as 0.
  const subs = (st.hiddenSubscriberCount || st.subscriberCount == null) ? null : +st.subscriberCount;
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
// Keyword rules (v1.3.0): length ≥ 3; never a stopword in ANY supported
// language (EN/KO/ES/FR/DE/PT) or a generic word; prefer tokens that appear in
// ≥2 seed videos/tags; fill only with tokens seen ≥2 times anywhere. A niche
// keyword must never be a stopword — the v1.2.0 chips ("que / de / se / con /
// el / es / la / una / por") were Spanish stopwords, which is why the
// ButacaSalvaje2 website map found zero neighbours.
function deriveNiche(seedChannel, seedVideos) {
  const docs = [];
  for (const v of seedVideos) docs.push(tokenize(v.title + ' ' + (v.tags || []).join(' ')));
  const descToks = tokenize(seedChannel.description || '');
  const titleToks = tokenize(seedChannel.title || '');
  // Document frequency: in how many seed videos does the token appear?
  const docCount = new Map();
  for (const toks of docs) {
    const seen = new Set(toks);
    for (const t of seen) docCount.set(t, (docCount.get(t) || 0) + 1);
  }
  const totalFreq = new Map();
  const bump = (toks) => { for (const t of toks) totalFreq.set(t, (totalFreq.get(t) || 0) + 1); };
  for (const toks of docs) bump(toks);
  bump(descToks); bump(titleToks);
  const cands = [...totalFreq.keys()].filter(t => t.length >= 3 || /[\uac00-\ud7a3]/.test(t));
  const byFreq = (a, b) => (totalFreq.get(b) - totalFreq.get(a)) || (docCount.get(b) || 0) - (docCount.get(a) || 0);
  // Strong keywords: in ≥2 seed videos/tags.
  let keywords = cands.filter(t => (docCount.get(t) || 0) >= 2).sort(byFreq).slice(0, 12);
  // Fill up to 5 only with tokens seen ≥2 times anywhere (never one-off words
  // like a watermark/app name from a single video title).
  if (keywords.length < 5) {
    const fillers = cands.filter(t => !keywords.includes(t) && (totalFreq.get(t) || 0) >= 2).sort(byFreq);
    keywords = keywords.concat(fillers).slice(0, 12);
  }
  if (keywords.length === 0) {
    // Fallback: seed's YouTube topic categories + description words.
    const catToks = tokenize((seedChannel.topicCategories || []).join(' ')).filter(t => t.length >= 3 || /[\uac00-\ud7a3]/.test(t));
    const descLong = descToks.filter(t => t.length >= 3 || /[\uac00-\ud7a3]/.test(t));
    keywords = [...new Set([...catToks, ...descLong])].slice(0, 12);
  }
  // Never build on an empty niche — the route turns this into a clear error.
  if (keywords.length === 0) throw new Error('Could not derive a niche — no usable keyword found in the seed channel videos or tags. Try a different seed channel.');
  const categories = seedChannel.topicCategories || [];
  const allText = seedVideos.map(v => v.title).join(' ') + ' ' + seedChannel.title + ' ' + (seedChannel.description || '');
  const family = detectLangFamily(allText);
  return { keywords, categories, korean: family === 'ko', language: family };
}

function nicheTest(candidate, candidateVideos, niche) {
  // Candidate must show the seed's niche in its OWN videos/tags/category:
  // ≥2 niche keywords AND (same language family OR same YouTube category).
  const texts = [candidate.title, candidate.description];
  for (const v of candidateVideos) { texts.push(v.title, (v.tags || []).join(' ')); }
  const joined = texts.join(' ');
  const toks = new Set(tokenize(joined));
  const hits = niche.keywords.filter(k => toks.has(k.toLowerCase()));
  const catHit = (candidate.topicCategories || []).some(c =>
    niche.categories.some(nc => c.toLowerCase().includes(nc.toLowerCase().split(' ')[0]) || nc.toLowerCase().includes(c.toLowerCase().split(' ')[0])));
  const candFamily = detectLangFamily(joined);
  const langOk = candFamily === niche.language;
  const pass = hits.length >= 2 && (langOk || catHit);
  return { pass, hits, catHit, langOk, candFamily };
}

// Search jobs for a niche: up to 6 keywords x (channel + video) = 12 calls
// per ring. Shared by discoverNeighbours and the search-quota guard, so the
// guard counts exactly what the ring will spend.
function searchJobsForNiche(niche) {
  const jobs = [];
  for (const q of (niche.keywords || []).slice(0, 6)) { jobs.push({ q, type: 'channel' }); jobs.push({ q, type: 'video' }); }
  return jobs;
}
function uncachedSearchCount(jobs) {
  let n = 0;
  for (const job of jobs) { if (searchCacheGet(job.type === 'channel' ? 'ch' : 'vid', job.q) === null) n++; }
  return n;
}

async function discoverNeighbours(niche, excludeIds, limit, key, settings) {
  const found = [];
  const seen = new Set(excludeIds);
  const diagnostics = { searchesRun: 0, searchesOk: 0, searchesFailed: 0, searchesCached: 0, candidatesFound: 0, vettedPassed: 0, firstSearchError: null, noQueries: false };
  // Build-scoped cache: a channel/video is never fetched twice in one build.
  const cache = { channels: new Map(), videos: new Map() };
  // Search each top niche keyword for channels + videos (keyword-anchored, never relatedToVideoId).
  // The 12 searches used to run one-by-one; they now run in a pool of 6.
  // The daily search cache serves repeats for free: ring 2 re-searches ring
  // 1's exact queries, so it costs 0 searches (same results — a live re-search
  // minutes later returns the same IDs anyway).
  const queries = (niche.keywords || []).slice(0, 6);
  if (!queries.length) {
    // No search was ever attempted — report that explicitly instead of
    // letting the caller guess "searches failed" (v1.3.0 misdiagnosed this).
    diagnostics.noQueries = true;
    return { neighbours: [], diagnostics };
  }
  const searchJobs = searchJobsForNiche(niche);
  const searchResults = await mapPool(searchJobs, async (job) => {
    const kind = job.type === 'channel' ? 'ch' : 'vid';
    const cached = searchCacheGet(kind, job.q);
    if (cached !== null) { diagnostics.searchesCached++; return cached; }
    diagnostics.searchesRun++;
    try {
      chargeSearch(settings);
      const d = await yt('/search', { part: 'snippet', type: job.type, q: job.q, maxResults: 10 }, key);
      addQuota(settings, ytCost('/search'));
      diagnostics.searchesOk++;
      const ids = (d.items || []).map(it => it.snippet.channelId).filter(Boolean);
      searchCacheSet(kind, job.q, ids);
      return ids;
    } catch (e) {
      diagnostics.searchesFailed++;
      // Keep the FIRST search error — it is the real reason the ring failed
      // (status + reason + message, never the key). One failed keyword must
      // not kill the build, but the reason must not be swallowed either.
      if (!diagnostics.firstSearchError) diagnostics.firstSearchError = { status: e.status || null, reason: e.reason || null, message: e.message || 'Search request failed', q: job.q, type: job.type };
      return [];
    }
  }, 6);
  const candidateIds = [];
  for (const ids of searchResults) {
    for (const id of ids) { if (!seen.has(id)) { seen.add(id); candidateIds.push(id); } }
    if (candidateIds.length >= limit * 2) break;
  }
  diagnostics.candidatesFound = candidateIds.length;
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
  diagnostics.vettedPassed = found.length;
  return { neighbours: found, diagnostics };
}

// ---------- helpers for routes ----------
function needKey(res) {
  const s = quotaResetIfNeeded(getSettings());
  if (!effectiveApiKey(s)) {
    // Single-key model: only the owner's key runs the site. Visitors are
    // never asked for a key — they get this friendly message instead.
    res.status(503).json({ ok: false, error: 'Service is being set up — please try again later.' });
    return null;
  }
  return s;
}
function findMap(id) {
  const maps = getMaps();
  const map = maps.find(m => m.id === id);
  return { maps, map };
}
// STALE-MAP FIX (v1.3.0): never save a maps array captured before a long
// await. The old expand route read maps.json, awaited discovery (tens of
// seconds), then saved its stale snapshot — any map created meanwhile was
// silently deleted from the file, so a refresh kept showing the old map.
// upsertMap re-reads the file immediately before writing, then replaces (or
// inserts) just this one map, so concurrent builds can never clobber each other.
function upsertMap(updated) {
  const maps = getMaps();
  const i = maps.findIndex(m => m.id === updated.id);
  if (i >= 0) maps[i] = updated; else maps.unshift(updated);
  saveMaps(maps);
  return maps;
}
function deleteMapById(id) {
  const maps = getMaps();
  saveMaps(maps.filter(m => m.id !== id));
}
function sortMapsNewest(maps) {
  return [...maps].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
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

// ---------- admin panel (separate page, direct URL only) ----------
// /admin serves the admin panel: allowlist + the site's one YouTube API
// key. It is NEVER linked from any public page — the admin opens it
// directly. The page itself only reveals its sections after an admin
// login (or the first-run setup form while no admin exists yet).
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---------- settings / API key ----------
app.get('/api/status', (req, res) => {
  const s = quotaResetIfNeeded(getSettings());
  const auth = getAuth(req);
  // Quota display: shared quota + the caller's own token balance.
  const tokens = auth.loggedIn ? tokenState(auth.email) : null;
  res.json({
    ok: true, hasKey: !!effectiveApiKey(s), quotaUsed: s.quotaUsed || 0, quotaLimit: QUOTA_LIMIT, quotaDate: s.quotaDate,
    quotaRemaining: QUOTA_LIMIT - (s.quotaUsed || 0),
    searchUsed: s.searchUsed || 0, searchLimit: SEARCH_LIMIT,
    searchRemaining: SEARCH_LIMIT - (s.searchUsed || 0),
    searchBlocked: isSearchBlockedToday(),
    me: { loggedIn: auth.loggedIn, email: auth.email, role: auth.role, allowed: auth.allowed },
    tokens
  });
});

// Diagnostics: key/quota state + the last YouTube errors (status/reason/
// message + endpoint + time) + per-map build state. No secrets ever —
// no key, no URLs, no request bodies. Use this first when a build fails.
app.get('/api/diag', (req, res) => {
  const s = quotaResetIfNeeded(getSettings());
  const maps = sortMapsNewest(getMaps()).map(m => ({
    id: m.id, seedTitle: m.seedTitle, status: m.status, builtDepth: m.builtDepth,
    channelCount: m.channels.length, nicheKeywords: m.nicheKeywords || [],
    stall: m.stall || null, createdAt: m.createdAt
  }));
  res.json({
    ok: true, hasKey: !!effectiveApiKey(s), quotaUsed: s.quotaUsed || 0, quotaLimit: QUOTA_LIMIT, quotaDate: s.quotaDate,
    searchUsed: s.searchUsed || 0, searchLimit: SEARCH_LIMIT,
    searchBlocked: isSearchBlockedToday(),
    lastYtError: lastYtErrors[0] || null, recentYtErrors: lastYtErrors, maps
  });
});

app.post('/api/settings/key', async (req, res) => {
  // Single-key model: only the admin sets the site's one YouTube API key.
  if (!requireAdmin(req, res)) return;
  const key = (req.body && req.body.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'Key is empty.' });
  // Validate with one cheap 1-unit call.
  try {
    await yt('/channels', { part: 'id', id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' }, key);
  } catch (e) {
    if (e.isInvalidKey) return res.status(400).json({ ok: false, error: 'API key not valid — Google rejected the key. Please check the key and try again.' });
    return res.status(400).json({ ok: false, error: 'Key check failed: ' + e.message });
  }
  const s = quotaResetIfNeeded(getSettings());
  s.apiKey = key;
  saveSettings(s);
  // A new key usually means a different project — its search quota is
  // fresh, so a block recorded against the old key must not linger (v1.3.2).
  clearSearchBlocked();
  res.json({ ok: true, message: 'API key saved.' });
});

app.delete('/api/settings/key', (req, res) => {
  if (!requireAdmin(req, res)) return;
  // Clears only the saved key — a YOUTUBE_API_KEY env var (v1.3.4) still
  // applies afterwards, so hasKey may stay true.
  const s = getSettings();
  s.apiKey = '';
  saveSettings(s);
  res.json({ ok: true });
});

// ---------- maps ----------
app.get('/api/maps', (req, res) => {
  // Always newest first (by createdAt, not file order) — the frontend shows
  // maps[0] by default, so this ordering IS which map the user sees on load.
  const maps = sortMapsNewest(getMaps()).map(m => ({
    id: m.id, seedTitle: m.seedTitle, seedChannelId: m.seedChannelId,
    seedThumbnail: m.seedThumbnail, depth: m.depth, builtDepth: m.builtDepth,
    status: m.status, channelCount: m.channels.length, quotaUsed: m.quotaUsed || 0,
    nicheKeywords: m.nicheKeywords || [], createdAt: m.createdAt,
    stall: m.stall || null
  }));
  res.json({ ok: true, maps });
});

// Clear ALL maps (map switcher's "Clear all"). Defined before /:id routes.
app.delete('/api/maps', (req, res) => {
  saveMaps([]);
  res.json({ ok: true });
});

app.get('/api/maps/:id', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
  res.json({ ok: true, map });
});

app.delete('/api/maps/:id', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
  deleteMapById(map.id);
  res.json({ ok: true });
});

// Create map: resolve seed, derive niche, return seed IMMEDIATELY (fast first result).
app.post('/api/maps', async (req, res) => {
  const settings = needKey(res);
  if (!settings) return;
  const input = (req.body && req.body.input || '').trim();
  const depth = [1, 2, 4].includes(+req.body.depth) ? +req.body.depth : 2;
  if (!input) return res.status(400).json({ ok: false, error: 'Enter a channel handle, URL or ID.' });
  // Token + quota protection: only logged-in users may start a build, with
  // enough tokens for the depth, and only if the shared quota can cover it.
  // The allowlist does NOT gate building.
  const auth = requireLogin(req, res);
  if (!auth) return;
  const cost = TOKEN_COST[depth];
  const tokenErr = checkTokens(auth.email, cost);
  if (tokenErr) return res.status(402).json({ ok: false, error: tokenErr, needTokens: true, cost });
  const guardErr = quotaGuardError(settings, estimateForDepth(depth));
  if (guardErr) return res.status(503).json({ ok: false, error: guardErr });
  // Search guard: the build needs at least one search call (seed resolution
  // + the first ring). Never charge tokens for a build the search quota
  // cannot cover.
  const searchErr = searchGuardError(settings, 1);
  if (searchErr) return res.status(503).json({ ok: false, error: searchErr });
  // Track the charge (v1.3.2): if anything fails AFTER the tokens were
  // spent, the catch refunds them and removes the half-built map.
  let charged = null;
  let createdMapId = null;
  try {
    const channelId = await resolveChannel(input, effectiveApiKey(settings), settings);
    const details = await fetchChannelDetails([channelId], effectiveApiKey(settings), settings);
    if (!details.length) return res.status(404).json({ ok: false, error: 'Channel not found.' });
    const item = details[0];
    const seedVideos = await fetchChannelVideos(channelId, (item.contentDetails.relatedPlaylists || {}).uploads, effectiveApiKey(settings), settings, 20);
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
      channels: [Object.assign(seed, { depth: 0 })],
      // Who paid (v1.3.2): a later stall refunds exactly this spend.
      paidBy: auth.email, paidFree: 0, paidPaid: 0, refunded: false
    };
    upsertMap(map);
    createdMapId = map.id;
    // Charge only after the seed resolved — a failed seed never costs tokens.
    // (Race safety: if the charge fails, the just-created map is removed.)
    const spent = spendTokens(auth.email, cost);
    if (!spent.ok) {
      deleteMapById(map.id);
      flushSettings(settings);
      return res.status(402).json({ ok: false, error: spent.error, needTokens: true, cost });
    }
    // Remember what was spent, so a later stall can refund exactly this.
    map.paidFree = spent.freeTaken;
    map.paidPaid = spent.paidTaken;
    upsertMap(map);
    charged = { email: auth.email, freeTaken: spent.freeTaken, paidTaken: spent.paidTaken };
    flushSettings(settings);
    res.json({ ok: true, map, message: 'Seed found — building the rings now.', tokens: { balance: spent.balance, spent: spent.spent, unlimited: !!spent.unlimited } });
  } catch (e) {
    if (charged) {
      refundTokens(charged.email, charged.freeTaken, charged.paidTaken);
      if (createdMapId) deleteMapById(createdMapId);
      return res.status(400).json({ ok: false, error: (e.message || 'Failed to create the map.') + ' Your tokens were refunded.', refunded: true });
    }
    res.status(e.status === 403 ? 403 : 400).json({ ok: false, error: e.message || 'Failed to create the map.' });
  }
});

// Expand ONE ring per request (progressive build — no single long request).
app.post('/api/maps/:id/expand', async (req, res) => {
  const settings = needKey(res);
  if (!settings) return;
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
  if (map.status === 'stalled') map.status = 'building'; // retrying a stalled ring
  const target = nextRingTarget(map);
  if (target === null) {
    map.status = 'complete';
    upsertMap(map);
    return res.json({ ok: true, map, done: true, message: 'Map is complete.' });
  }
  // Quota protection: continuing a build also needs a logged-in user, and
  // enough shared quota left for one more ring. Expanding is part of the
  // build already paid for at creation, so it costs no extra tokens.
  const expandAuth = requireLogin(req, res);
  if (!expandAuth) return;
  const ringGuardErr = quotaGuardError(settings, estimateForRing());
  if (ringGuardErr) return res.status(503).json({ ok: false, error: ringGuardErr });
  try {
    const ringDepth = map.builtDepth + 1;
    // A stored map with no niche keywords can never discover neighbours —
    // say so plainly instead of running zero searches and blaming YouTube.
    if (!map.nicheKeywords || !map.nicheKeywords.length) {
      map.status = 'stalled';
      map.stall = { ring: ringDepth, reason: 'This map has no niche keywords, so no search could run.', keywords: [], candidatesFound: 0, vettedPassed: 0, searchesOk: 0, searchesFailed: 0, quotaUsed: settings.quotaUsed || 0, at: new Date().toISOString() };
      const wasRefunded = refundMapOnce(map); // v1.3.2: a stalled build is refunded (also persists the map)
      return res.status(400).json({ ok: false, error: 'This map has no niche keywords, so no search could run. Please build a new map from a seed channel.' + (wasRefunded ? ' Your tokens for this build were refunded.' : ''), refunded: wasRefunded, diagnostics: { searchesRun: 0, searchesOk: 0, searchesFailed: 0, noQueries: true } });
    }
    const exclude = map.channels.map(c => c.id);
    const limit = target - map.channels.length;
    // Search guard: only the ring's UNCACHED searches count — a retried ring
    // whose queries are in the daily cache needs 0 new searches. If the
    // quota cannot cover them, stop here (map stays 'building', retryable
    // tomorrow) instead of stalling on a doomed ring.
    const ringSearchErr = searchGuardError(settings, uncachedSearchCount(searchJobsForNiche(map.niche)));
    if (ringSearchErr) {
      // The build cannot continue today — refund the original charge
      // (v1.3.2). The map stays retryable: its searches are cached, so a
      // retry tomorrow costs ~0 new searches.
      const wasRefunded = refundMapOnce(map);
      return res.status(503).json({ ok: false, error: ringSearchErr + (wasRefunded ? ' Your tokens for this build were refunded.' : ''), refunded: wasRefunded });
    }
    const { neighbours, diagnostics } = await discoverNeighbours(map.niche, exclude, Math.max(limit, 0), effectiveApiKey(settings), settings);
    // TOTAL search failure: never silently save a seed-only ring as
    // progress — park the map as 'stalled' WITH the real YouTube reason
    // (status + reason + message) and return it, so the UI can show what
    // actually happened instead of guessing "quota may be exhausted".
    // (Cached searches count as successful searches — a ring served fully
    // from the cache has searchesOk 0 but is not a failure.)
    if (diagnostics.searchesOk + (diagnostics.searchesCached || 0) === 0 && neighbours.length === 0) {
      const ytErr = diagnostics.firstSearchError || null;
      const human = diagnostics.noQueries
        ? 'No search ran for this ring — the niche keywords are empty.'
        : ytErr
          ? `YouTube search failed (${ytErr.status || ''} ${ytErr.reason || ''}): ${ytErr.message}${quotaExceededHint(ytErr)}`
          : 'YouTube searches failed for this ring.';
      map.status = 'stalled';
      map.stall = {
        ring: ringDepth,
        reason: human,
        yt: ytErr,
        keywords: map.nicheKeywords || [],
        candidatesFound: diagnostics.candidatesFound,
        vettedPassed: diagnostics.vettedPassed,
        searchesOk: diagnostics.searchesOk,
        searchesFailed: diagnostics.searchesFailed,
        searchesCached: diagnostics.searchesCached || 0,
        quotaUsed: settings.quotaUsed || 0,
        at: new Date().toISOString()
      };
      const wasRefunded = refundMapOnce(map); // v1.3.2: a stalled build is refunded (also persists the map)
      flushSettings(settings);
      return res.status(400).json({
        ok: false,
        error: human + ' Check the quota, then press "Continue building" to retry.' + (wasRefunded ? ' Your tokens for this build were refunded.' : ''),
        yt: ytErr,
        refunded: wasRefunded,
        diagnostics
      });
    }
    if (neighbours.length === 0) {
      // ZERO-NEIGHBOUR STATE: do not advance the ring and do not mark the
      // map complete. Park the map as 'stalled' with the reason, so the UI
      // can show it and offer "Try again" instead of a silent seed-only map.
      map.status = 'stalled';
      map.stall = {
        ring: ringDepth,
        reason: 'No neighbours found in this ring.',
        keywords: map.nicheKeywords || [],
        candidatesFound: diagnostics.candidatesFound,
        vettedPassed: diagnostics.vettedPassed,
        searchesOk: diagnostics.searchesOk,
        searchesFailed: diagnostics.searchesFailed,
        searchesCached: diagnostics.searchesCached || 0,
        quotaUsed: settings.quotaUsed || 0,
        at: new Date().toISOString()
      };
      const wasRefunded = refundMapOnce(map); // v1.3.2: a stalled build is refunded (also persists the map)
      flushSettings(settings);
      return res.json({
        ok: true, map, done: false, stalled: true, diagnostics, refunded: wasRefunded,
        message: `Depth ${ringDepth}: 0 neighbours found — niche keywords (${(map.nicheKeywords || []).join(', ')}) matched ${diagnostics.candidatesFound} candidates, ${diagnostics.vettedPassed} passed the niche test.` + (wasRefunded ? ' Your tokens for this build were refunded.' : '')
      });
    }
    for (const n of neighbours) { n.depth = ringDepth; map.channels.push(n); }
    map.builtDepth = ringDepth;
    map.status = nextRingTarget(map) === null ? 'complete' : 'building';
    map.quotaUsed = (map.quotaUsed || 0);
    delete map.stall; // a successful ring clears any earlier stall
    upsertMap(map);
    flushSettings(settings);
    res.json({
      ok: true, map, done: map.status === 'complete', diagnostics,
      message: `Depth ${ringDepth} of ${map.depth} ready — ${map.channels.length} channels.`
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Failed to build this ring.' });
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
  // Breakout guard (v1.3.0): a video counts as a breakout only when its
  // channel's median is ≥ 100 views. With a near-zero median (e.g. 21) the
  // multiple explodes (173,759 / 21 ≈ 8274×) and means nothing.
  const breakoutOk = (ch.medianViews || 0) >= 100;
  const videoRow = v => ({
    id: v.id, title: v.title, views: v.views,
    multipleVsMedian: +(v.views / med).toFixed(1),
    publishedAt: v.publishedAt, duration: fmtDuration(v.durationSec || 0)
  });
  return {
    channel: {
      id: ch.id, title: ch.title, customUrl: ch.customUrl || '', country: ch.country || '',
      publishedAt: ch.publishedAt, subs: ch.subs, totalViews: ch.totalViews,
      videoCount: ch.videoCount, medianViews: ch.medianViews, meanViews: ch.meanViews,
      viewsPerDay: ch.viewsPerDay, thumbnail: ch.thumbnail,
      topicCategories: ch.topicCategories || []
    },
    postingCadence: coreEngine(ch).postingCadence,
    topVideos: vids.slice(0, 10).map(videoRow),
    // Full loaded-videos list (views desc) for the detail panel: every video
    // with its outlier multiple, published date and views. The JSON download
    // carries the same list, so a clicked channel is fully replicable.
    videos: vids.map(v => Object.assign(videoRow(v), { thumbnail: v.thumbnail })),
    breakoutVideos: breakoutOk ? vids.filter(v => v.views >= med * 3).slice(0, 10).map(v => ({
      id: v.id, title: v.title, views: v.views,
      multipleVsMedian: +(v.views / med).toFixed(1), publishedAt: v.publishedAt
    })) : [],
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
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
  const ch = map.channels.find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ ok: false, error: 'Channel is not in this map.' });
  res.json({ ok: true, breakdown: channelBreakdown(ch) });
});

app.get('/api/maps/:id/channels/:channelId/json', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
  const ch = map.channels.find(c => c.id === req.params.channelId);
  if (!ch) return res.status(404).json({ ok: false, error: 'Channel is not in this map.' });
  const data = Object.assign({ exportedAt: new Date().toISOString(), mapSeed: map.seedTitle, nicheKeywords: map.nicheKeywords }, channelBreakdown(ch));
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="channelscope-${ch.title.replace(/[^\w\-]+/g, '_')}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// ---------- breakouts ----------
// Breakouts come ONLY from the currently selected map (the :id in the URL),
// and only from channels whose median is ≥ 100 views — see channelBreakdown.
app.get('/api/maps/:id/breakouts', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
  const min = parseFloat(req.query.min || '3') || 3;
  const rows = [];
  let excludedLowMedian = 0;
  for (const ch of map.channels) {
    const med = ch.medianViews || 0;
    if (med < 100) { if (med > 0) excludedLowMedian++; continue; }
    for (const v of ch.videos) {
      const mult = v.views / med;
      if (mult >= min) rows.push({
        videoId: v.id, title: v.title, views: v.views, multiple: +mult.toFixed(1),
        publishedAt: v.publishedAt, duration: fmtDuration(v.durationSec || 0),
        thumbnail: v.thumbnail, channelId: ch.id, channelTitle: ch.title,
        channelThumbnail: ch.thumbnail, channelSubs: ch.subs, channelMedian: med
      });
    }
  }
  rows.sort((a, b) => b.multiple - a.multiple);
  res.json({ ok: true, min, count: rows.length, mapSeed: map.seedTitle, excludedLowMedian, breakouts: rows });
});

// ---------- topics (data-driven, no LLM key) ----------
app.get('/api/maps/:id/topics', (req, res) => {
  const { map } = findMap(req.params.id);
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
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
  h += `<p><b>${escHtml(seed.title)}</b> is ${ageLabel(channelAgeDays(seed))} with ${fmt(seed.videoCount || vids.length)} videos (${vids.length} loaded here), ${fmtSubs(seed.subs)} subscribers.</p>`;
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
      h += `<div class="an-channel"><b>${escHtml(c.title)}</b> — ${fmtSubs(c.subs)} subs · ${ageLabel(channelAgeDays(c))} · ${verdict.good ? 'Good model' : 'Poor model'}<br><span class="muted">${escHtml(verdict.note)}</span>`;
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
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
  const q = (req.body && req.body.question || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'Please type a question.' });
  // Makina-style analysis: structured report from stored map data (no LLM).
  if (isAnalysisIntent(q)) {
    const html = buildAnalysis(map);
    if (!html) return res.status(400).json({ ok: false, error: 'No channel data in this map.' });
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
    ? `From your map data (${map.channels.length} channels): "${q}" matched ${chanHits.length} channel(s) and ${vidHits.length} video(s) — ranked by breakout multiple below.`
    : `Nothing in your map matched "${q}". Your map has ${map.channels.length} channels — try another word, or build the map to depth 2 first.`;
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
  if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
  let video = null, owner = null;
  for (const c of map.channels) {
    const v = c.videos.find(v => v.id === req.params.videoId);
    if (v) { video = v; owner = c; break; }
  }
  if (!video) return res.status(404).json({ ok: false, error: 'Video is not in this map.' });
  try {
    // Fresh metadata from YouTube (description chapters + duration).
    let meta = null;
    try {
      const d = await yt('/videos', { part: 'snippet,contentDetails,statistics', id: video.id }, effectiveApiKey(settings));
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
    res.status(400).json({ ok: false, error: e.message || 'Failed to generate the script.' });
  }
});

// ---------- Trending 24h (NEW channels trending in the last 24 hours) ----------
// DAILY CACHE: one niche's list is computed once per day, then served from
// cache (quota saving — no re-search on every click). Cache file:
// data/trending.json (gitignored like the other data files).
const TRENDING_FILE = path.join(DATA_DIR, 'trending.json');
function getTrendingCache() { return loadJson(TRENDING_FILE, { runs: {} }).runs; }
function saveTrendingCache(runs) { saveJson(TRENDING_FILE, { runs }); }
const TRENDING_MIN_MEDIAN = 100; // same guard as breakouts: no numeric outlier below this
const TRENDING_SEARCH_KEYWORDS = 3; // searches cost 100 units each — bound the run
const TRENDING_PAGE_NOTE = 'Criteria signal: 1,000+ subscribers and 100,000+ views on the trending video — watch hours cannot be verified via the YouTube Data API, so this is the signal used.';

async function runTrending(keywords, key, settings) {
  // Quota accounting for this run (search = 100 units, everything else = 1).
  let runQuota = 0;
  const charge = (endpoint, n) => { runQuota += ytCost(endpoint) * (n || 1); };
  const publishedAfter = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  // 1) Last-24h videos for the niche keywords (order=date → newest first).
  const searchJobs = keywords.slice(0, TRENDING_SEARCH_KEYWORDS).map(q => ({ q }));
  let firstSearchError = null;
  const searchResults = await mapPool(searchJobs, async (job) => {
    // Daily search cache: the same keyword's last-24h list is never paid for
    // twice in one day (the trending result itself is cached daily per niche
    // anyway, so a cached search is never stale within its useful life).
    const cached = searchCacheGet('trend', job.q);
    if (cached !== null) return cached;
    try {
      chargeSearch(settings);
      const d = await yt('/search', { part: 'snippet', type: 'video', q: job.q, publishedAfter, order: 'date', maxResults: 25 }, key);
      addQuota(settings, ytCost('/search')); charge('/search');
      const vids = (d.items || []).map(it => ({
        id: (it.id || {}).videoId, title: it.snippet.title,
        channelId: it.snippet.channelId, channelTitle: it.snippet.channelTitle,
        publishedAt: it.snippet.publishedAt,
        thumbnail: (it.snippet.thumbnails && it.snippet.thumbnails.medium && it.snippet.thumbnails.medium.url) || ''
      })).filter(v => v.id);
      searchCacheSet('trend', job.q, vids);
      return vids;
    } catch (e) {
      // Keep the FIRST search error — the run's caller reports it instead
      // of silently returning an empty list (v1.3.0 swallowed it).
      if (!firstSearchError) firstSearchError = { status: e.status || null, reason: e.reason || null, message: e.message || 'Search request failed', q: job.q };
      return [];
    }
  }, TRENDING_SEARCH_KEYWORDS);
  const byVideo = new Map();
  for (const list of searchResults) for (const v of list) if (!byVideo.has(v.id)) byVideo.set(v.id, v);
  const videos24h = [...byVideo.values()];
  if (!videos24h.length) return { channels: [], quotaUsed: runQuota, searchedVideos: 0, searchError: firstSearchError };
  // 2) View counts for the 24h videos (search results carry no statistics).
  const vChunks = [];
  for (let i = 0; i < videos24h.length; i += 50) vChunks.push(videos24h.slice(i, i + 50));
  const viewResults = await mapPool(vChunks, async (chunk) => {
    try {
      const d = await yt('/videos', { part: 'statistics,contentDetails', id: chunk.map(v => v.id).join(',') }, key);
      addQuota(settings, ytCost('/videos')); charge('/videos');
      return d.items || [];
    } catch (e) { return []; }
  }, 2);
  const viewsById = new Map();
  for (const items of viewResults) for (const it of (items || [])) {
    viewsById.set(it.id, { views: +(it.statistics.viewCount || 0), durationSec: parseDuration(it.contentDetails && it.contentDetails.duration) });
  }
  for (const v of videos24h) {
    const s = viewsById.get(v.id) || { views: 0, durationSec: 0 };
    v.views = s.views; v.durationSec = s.durationSec;
  }
  // 3) Group by channel; keep channels with a 24h video.
  const byChannel = new Map();
  for (const v of videos24h) {
    if (!byChannel.has(v.channelId)) byChannel.set(v.channelId, []);
    byChannel.get(v.channelId).push(v);
  }
  const channelIds = [...byChannel.keys()].slice(0, 40);
  const details = await fetchChannelDetails(channelIds, key, settings);
  const out = [];
  for (const item of details) {
    const sn = item.snippet || {};
    const st = item.statistics || {};
    const subs = +(st.subscriberCount || 0);
    const ageDays = sn.publishedAt ? Math.max(1, Math.round((Date.now() - new Date(sn.publishedAt).getTime()) / 86400000)) : 0;
    // Filter: channel 30–60 days old AND ≥ 1000 subscribers (monetization
    // subs threshold, verified via API). A hidden/unknown subscriber count
    // (subs === 0) cannot prove the threshold, so it does NOT pass.
    if (ageDays < 30 || ageDays > 60 || !(subs >= 1000)) continue;
    const uploads = (item.contentDetails && item.contentDetails.relatedPlaylists && item.contentDetails.relatedPlaylists.uploads) || '';
    let recent = [];
    try { if (uploads) recent = await fetchChannelVideos(item.id, uploads, key, settings, 20); } catch (e) { /* ignore */ }
    const med = median(recent.map(v => v.views));
    const vids24 = (byChannel.get(item.id) || [])
      .sort((a, b) => b.views - a.views)
      .slice(0, 3)
      .map(v => ({
        id: v.id, title: v.title, views: v.views,
        multiple: med >= TRENDING_MIN_MEDIAN ? +(v.views / med).toFixed(1) : null,
        publishedAt: v.publishedAt, duration: fmtDuration(v.durationSec || 0), thumbnail: v.thumbnail
      }));
    if (!vids24.length) continue;
    // CRITERIA SIGNAL (locked): the qualifying 24h video must ALSO have
    // ≥ 100,000 views (lakhs mein). Logic: jis channel ke views lakhs mein
    // hain, uske watch hours bhi poore honge — watch hours themselves are
    // NOT verifiable via the YouTube Data API, so this is the signal.
    // A channel that passes subs but not views does NOT enter the list.
    if (vids24[0].views < 100000) continue;
    const best = vids24[0];
    out.push({
      channelId: item.id,
      title: sn.title || '',
      thumbnail: (sn.thumbnails && (sn.thumbnails.high || sn.thumbnails.medium || sn.thumbnails.default) || {}).url || '',
      subs, ageDays, channelPublishedAt: sn.publishedAt || '',
      medianViews: med,
      bestMultiple: best.multiple, bestViews: best.views,
      videos: vids24
    });
  }
  out.sort((a, b) => (b.bestMultiple || -1) - (a.bestMultiple || -1) || b.bestViews - a.bestViews);
  return { channels: out, quotaUsed: runQuota, searchedVideos: videos24h.length, searchError: firstSearchError };
}

app.get('/api/trending', async (req, res) => {
  // Guests NEVER trigger a fresh scan — they only get the cached run,
  // server-side masked. A fresh run needs login + 50 tokens (the allowlist
  // does NOT gate it, but non-allowed users still only SEE masked data).
  const auth = getAuth(req);
  let keywords = [];
  let nicheLabel = '';
  const typed = (req.query.niche || '').trim();
  if (typed) {
    keywords = tokenize(typed).filter(t => t.length >= 3);
    nicheLabel = typed;
  } else if (req.query.mapId) {
    const { map } = findMap(req.query.mapId);
    if (!map) return res.status(404).json({ ok: false, error: 'Map not found.' });
    keywords = (map.nicheKeywords || []).slice();
    nicheLabel = map.seedTitle + ' (map niche)';
  } else {
    return res.status(400).json({ ok: false, error: 'Build a map first or type a niche — which niche should trending cover?' });
  }
  if (!keywords.length) return res.status(400).json({ ok: false, error: 'No usable keyword came from this niche — please type a different niche.' });
  const cacheKey = [...keywords].sort().join(',');
  const today = todayStr();
  const runs = getTrendingCache();
  const hit = runs[cacheKey];
  const canSee = auth.allowed;
  const note = canSee ? TRENDING_PAGE_NOTE : ACCESS_NOTE;
  if (!auth.loggedIn) {
    if (hit) {
      return res.json({ ok: true, allowed: false, cached: true, niche: nicheLabel, keywords, asOf: hit.asOf, quotaUsed: hit.quotaUsed, count: hit.channels.length, channels: hit.channels.map(maskTrendingChannel), note: ACCESS_NOTE });
    }
    return res.json({ ok: true, allowed: false, cached: false, niche: nicheLabel, keywords, asOf: new Date().toISOString(), quotaUsed: 0, count: 0, channels: [], note: ACCESS_NOTE + ' No cached trending data for this niche yet.' });
  }
  if (hit && hit.date === today && req.query.refresh !== '1') {
    return res.json({ ok: true, allowed: canSee, cached: true, niche: nicheLabel, keywords, asOf: hit.asOf, quotaUsed: hit.quotaUsed, count: hit.channels.length, channels: canSee ? hit.channels : hit.channels.map(maskTrendingChannel), note });
  }
  const settings = needKey(res);
  if (!settings) return;
  // Track the charge (v1.3.2): the run is charged only after it succeeds,
  // but if saving the run or answering fails afterwards, refund it.
  let trendCharged = null;
  try {
    // A FRESH trending run needs enough tokens (50) and enough shared quota.
    const trendCost = TOKEN_COST.trending;
    const trendTokenErr = checkTokens(auth.email, trendCost);
    if (trendTokenErr) return res.status(402).json({ ok: false, error: trendTokenErr, needTokens: true, cost: trendCost });
    const trendGuardErr = quotaGuardError(settings, estimateForTrending());
    if (trendGuardErr) return res.status(503).json({ ok: false, error: trendGuardErr });
    // Search guard: only the run's UNCACHED keyword searches count.
    let trendNeeded = 0;
    for (const q of keywords.slice(0, TRENDING_SEARCH_KEYWORDS)) { if (searchCacheGet('trend', q) === null) trendNeeded++; }
    const trendSearchErr = searchGuardError(settings, trendNeeded);
    if (trendSearchErr) return res.status(503).json({ ok: false, error: trendSearchErr });
    const run = await runTrending(keywords, effectiveApiKey(settings), settings);
    // If the run found nothing AND the searches themselves failed, say so
    // with the real YouTube reason — an empty list must not hide the error.
    if (!run.channels.length && run.searchError) {
      return res.status(400).json({
        ok: false,
        error: `YouTube search failed (${run.searchError.status || ''} ${run.searchError.reason || ''}): ${run.searchError.message}${quotaExceededHint(run.searchError)}`,
        yt: run.searchError,
        quotaUsed: run.quotaUsed
      });
    }
    // Charge after the run succeeded; if the charge fails, do not cache the
    // run (the user keeps their tokens and can retry).
    const spent = spendTokens(auth.email, trendCost);
    if (!spent.ok) return res.status(402).json({ ok: false, error: spent.error, needTokens: true, cost: trendCost });
    trendCharged = { email: auth.email, freeTaken: spent.freeTaken, paidTaken: spent.paidTaken };
    const record = { niche: nicheLabel, keywords, language: detectLangFamily(keywords.join(' ')), date: today, asOf: new Date().toISOString(), quotaUsed: run.quotaUsed, channels: run.channels };
    runs[cacheKey] = record;
    saveTrendingCache(runs);
    flushSettings(settings);
    res.json({ ok: true, allowed: canSee, cached: false, niche: nicheLabel, keywords, asOf: record.asOf, quotaUsed: run.quotaUsed, count: run.channels.length, channels: canSee ? run.channels : run.channels.map(maskTrendingChannel), note, tokens: { balance: spent.balance, spent: spent.spent, unlimited: !!spent.unlimited } });
  } catch (e) {
    if (trendCharged) {
      refundTokens(trendCharged.email, trendCharged.freeTaken, trendCharged.paidTaken);
      return res.status(400).json({ ok: false, error: (e.message || 'Failed to load trending data.') + ' Your tokens were refunded.', refunded: true });
    }
    res.status(400).json({ ok: false, error: e.message || 'Failed to load trending data.' });
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
    if (med >= 100) breakouts += c.videos.filter(v => v.views >= med * 3).length;
  }
  const s = quotaResetIfNeeded(getSettings());
  res.json({
    ok: true, results: {
      maps: maps.length, channels, videos, breakouts,
      quotaUsed: s.quotaUsed || 0, quotaLimit: QUOTA_LIMIT
    }
  });
});

// ---------- auth routes ----------
app.get('/api/auth/me', (req, res) => {
  const auth = getAuth(req);
  const store = getUsers();
  res.json({ ok: true, loggedIn: auth.loggedIn, email: auth.email, role: auth.role, allowed: auth.allowed, setupNeeded: !store.users.some(u => u.role === 'admin') });
});
app.post('/api/auth/setup', (req, res) => {
  // First-run admin creation — allowed while NO admin exists yet (not just
  // while zero users exist: a normal user may have registered first, and
  // that must not lock the owner out of the admin panel forever).
  const store = getUsers();
  if (store.users.some(u => u.role === 'admin')) return res.status(403).json({ ok: false, error: 'An admin account already exists.' });
  const email = normEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  const existing = store.users.find(u => u.email === email);
  if (existing) {
    // Same email already registered as a normal user — promote it to admin
    // instead of creating a duplicate (login finds the first match).
    existing.role = 'admin';
    existing.password = hashPassword(password);
  } else {
    store.users.push({ email, password: hashPassword(password), role: 'admin', createdAt: new Date().toISOString() });
  }
  saveUsers(store);
  setSessionCookie(res, email);
  res.json({ ok: true, email, role: 'admin', allowed: true });
});
app.post('/api/auth/register', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
  const store = getUsers();
  if (store.users.some(u => u.email === email)) return res.status(409).json({ ok: false, error: 'An account with this email already exists — please log in.' });
  store.users.push({ email, password: hashPassword(password), role: 'user', createdAt: new Date().toISOString() });
  saveUsers(store);
  setSessionCookie(res, email);
  res.json({ ok: true, email, role: 'user', allowed: store.allowlist.includes(email) });
});
app.post('/api/auth/login', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || '');
  const store = getUsers();
  const user = store.users.find(u => u.email === email);
  if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ ok: false, error: 'Email or password is incorrect.' });
  setSessionCookie(res, email);
  res.json({ ok: true, email, role: user.role, allowed: user.role === 'admin' || store.allowlist.includes(email) });
});
app.post('/api/auth/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
function requireAdmin(req, res) {
  const auth = getAuth(req);
  if (!auth.loggedIn || auth.role !== 'admin') { res.status(403).json({ ok: false, error: 'Only an admin can do this.' }); return null; }
  return auth;
}
app.get('/api/auth/admin/allowlist', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, allowlist: getUsers().allowlist });
});
app.post('/api/auth/admin/allowlist', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const email = normEmail(req.body && req.body.email);
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  const store = getUsers();
  if (!store.allowlist.includes(email)) { store.allowlist.push(email); saveUsers(store); }
  res.json({ ok: true, allowlist: store.allowlist });
});
app.delete('/api/auth/admin/allowlist/:email', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const email = normEmail(decodeURIComponent(req.params.email));
  const store = getUsers();
  store.allowlist = store.allowlist.filter(e => e !== email);
  saveUsers(store);
  res.json({ ok: true, allowlist: store.allowlist });
});

// Admin: token management — list users with plan + balance, grant paid
// tokens manually (support / goodwill), and assign a plan manually (e.g.
// give the site owner a Pro plan without going through Stripe).
app.get('/api/auth/admin/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const store = getUsers();
  const today = todayStr();
  res.json({
    ok: true,
    users: store.users.map(u => ({
      email: u.email, role: u.role, createdAt: u.createdAt || null,
      ...tokenStateFor(u, today),
      stripeCustomerId: u.stripeCustomerId || null,
      stripeSubscriptionId: u.stripeSubscriptionId || null
    }))
  });
});
app.post('/api/auth/admin/grant', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const email = normEmail(req.body && req.body.email);
  const amount = Math.floor(+((req.body && req.body.tokens) || 0));
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  if (!(amount > 0)) return res.status(400).json({ ok: false, error: 'Enter a token amount greater than 0.' });
  const store = getUsers();
  const user = store.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });
  user.paidTokens = (user.paidTokens || 0) + amount;
  saveUsers(store);
  res.json({ ok: true, email, paidTokens: user.paidTokens });
});
app.post('/api/auth/admin/set-plan', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const email = normEmail(req.body && req.body.email);
  const planId = String((req.body && req.body.plan) || '');
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  const store = getUsers();
  const user = store.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });
  if (planId === 'free') {
    user.plan = 'free'; user.paidTokens = 0; user.periodEnd = null; user.stripeSubscriptionId = null;
  } else {
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ ok: false, error: 'Unknown plan.' });
    user.plan = planId;
    user.paidTokens = plan.tokens;
    user.periodEnd = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  }
  saveUsers(store);
  res.json({ ok: true, email, plan: user.plan || 'free' });
});

// ---------- billing: tokens + Stripe subscriptions ----------
// Plans: Free (100 tokens/day, no payment), Starter $2/mo = 1,500 tokens/mo,
// Pro $5/mo = 5,000 tokens/mo. Stripe keys come ONLY from env vars —
// STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET,
// STRIPE_PRICE_1500, STRIPE_PRICE_5000. Nothing Stripe is hardcoded.
// If the keys are not set, paymentsEnabled is false and the Pricing page
// says "Payments coming soon" instead of showing a fake checkout button.
// Stripe prices are created in the Stripe dashboard (see README): two
// recurring monthly prices, one per paid plan; their IDs go in the env vars.
let stripeClient = null;
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripeClient) {
    try { stripeClient = require('stripe')(key); }
    catch (e) { console.error('Stripe SDK could not be loaded:', e.message); return null; }
  }
  return stripeClient;
}
function stripeEnabled() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);
}
function findUserByStripeSub(store, subId) {
  if (!subId) return null;
  return store.users.find(u => u.stripeSubscriptionId === subId) || null;
}
function planIdForPriceId(priceId) {
  if (priceId === process.env.STRIPE_PRICE_1500) return 'starter';
  if (priceId === process.env.STRIPE_PRICE_5000) return 'pro';
  return null;
}
// Apply a Stripe subscription to a user: plan + monthly token grant +
// period end. Called from the webhook (never from the browser).
function applySubscriptionToUser(store, user, planId, sub) {
  const plan = PLANS[planId];
  if (!plan) return false;
  user.plan = planId;
  user.paidTokens = plan.tokens; // fresh monthly grant (does not roll over)
  user.periodEnd = sub && sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString() : null;
  if (sub) {
    user.stripeSubscriptionId = sub.id;
    if (sub.customer) user.stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  }
  return true;
}
async function handleStripeEvent(event) {
  const stripe = getStripe();
  if (!stripe) return;
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    const email = normEmail((obj.metadata && obj.metadata.email) || obj.customer_email || (obj.customer_details && obj.customer_details.email));
    const planId = (obj.metadata && obj.metadata.plan) || null;
    if (!email || !planId || !PLANS[planId]) { console.error('Stripe checkout completed with missing email/plan:', event.id); return; }
    const store = getUsers();
    const user = store.users.find(u => u.email === email);
    if (!user) { console.error('Stripe checkout for unknown user:', email); return; }
    let sub = null;
    if (obj.subscription) { try { sub = await stripe.subscriptions.retrieve(obj.subscription); } catch (e) { console.error('Could not retrieve subscription:', e.message); } }
    if (applySubscriptionToUser(store, user, planId, sub)) {
      if (obj.customer) user.stripeCustomerId = typeof obj.customer === 'string' ? obj.customer : obj.customer.id;
      saveUsers(store);
      console.log(`Stripe: granted ${planId} plan to ${email}`);
    }
  } else if (event.type === 'invoice.paid') {
    // Renewals only — the first invoice (subscription_create) is already
    // covered by checkout.session.completed; granting again would double it.
    if (obj.billing_reason !== 'subscription_cycle' || !obj.subscription) return;
    let sub = null;
    try { sub = await stripe.subscriptions.retrieve(obj.subscription); } catch (e) { console.error('Could not retrieve subscription:', e.message); return; }
    const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
    const planId = planIdForPriceId(priceId);
    if (!planId) return;
    const store = getUsers();
    const user = findUserByStripeSub(store, sub.id);
    if (!user) return;
    if (applySubscriptionToUser(store, user, planId, sub)) {
      saveUsers(store);
      console.log(`Stripe: renewed ${planId} tokens for ${user.email}`);
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const store = getUsers();
    const user = findUserByStripeSub(store, obj.id);
    if (!user) return;
    user.plan = 'free'; user.paidTokens = 0; user.periodEnd = null; user.stripeSubscriptionId = null;
    saveUsers(store);
    console.log(`Stripe: subscription ended for ${user.email} — back to Free`);
  } else if (event.type === 'customer.subscription.updated') {
    if (obj.status !== 'canceled' && obj.status !== 'incomplete_expired') return;
    const store = getUsers();
    const user = findUserByStripeSub(store, obj.id);
    if (!user) return;
    user.plan = 'free'; user.paidTokens = 0; user.periodEnd = null; user.stripeSubscriptionId = null;
    saveUsers(store);
    console.log(`Stripe: subscription ${obj.status} for ${user.email} — back to Free`);
  }
}

app.get('/api/billing/config', (req, res) => {
  res.json({
    ok: true,
    paymentsEnabled: stripeEnabled(),
    publishableKey: stripeEnabled() ? process.env.STRIPE_PUBLISHABLE_KEY : null,
    freeDailyTokens: FREE_DAILY_TOKENS,
    plans: Object.values(PLANS).map(p => ({ id: p.id, name: p.name, price: p.price, tokens: p.tokens }))
  });
});
app.get('/api/billing/me', (req, res) => {
  const auth = getAuth(req);
  if (!auth.loggedIn) return res.json({ ok: true, loggedIn: false });
  const st = tokenState(auth.email);
  res.json({ ok: true, loggedIn: true, email: auth.email, ...st });
});
app.post('/api/billing/checkout', async (req, res) => {
  const auth = requireLogin(req, res);
  if (!auth) return;
  const plan = PLANS[String((req.body && req.body.plan) || '').trim()];
  if (!plan) return res.status(400).json({ ok: false, error: 'Unknown plan.' });
  const stripe = getStripe();
  const priceId = process.env[plan.priceEnv];
  if (!stripe || !priceId) return res.status(503).json({ ok: false, error: 'Payments are coming soon — plans will be available once configured.' });
  try {
    const host = req.get('host') || '';
    const base = host.includes('localhost') || host.includes('127.0.0.1') ? 'http://' + host : 'https://' + host;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: auth.email,
      client_reference_id: auth.email,
      metadata: { email: auth.email, plan: plan.id },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: base + '/pricing.html?checkout=success',
      cancel_url: base + '/pricing.html?checkout=cancelled',
      allow_promotion_codes: true
    });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('Stripe checkout failed:', e.message);
    res.status(400).json({ ok: false, error: 'Could not start checkout — please try again later.' });
  }
});

// ---------- Overview: aggregates over OUR stored data only (maps + trending scans) ----------
// No fake numbers anywhere: every figure comes from data/maps.json and
// data/trending.json. Periods with no data return an empty list + "no data
// yet" on the frontend.
function buildChannelIndex() {
  const idx = new Map();
  const addVideo = (e, v) => {
    e.videos.push({
      id: v.id, title: v.title, views: v.views || 0, publishedAt: v.publishedAt || '',
      duration: v.duration || fmtDuration(v.durationSec || 0), durationSec: v.durationSec || 0,
      thumbnail: v.thumbnail || '', channelId: e.id, channelTitle: e.title,
      channelThumbnail: e.thumbnail, subs: e.subs
    });
  };
  for (const m of getMaps()) {
    for (const c of (m.channels || [])) {
      // subs: keep null when unknown (hidden/absent) — never coerce to 0.
      const subs = (typeof c.subs === 'number' && c.subs > 0) ? c.subs : null;
      const e = idx.get(c.id) || { id: c.id, title: c.title || '', thumbnail: c.thumbnail || '', subs, publishedAt: c.publishedAt || '', medianViews: c.medianViews || 0, videos: [] };
      if (e.subs == null && subs != null) e.subs = subs;
      if (!e.medianViews && c.medianViews) e.medianViews = c.medianViews;
      for (const v of (c.videos || [])) addVideo(e, v);
      idx.set(c.id, e);
    }
  }
  for (const run of Object.values(getTrendingCache())) {
    for (const c of (run.channels || [])) {
      const cid = c.channelId || c.id;
      const subs = (typeof c.subs === 'number' && c.subs > 0) ? c.subs : null;
      const e = idx.get(cid) || { id: cid, title: c.title || '', thumbnail: c.thumbnail || '', subs, publishedAt: c.channelPublishedAt || '', medianViews: c.medianViews || 0, videos: [] };
      if (e.subs == null && subs != null) e.subs = subs;
      if (!e.medianViews && c.medianViews) e.medianViews = c.medianViews;
      for (const v of (c.videos || [])) addVideo(e, v);
      idx.set(cid, e);
    }
  }
  // Dedupe videos per channel (same video can appear in a map AND a trending run).
  for (const e of idx.values()) {
    const seen = new Set();
    e.videos = e.videos.filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; });
  }
  return idx;
}
function channelStats(e) {
  // Median: prefer the channel's stored medianViews (computed from its recent
  // videos at scan time). Falling back to the median of the 1–3 stored videos
  // would give a trending-only channel a multiple of 1.0× — meaningless.
  const med = (e.medianViews && e.medianViews > 0) ? e.medianViews : median(e.videos.map(v => v.views));
  const avg = e.videos.length ? Math.round(e.videos.reduce((a, v) => a + v.views, 0) / e.videos.length) : 0;
  let bestMultiple = null, bestPublishedAt = '', bestViews = 0;
  for (const v of e.videos) {
    const m = med >= 100 ? +(v.views / med).toFixed(1) : null;
    if (m !== null && (bestMultiple === null || m > bestMultiple)) { bestMultiple = m; bestPublishedAt = v.publishedAt; }
    if (v.views > bestViews) bestViews = v.views;
  }
  const ageDays = e.publishedAt ? Math.max(1, Math.round((Date.now() - new Date(e.publishedAt).getTime()) / 86400000)) : null;
  return { ageDays, avgViews: avg, videoCount: e.videos.length, medianViews: med, bestMultiple, bestPublishedAt, bestViews };
}
function vphOf(v) {
  const t = new Date(v.publishedAt).getTime();
  if (!t) return null;
  const hours = Math.max(1, (Date.now() - t) / 3600000);
  return Math.round((v.views / hours) * 10) / 10;
}

app.get('/api/overview', (req, res) => {
  const auth = getAuth(req);
  const window = req.query.window || '24h';
  const viralWindow = req.query.viralWindow || '30d';
  const winMs = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000, '90d': 90 * 86400000 }[window] || 86400000;
  const viralMs = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000, 'all': Infinity }[viralWindow] || 30 * 86400000;
  const now = Date.now();
  const idx = buildChannelIndex();
  const maps = getMaps();
  const runs = getTrendingCache();
  // Total Channels Analyzed = unique channels in OUR stored data (maps +
  // trending scans). Never any copied number.
  const totalChannels = idx.size;
  const today = todayStr();
  const todayIds = new Set();
  for (const m of maps) if ((m.createdAt || '').slice(0, 10) === today) for (const c of (m.channels || [])) todayIds.add(c.id);
  for (const run of Object.values(runs)) if ((run.asOf || '').slice(0, 10) === today) for (const c of (run.channels || [])) todayIds.add(c.channelId || c.id);
  const todayAdded = todayIds.size;
  // Recently Added Outlier Channels: trending runs from the last 24h.
  const recent = [];
  for (const run of Object.values(runs)) {
    if (!run.asOf || now - new Date(run.asOf).getTime() > 86400000) continue;
    for (const c of (run.channels || [])) {
      recent.push({
        id: c.channelId || c.id, title: c.title || '', thumbnail: c.thumbnail || '',
        subs: (typeof c.subs === 'number' && c.subs > 0) ? c.subs : null, ageDays: c.ageDays || null, medianViews: c.medianViews || 0,
        bestMultiple: c.bestMultiple == null ? null : c.bestMultiple, bestViews: c.bestViews || 0,
        language: run.language || 'unknown', niche: run.niche || ''
      });
    }
  }
  recent.sort((a, b) => (b.bestMultiple || -1) - (a.bestMultiple || -1) || b.bestViews - a.bestViews);
  // Niches with High Future Competition: channels whose BEST video falls in
  // the selected window. Avg views = mean of the channel's stored videos.
  const competition = [];
  for (const e of idx.values()) {
    const s = channelStats(e);
    if (s.bestMultiple === null || !s.bestPublishedAt) continue;
    if (now - new Date(s.bestPublishedAt).getTime() > winMs) continue;
    competition.push({
      id: e.id, title: e.title, thumbnail: e.thumbnail, subs: e.subs,
      ageDays: s.ageDays, avgViews: s.avgViews, videoCount: s.videoCount,
      medianViews: s.medianViews, bestMultiple: s.bestMultiple, bestViews: s.bestViews,
      bestPublishedAt: s.bestPublishedAt
    });
  }
  competition.sort((a, b) => b.bestMultiple - a.bestMultiple || b.bestViews - a.bestViews);
  // Viral Videos On Small Channels: subs < 100,000 AND views ≥ 100,000
  // (the lakhs floor — a 108-view video is never "viral"). A channel with
  // an unknown subscriber count (hidden subs → null) is not excluded: its
  // smallness cannot be disproven, and the views floor already filters junk.
  const viral = [];
  for (const e of idx.values()) {
    if (e.subs != null && e.subs >= 100000) continue;
    for (const v of e.videos) {
      if ((v.views || 0) < 100000) continue;
      const t = new Date(v.publishedAt).getTime();
      if (!t || now - t > viralMs) continue;
      viral.push({ ...v, vph: vphOf(v) });
    }
  }
  viral.sort((a, b) => b.views - a.views);
  const allowed = auth.allowed;
  res.json({
    ok: true, allowed, accessNote: allowed ? '' : ACCESS_NOTE,
    asOf: new Date().toISOString(),
    totalChannels, todayAdded,
    mapsBuilt: maps.length, trendingRuns: Object.keys(runs).length,
    videosStored: [...idx.values()].reduce((a, e) => a + e.videos.length, 0),
    recentOutliers: (allowed ? recent : recent.map(maskChannelRow)).slice(0, 20),
    competition: (allowed ? competition : competition.map(maskChannelRow)).slice(0, 20),
    viralVideos: (allowed ? viral : viral.map(maskVideoCard)).slice(0, 24),
    windows: { window, viralWindow },
    note: 'All data comes from our own maps and trending scans — no made-up numbers. Avg views = average of stored videos.'
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
// Only auto-start when run directly (node server.js / pkg exe). Tests can
// require() this file and use the exported helpers without starting a server.
ensureAdminFromEnv();
if (require.main === module) startServer(PORT, 5);
module.exports = { app, tokenize, detectLangFamily, deriveNiche, nicheTest, median, ensureAdminFromEnv, getAuth, buildChannelIndex, vphOf, effectiveApiKey };

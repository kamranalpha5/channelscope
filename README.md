# ChannelScope (Standalone) — YouTube Competitor Map

makina.studio-style tool, apni branding ke saath. Apne PC par chalao, apni YouTube Data API v3 key se.

**Version 1.3.1** — token system + Stripe plans, pure-English UI, separate admin panel (`/admin`), single-key model, search error surfacing, 0-subs fix, viral floor (≥100K views), clickable YouTube cards, daily search cache (100/day search quota), search-quota guard + display, public Privacy Policy (`/privacy`).

## Overview page (home page — `/`)

Site ka home page ab **Overview** hai (Map app `/app.html` par hai). Nexlev-style layout, ChannelScope branding — Nexlev ka naam, logo ya text copy nahi kiya gaya.

- **Sidebar:** Overview, Map, Breakouts, Topics, Map chat, Trending 24h, Results — sab asal sections ke links.
- **Total Channels Analyzed:** HAMARA asal count — hamare maps + trending scans ke unique channels (aaj ka increment saath). Koi bahari number nahi.
- **Recently Added Outlier Channels (Last 24 Hours):** pichle 24h ke trending scans se naye channels — DP, naam, subs, outlier multiple bar ke saath. Language filter bhi hai.
- **Niches with High Future Competition:** time tabs (Last 24 Hours / 7 Days / 30 Days / 90 Days) — DP, naam, subs, Avg views (stored videos ki average), Videos, Days since start, Outlier. Jis period ke liye data nahi, wahan "no data yet" dikhta hai — fake numbers kabhi nahi.
- **Viral Videos On Small Channels:** Last 24 Hours / 7 Days / 30 Days dropdown + 🎲 Random button. Video cards: thumbnail + duration, title, channel DP + naam, views + kitne din pehle, **VPH (views per hour)** + subs. Small channels = subs &lt; 100,000. Cards views ke hisaab se sorted; Random grid ko shuffle karta hai (koi API call nahi). VPH = views ÷ publish hone se ab tak ke hours (publishedAt + viewCount se, koi extra API nahi).

## Login + access control (Overview / Trending data)

- **Login:** email + password. Passwords `node:crypto` scrypt se hash hote hain (koi naya npm package nahi); sessions HMAC-signed cookie token (7 din).
- **Kamran ADMIN hai.** Admin account do tareeqon se banta hai:
  1. **Env vars (Render par recommended):** Render dashboard → service → Environment → `ADMIN_EMAIL` + `ADMIN_PASSWORD` (8+ characters) set karo. Har boot par admin dobara ban jata hai (agar pehle se na ho).
  2. **First-run setup:** agar koi user nahi hai to sirf **direct URL `/admin`** par setup form dikhta hai — pehla account admin banega. Public site par setup ka koi zikr nahi.
- **Allowlist:** Admin panel (sirf admin ko dikhta hai — direct URL `/admin`, public site par koi link nahi) mein Kamran allowed emails add/remove karta hai.
- **Rule:** SIRF allowlist wali emails ko Overview / Trending data **unblurred** dikhta hai. Login nahi, ya email allowlist mein nahi → channels **BLURRED** + "Request access" note.
- **SERVER-SIDE MASKING (lazmi):** sirf CSS blur nahi — Overview aur Trending APIs non-allowed user ko masked data deti hain (naam → "•••", DP → placeholder, subs/outlier/views → hidden). Blurred view mein asal data response mein bhi nahi aata.
- **Building (map/trending) ke liye allowlist zaroori NAHI:** koi bhi logged-in user tokens se map bana sakta hai — allowlist sirf Overview/Trending data ka blur/unblur control karta hai.

> **⚠️ Free Render caveat (chhupaya nahi ja raha):** Render free plan par service restart hone par `data/*.json` (users, allowlist, maps, settings) reset ho sakte hain — users ko dobara register aur allowlist ko dobara add karna hoga. Admin env vars (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) se har boot par dobara ban jata hai. API key bhi dobara dalni hogi.

## Chalane ka tareeqa (Windows)

1. **Node.js install karo (agar nahi hai):** https://nodejs.org se **LTS** version download karke install karo.
2. **Zip extract karo** — kisi bhi folder mein (jaise `Desktop\ChannelScope`).
3. **`start.bat` par double-click karo.**
   - Pehli dafa dependencies install hongi (aik dafa, internet chahiye).
   - Browser khud khul jayega: **http://localhost:3000**
   - Band karne ke liye black window mein `Ctrl+C` dabao.
4. **API key daalo (sirf admin, sirf `/admin` panel se):** Admin panel mein apni **YouTube Data API v3 key** paste karo aur Save dabao. Public site par key ka koi field, status ya zikr nahi — poori site sirf is EK key se chalti hai (single-key model: kisi visitor ya user se kabhi key nahi mangi jati).
   - Key banane ke liye: Google Cloud Console → YouTube Data API v3 **Enable** → Credentials → **Create API key** → key ko sirf **YouTube Data API v3** par restrict karo.
   - Key sirf is PC par save hoti hai (`data/settings.json`) — kahin aur nahi jati.
5. **Map banao:** Seed channel likho (jaise `@EconomyPuzzle`), Depth choose karo, **Build map** dabao.
   - Seed ~1 second mein dikhega, phir har depth ring aik aik karke bharegi ("Depth X of Y ready").
   - Agar page band ho jaye to map **Continue building** se resume ho jata hai.

## Kya kya hai

- **Map:** Har node par channel ki asli DP + naam. Mouse rakho to detail card (subs, median views, sab se bara breakout). Click karo to poora detail panel — **Download JSON** + us channel ki **poori videos list** (har video: views, outlier multiple, published date). Videos list map nodes se aur Breakouts se dono jagah khulti hai.
- **My maps (switcher):** Map section mein saare built maps ki list — seed, depth, channels, date. Kisi bhi map par Open dabao, ya Delete / Clear all. Page load par hamesha **newest map** dikhta hai; naya map bante hi UI us par switch kar jata hai.
- **Niche (STRICT — niche-only):** Har seed channel se niche khud derive hoti hai (uski videos ke titles, tags, category se) — koi fixed topic nahi. Map mein **SIRF usi niche ke channels** aate hain. Keyword rules: length ≥3, kisi bhi language ka stopword nahi (English, Korean, Spanish, French, German, Portuguese), koi generic lafz nahi (movie, full, HD, video, official...), aur seed ki ≥2 videos/tags mein aana chahiye. Candidate ko map mein aane ke liye ≥2 niche keywords **AUR** (same language family **YA** same YouTube category) chahiye. Agar kisi ring mein 0 neighbours milen to map par saaf wajah + **Try again** dikhta hai — khamoshi se seed-only map nahi dikhaya jata.
- **Channel JSON:** Detail panel mein **Download JSON** — complete breakdown + core engine (format, hook style, pacing, retention devices — channel ke apne data se inferred, estimates marked).
- **Replicate script:** Kisi bhi competitor video par **Replicate script** — SAME structure (length, pace, beats, arc, cliffhangers) mein NAYA ORIGINAL script, wording/names 100% fresh. Competitor ke exact alfaaz kabhi copy nahi hote.
- **Breakouts:** Har video jo apne channel ke median se zyada chali (default 3×), amber badges, multiple ke hisaab se sorted. **Median guard:** video sirf tab breakout kehlati hai jab uske channel ka median ≥100 views ho (warna 173,759 views / 21 median ≈ 8274× jaisa bekaar multiple banta hai). Har breakout ke saath channel median bhi dikhta hai. Breakouts hamesha sirf **currently selected map** se aate hain.
- **Trending 24h (naya tab):** Pichle 24 hours mein trending NEW channels — channel **30–60 din purana**, **1000+ subs**, aur uski 24h video ke **views ≥100,000 (lakhs mein)**. Criteria signal: 1000+ subs aur views lakhs mein — watch hours API se verify nahi ho sakte, is liye yehi signal use hota hai (UI mein likha hai). Niche default = current map ki niche (ya khud type karo). List rozana aik dafa compute hoti hai (daily cache — "Data as of" + Refresh button dikhte hain), pagination 10/page, har page par dobara API call nahi. Quota: ~335 units per run (3 searches × 100 + details). Koi qualifying channel na mile to khaali state saaf dikhti hai — koi fake data nahi. **Access:** sirf allowed (allowlist) users ko unblurred data; baqi ko cached run server-side masked milta hai. **Fresh run:** login + 50 tokens chahiye (allowlist zaroori nahi) — non-allowed user bhi run kar sakta hai, lekin result usko masked dikhega.
- **Topics:** Tumhare map ke breakout data se topic suggestions — score /10, expected views range, 5 original titles. Koi AI key nahi chahiye.
- **Map chat:** Apne map ke data par sawal-jawab. **Analysis chat:** "Analyze my channel and suggest my next video topic" chip dabao — structured analysis milti hai: tumhare channel ki age/videos table/strongest video/pattern, 100K se chhote naye channels unke top outliers ke saath (good vs poor model — data-based judgement), aur proof ke saath 3–4 next-video ideas. Sab kuch tumhare apne map ke data se compute hota hai — koi AI key nahi chahiye, competitor ki title kabhi copy nahi hoti.
- **Results:** Totals — maps, channels, videos, breakouts, quota used.

## Quota (YouTube free quota: 10,000 units/day)

- Search call = 100 units, baaki calls (channel/video/playlist) = 1 unit.
- App har map par quota used dikhata hai. Depth 2 map aam tor par 500–2,500 units leta hai.
- **Quota guard:** build shuru karne se pehle server check karta hai ke baaqi quota build ke liye kaafi hai (Depth 1: 1,600, Depth 2: 3,000, Depth 4: 5,000 units estimate; trending run: 500). Agar nahi to build shuru hi nahi hota — "Daily quota is nearly exhausted — please try again tomorrow" dikhta hai. Tokens baaqi hon to bhi quota khatam hone par builds pause rehte hain.
- **Quota increase:** Google Cloud Console se 100,000 units/day ki request ki ja sakti hai (review mein waqt lagta hai, guarantee nahi). Request usi Google account se submit hoti hai jis se YouTube API key banayi thi.

### Search quota — ALAG limit: 100 searches/day (BOHOT AHEM)

- YouTube ki **"Search Queries per day"** quota 10,000-unit quota se **alag** hai — sirf **100 searches/day**. Live finding (2026-11-11, Cloud Console, project NexGen): usage **112/100 — OVER LIMIT** — yehi wajah thi ke search.list fail ho raha tha jabke channels/videos kaam kar rahe the. Raw error `quotaExceeded` (403) hota hai — `/api/diag` par `lastYtError` mein nazar aata hai.
- **Search-call savings (v1.3.1):** har search din mein aik dafa cache hoti hai (`data/search-cache.json`) — wohi query (wohi type) dobara muft milti hai, quota nahi kharch hota. Is se:
  - Depth-2 map ki ring 2 (ring 1 ki wohi queries) = **0 searches**.
  - Stalled ring dobara try karna = **0 searches** (agar queries cached hon).
  - Trending run ke keywords bhi cache hote hain.
  - Per-build searches: Depth 1 ≈ 13, Depth 2 ≈ 13 (pehle ~25), Depth 4 ≈ 13 (pehle ~37) — sirf pehli ring ki queries kharch hoti hain, baaqi rings cache se chalti hain. Naya niche = 12 searches; wohi niche dobara = 0.
- **Search guard:** build/trending shuru karne se pehle server check karta hai ke baaqi searches kaafi hain (sirf UNCACHED queries gini jati hain). Agar nahi to build shuru hi nahi hota aur saaf message dikhta hai — tokens bhi charge nahi hote.
- **Display:** Map page ki quota bar mein "Search calls used today: X / 100" dikhta hai; `/api/status` aur `/api/diag` mein bhi `searchUsed` / `searchLimit` aate hain.
- **Search quota increase:** unit quota se alag mangwana hota hai — YouTube Audit and Quota Extension Form bharna hota hai (Console se increase refuse ho jata hai: "Not enough usage history"). Form ke liye Privacy Policy URL chahiye — neeche dekho.

## Privacy Policy (`/privacy`)

- Site par public **Privacy Policy** page hai: `https://channelscope.onrender.com/privacy` — login/allowlist se azad, pure English. Link footer + login modals + sidebar foot mein hai.
- Is mein hai: kya data collect hota hai (email + hashed password, usage/tokens, YouTube public data, session cookie), Stripe payments, kya kabhi nahi hota (data bechna/share karna, ads, tracking), deletion (contact email), aur YouTube API Services ka required disclosure (YouTube Terms + Google Privacy Policy links).
- Contact email policy mein: **kamranalpha5@gmail.com** (project owner ka account — badalna ho to `public/privacy.html` mein aik jagah badlo).

## Tokens + Pricing (v1.3.1)

Token site ki apni currency hai — har logged-in user ke paas token balance hota hai (header mein dikhta hai).

- **Costs:** Map build Depth 1 = **50** tokens, Depth 2 = **100**, Depth 4 = **200**; fresh Trending 24h run = **50**. Map expand (Continue building) muft hai — wo build ki qeemat mein shamil hai. Cached data dekhna, maps dekhna, JSON download, script replicate — **0 tokens**.
- **Free tier (sab ke liye): 100 tokens/day** — har 24 ghante mein refresh (midnight UTC), accumulate nahi hote. Is se rozana aik Depth-2 map ya do Depth-1 maps bante hain.
- **Paid plans (Stripe, monthly):** **Starter $2/month = 1,500 tokens/month; Pro $5/month = 5,000 tokens/month.** Tokens har billing period mein refresh hote hain (unused paid tokens roll over nahi hote). Free 100/day paid plan ke saath bhi milte rehte hain.
- **Pricing page:** Nav mein "Pricing" — dono plans ke cards, current plan highlight, Buy/Upgrade Plan buttons. Logged-out user ko pehle login karna hota hai. Admin apne plan ko admin panel se bhi set kar sakta hai (bina Stripe ke) ya tokens grant kar sakta hai.
- **Allowlist ka kaam:** sirf Overview data ka blur/unblur. Building ke liye login + tokens chahiye — allowlist zaroori nahi.

### Stripe setup (payments ke liye zaroori)

1. **Stripe account** banao (https://dashboard.stripe.com) — test mode se shuru karo, live par jaane se pehle test keys se verify karo.
2. **Products + Prices:** Stripe dashboard → Products → 2 products banao:
   - **Starter** — recurring, **$2 / month** → uski Price ID copy karo.
   - **Pro** — recurring, **$5 / month** → uski Price ID copy karo.
3. **Env vars set karo** (Render dashboard → service → Environment; local run par `.env` ya shell vars):
   - `STRIPE_SECRET_KEY` — Stripe secret key (`sk_test_…` ya `sk_live_…`)
   - `STRIPE_PUBLISHABLE_KEY` — publishable key (`pk_test_…` ya `pk_live_…`)
   - `STRIPE_WEBHOOK_SECRET` — neeche webhook banane par milne wala signing secret (`whsec_…`)
   - `STRIPE_PRICE_1500` — Starter price ki ID (`price_…`)
   - `STRIPE_PRICE_5000` — Pro price ki ID (`price_…`)
   - Keys kabhi code mein hardcode nahi — sirf env vars se aati hain.
4. **Webhook:** Stripe dashboard → Developers → Webhooks → Add endpoint:
   - URL: `https://<tumhari-domain>/api/billing/webhook` (jaise `https://channelscope.onrender.com/api/billing/webhook`)
   - Events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, `customer.subscription.updated`
   - Signing secret (`whsec_…`) copy karke `STRIPE_WEBHOOK_SECRET` mein daalo.
5. **Flow:** user plan chune → Stripe Checkout (subscription, monthly recurring) → payment success par webhook `checkout.session.completed` aata hai (signature verify lazmi — server `stripe.webhooks.constructEvent` se karta hai) → user ko plan + monthly tokens grant hote hain. Har billing period par `invoice.paid` (subscription_cycle) tokens refresh karta hai. Subscription cancel/delete hone par plan khatam aur tokens 0 ho jate hain.
6. **Keys set nahi hain to:** Pricing page par "Payments coming soon — plans will be available once configured" dikhta hai — koi fake checkout button nahi. Baaki site (free tokens se builds) normal chalti hai.

## Data source (Nexlev se farq)

Nexlev ke paas 160M channels ka database hai. Hamara data user ke apne maps/scans se banta hai — Overview panels scans chalne ke saath bharte hain. Jab tak koi scan nahi chala, panels "no data yet" dikhate hain — koi fake/junk data nahi bhara jata.

## Website par chalana (Render free server)

Yehi code aik proper website ki tarah bhi chal sakta hai — koi exe/Node install nahi chahiye:

1. **GitHub repo:** `kamranalpha5/channelscope` (public) mein ye code push karo.
2. **Render:** https://dashboard.render.com → **New +** → **Web Service** → repo select karo. `render.yaml` Blueprint pehle se maujood hai (free plan, build `npm install`, start `node server.js`, health check `/api/status`).
3. **Deploy hote hi** Render aik public URL dega (jaise `https://channelscope.onrender.com`) — wahan app khul jayegi.
4. **API key** sirf admin panel (`/admin` — direct URL) se set hoti hai (key sirf server ki `data/settings.json` mein save hoti hai — ye file git mein kabhi nahi jati, `.gitignore` mein hai). Public site par key ka koi field nahi.

Note: Render free plan par pehli request ~30–50 second late ho sakti hai (server idle sleep ke baad jagta hai).

## Notes

- Sirf `server.js`, `package.json`, `public/` aur `start.bat` chahiye. `data/` folder app khud banata hai (settings + maps JSON files).
- Port 3000 use hota hai. Agar 3000 busy ho to `set PORT=3001` karke `node server.js` chalao, ya start.bat edit karo.
- Internet zaroori hai (YouTube API calls ke liye).
- Ye tool YouTube/Google se affiliated nahi hai.

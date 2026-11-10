# ChannelScope (Standalone) — YouTube Competitor Map

makina.studio-style tool, apni branding ke saath. Apne PC par chalao, apni YouTube Data API v3 key se.

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
  2. **First-run setup:** agar koi user nahi hai to Overview page par setup form dikhta hai — pehla account admin banega.
- **Allowlist:** Admin panel (sirf admin ko dikhta hai) mein Kamran allowed emails add/remove karta hai.
- **Rule:** SIRF allowlist wali emails ko Overview / Trending data **unblurred** dikhta hai. Login nahi, ya email allowlist mein nahi → channels **BLURRED** + "Request access" note, aur wo feature use nahi kar sakta.
- **SERVER-SIDE MASKING (lazmi):** sirf CSS blur nahi — Overview aur Trending APIs non-allowed user ko masked data deti hain (naam → "•••", DP → placeholder, subs/outlier/views → hidden). Blurred view mein asal data response mein bhi nahi aata. Non-allowed user ke liye Trending fresh scan bhi nahi chalata (quota bachao) — sirf cached run masked milta hai.
- **Baaki site (Map, Breakouts, Topics, Map chat) pehle jaisi hi hai** — login sirf Overview/Trending data ke liye hai.

> **⚠️ Free Render caveat (chhupaya nahi ja raha):** Render free plan par service restart hone par `data/*.json` (users, allowlist, maps, settings) reset ho sakte hain — users ko dobara register aur allowlist ko dobara add karna hoga. Admin env vars (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) se har boot par dobara ban jata hai. API key bhi dobara dalni hogi.

## Chalane ka tareeqa (Windows)

1. **Node.js install karo (agar nahi hai):** https://nodejs.org se **LTS** version download karke install karo.
2. **Zip extract karo** — kisi bhi folder mein (jaise `Desktop\ChannelScope`).
3. **`start.bat` par double-click karo.**
   - Pehli dafa dependencies install hongi (aik dafa, internet chahiye).
   - Browser khud khul jayega: **http://localhost:3000**
   - Band karne ke liye black window mein `Ctrl+C` dabao.
4. **API key daalo:** App mein "API Key" section mein apni **YouTube Data API v3 key** paste karo aur Save dabao.
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
- **Trending 24h (naya tab):** Pichle 24 hours mein trending NEW channels — channel **30–60 din purana**, **1000+ subs**, aur uski 24h video ke **views ≥100,000 (lakhs mein)**. Criteria signal: 1000+ subs aur views lakhs mein — watch hours API se verify nahi ho sakte, is liye yehi signal use hota hai (UI mein likha hai). Niche default = current map ki niche (ya khud type karo). List rozana aik dafa compute hoti hai (daily cache — "Data as of" + Refresh button dikhte hain), pagination 10/page, har page par dobara API call nahi. Quota: ~335 units per run (3 searches × 100 + details). Koi qualifying channel na mile to khaali state saaf dikhti hai — koi fake data nahi. **Access:** sirf allowed (allowlist) users ko unblurred data; baqi ko cached run server-side masked milta hai, fresh scan nahi chalta.
- **Topics:** Tumhare map ke breakout data se topic suggestions — score /10, expected views range, 5 original titles. Koi AI key nahi chahiye.
- **Map chat:** Apne map ke data par sawal-jawab. **Analysis chat:** "Analyze my channel and suggest my next video topic" chip dabao — structured analysis milti hai: tumhare channel ki age/videos table/strongest video/pattern, 100K se chhote naye channels unke top outliers ke saath (good vs poor model — data-based judgement), aur proof ke saath 3–4 next-video ideas. Sab kuch tumhare apne map ke data se compute hota hai — koi AI key nahi chahiye, competitor ki title kabhi copy nahi hoti.
- **Results:** Totals — maps, channels, videos, breakouts, quota used.

## Quota (YouTube free quota: 10,000 units/day)

- Search call = 100 units, baaki calls (channel/video/playlist) = 1 unit.
- App har map par quota used dikhata hai. Depth 2 map aam tor par 500–2,500 units leta hai.

## Website par chalana (Render free server)

Yehi code aik proper website ki tarah bhi chal sakta hai — koi exe/Node install nahi chahiye:

1. **GitHub repo:** `kamranalpha5/channelscope` (public) mein ye code push karo.
2. **Render:** https://dashboard.render.com → **New +** → **Web Service** → repo select karo. `render.yaml` Blueprint pehle se maujood hai (free plan, build `npm install`, start `node server.js`, health check `/api/status`).
3. **Deploy hote hi** Render aik public URL dega (jaise `https://channelscope.onrender.com`) — wahan app khul jayegi.
4. **API key** website par Settings mein paste karo (key sirf server ki `data/settings.json` mein save hoti hai — ye file git mein kabhi nahi jati, `.gitignore` mein hai).

Note: Render free plan par pehli request ~30–50 second late ho sakti hai (server idle sleep ke baad jagta hai).

## Notes

- Sirf `server.js`, `package.json`, `public/` aur `start.bat` chahiye. `data/` folder app khud banata hai (settings + maps JSON files).
- Port 3000 use hota hai. Agar 3000 busy ho to `set PORT=3001` karke `node server.js` chalao, ya start.bat edit karo.
- Internet zaroori hai (YouTube API calls ke liye).
- Ye tool YouTube/Google se affiliated nahi hai.

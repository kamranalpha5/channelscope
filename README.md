# ChannelScope (Standalone) — YouTube Competitor Map

makina.studio-style tool, apni branding ke saath. Apne PC par chalao, apni YouTube Data API v3 key se.

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

- **Map:** Har node par channel ki asli DP + naam. Mouse rakho to detail card (subs, median views, sab se bara breakout). Click karo to poora detail panel.
- **Niche:** Har seed channel se niche khud derive hoti hai (uski videos ke titles, tags, category se) — koi fixed topic nahi. Map mein sirf usi niche ke channels aate hain. Derived keywords map ke upar chips mein dikhte hain.
- **Channel JSON:** Detail panel mein **Download JSON** — complete breakdown + core engine (format, hook style, pacing, retention devices — channel ke apne data se inferred, estimates marked).
- **Replicate script:** Kisi bhi competitor video par **Replicate script** — SAME structure (length, pace, beats, arc, cliffhangers) mein NAYA ORIGINAL script, wording/names 100% fresh. Competitor ke exact alfaaz kabhi copy nahi hote.
- **Breakouts:** Har video jo apne channel ke median se zyada chali (default 3×), amber badges, multiple ke hisaab se sorted.
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

# Hidden Option Confidence Multiplayer Game

Multiplayer web game hosted on Netlify with Supabase as database.

## What this project includes

- Static frontend (`index.html`, `app.js`, `styles.css`)
- Server API via Netlify Functions (`netlify/functions/api.mjs`)
- Supabase schema (`supabase/schema.sql`)
- CSV question bank (`questions.csv`)

Game logic implemented:

- Random question selection from CSV-backed Supabase table
- Unique option assignment (one option per player)
- Hidden options (players only see their own)
- Base phase scoring
- Conflict phase scoring for multiple `Confident Correct`
- Optional early submission bonus (`+1`)
- Multi-round cumulative leaderboard

---

## 1) Supabase Setup

1. Create a new Supabase project.
2. Open SQL Editor and run `supabase/schema.sql`.
3. In Supabase dashboard, copy:
   - `Project URL` (Settings -> API)
   - `service_role` key (Settings -> API)

> The service role key must stay server-side only. Never expose it in frontend code.

---

## 2) Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

3. Fill `.env`:

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

4. Run locally with Netlify Dev:

```bash
npm run dev
```

5. Open the printed local URL (usually `http://localhost:8888`).

Optional room URL format:

- Default room: `http://localhost:8888`
- Custom room: `http://localhost:8888/?room=my-room`

---

## 3) How `questions.csv` works

CSV columns:

```csv
questionId,caseStudy,question,correctAnswer,incorrectAnswers
```

- `caseStudy` is optional (can be blank)
- `incorrectAnswers` must use `|` separator
- Total options for a row = `1 + number of incorrect answers`

Important rule:

- A round starts only if a question exists with option count exactly equal to joined players.

Example:

- 4 joined players -> must have question with 1 correct + 3 incorrect answers.

---

## 4) Push to GitHub (new repo)

From project root:

```bash
git init
git add .
git commit -m "Initial multiplayer Hidden Option Confidence game"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
git push -u origin main
```

Recommended `.gitignore`:

```gitignore
node_modules/
.env
.netlify/
```

---

## 5) Deploy to Netlify

### Option A: Netlify UI (recommended)

1. In Netlify, click **Add new site** -> **Import an existing project**.
2. Connect your GitHub repo.
3. Build settings:
   - Build command: `npm run build`
   - Publish directory: `.`
4. Add environment variables in Site settings -> Environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
5. Deploy.

### Option B: Netlify CLI

```bash
npx netlify login
npx netlify init
npx netlify env:set SUPABASE_URL "https://...supabase.co"
npx netlify env:set SUPABASE_SERVICE_ROLE_KEY "..."
npx netlify deploy --build
npx netlify deploy --prod --build
```

---

## 6) End-to-end test checklist

1. Open game URL in multiple browser windows/incognito profiles.
2. Join same room with unique names.
3. Confirm lobby says matching question is available.
4. Start round.
5. Verify each user sees:
   - same question
   - only one assigned option
6. Submit mixed choices and test timer expiry.
7. Force conflict by making 2+ users choose `Confident Correct`.
8. In conflict phase, submit `Stand Ground` / `Back Down`.
9. Verify leaderboard score updates across rounds.

---

## 7) Notes and limits

- This MVP uses polling (every 2 seconds) instead of realtime websockets.
- Any joined player can start a round.
- Questions are synced from `questions.csv` when starting a round.
- If all matching questions are used, add more rows or reset room data in Supabase tables.

---

## 8) Useful cleanup SQL (optional)

To reset one room quickly:

```sql
delete from score_events where room_id in (select id from game_rooms where room_code = 'main');
delete from conflict_submissions where round_id in (select id from rounds where room_id in (select id from game_rooms where room_code = 'main'));
delete from base_submissions where round_id in (select id from rounds where room_id in (select id from game_rooms where room_code = 'main'));
delete from round_assignments where round_id in (select id from rounds where room_id in (select id from game_rooms where room_code = 'main'));
delete from rounds where room_id in (select id from game_rooms where room_code = 'main');
update game_rooms set current_round_id = null, status = 'lobby', round_number = 0 where room_code = 'main';
update players set score = 0 where room_id in (select id from game_rooms where room_code = 'main');
```

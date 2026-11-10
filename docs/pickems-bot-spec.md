# Sixth City Pick'ems Bot — Build Spec (v1)

*Prepared Nov 9, 2026 for a Claude Code session in `github.com/Clovena/sixth-city-dynasty`. Target: live in Discord before the DFL playoffs (Week 15, first post Tue Dec 15).*

---

## 0. What we're building, in one paragraph

A zero-touch weekly pick'ems system for two fantasy leagues in the same Discord server. Every Tuesday morning it posts the standings and one native Discord poll per matchup. On Thursday evening it @mentions anyone who still hasn't picked. On Sunday at 1:00 PM ET it closes the polls. The following Tuesday it pulls the final scores, grades every pick, and posts updated standings alongside the next week's polls. It runs as one Supabase Edge Function, called every 5 minutes by `pg_cron`. Nothing runs all the time and there is no Discord gateway connection; it only makes REST calls to Supabase, Sleeper and Discord.

It replaces the commissioner's current manual process: sending 14 messages, adding 28 reaction emotes, recording votes by hand and keeping a spreadsheet.

---

## 1. Context

### The leagues

| Key | Name | Platform | Matchups / week | Source of matchups | Source of results |
|---|---|---|---|---|---|
| `dfl` | Sixth City Dynasty (SCDFL / "DFL") | Sleeper | 7 in the regular season; fewer in the playoffs | `scdfl.matchups` (regular season), Sleeper brackets (playoffs) | Sleeper API |
| `efl` | Epsilon Fantasy League (redraft) | ESPN (may move to Sleeper in 2027) | 7 | **Manual entry** in a Supabase table | **Manual entry** (winners) |

- Each league has its own leaderboard. Standings are never combined.
- The DFL 2026 Sleeper league ID is `1312945374800920576`. Look it up from `scdfl.seasons` by year; don't hard-code it.
- The DFL regular season is weeks 1–14 (`scdfl.seasons.regular_season_weeks`). The playoffs are weeks 15–17: a 7-team bracket where the 1-seed gets a bye, plus a consolation bracket. Week 17 is **Dynasty Bowl VI**.

### The person

Zac is the commissioner and the only developer. He knows JS, HTML, Python and R well, but **he's new to Discord bots and Deno.** Write readable code, prefer plain-JavaScript style (types only where they help), and explain each Discord or Supabase concept briefly the first time it comes up. He vibe-codes, but he should understand three things before go-live:
1. The bot token is a password.
2. All times are stored in UTC and converted for Eastern Time.
3. Every step must be safe to run twice.

### Goals
1. Zero commissioner effort per week for DFL. For EFL: a 2-minute entry of pairings on Tuesday and of winners after MNF, until EFL moves to Sleeper.
2. Same look and rhythm as today: a Tuesday morning post with standings and the week's matchups.
3. Reliable: no duplicate polls, no missed posts, recovers by itself from a failed run.
4. A foundation the Coaches Poll (Phase 2) can reuse.

### Non-goals (v1)
- Coaches Poll / ranked ballots (Phase 2 — needs a Discord Interactions endpoint).
- ESPN API integration (EFL stays manual this season).
- Slash commands, buttons, DMs.
- A website leaderboard (later, via a view).
- Auto-refreshing `scdfl.matchups` scores (separate project; see §5.4).
- Pick'ems for exhibitions (Tag Team, PEI vs The World).

---

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Runtime | **Supabase Edge Function** (Deno, TypeScript written in plain-JS style). No separate host. |
| Scheduling | `pg_cron` → `pg_net` POST to the function **every 5 minutes**. The function decides what is due. |
| Discord mechanism | **Native Discord polls**: one poll per matchup, two answers, no multiselect. Picks are public, like today's reactions. |
| Discord libraries | None. Use raw `fetch` against REST API v10 (simpler and easier to read). |
| DB access | Direct Postgres via the built-in `SUPABASE_DB_URL` and `postgres.js` (no PostgREST schema exposure, no API keys involved). |
| Schema | New schema **`pickems`** for all bot tables. It only reads from `scdfl`, never writes to it. |
| Post | **Tuesday 9:00 AM ET**: standings plus the new week's polls. |
| Reminder | **Thursday 8:00 PM ET** (around TNF kickoff): @mention only players missing picks. |
| Lock | **Sunday 1:00 PM ET hard lock** (votes after TNF are fine). Editable per week for early international games. |
| Scoring | **Following Tuesday 8:30 AM ET** (after MNF), then the 9:00 post includes fresh standings. |
| DFL results | **Sleeper API** for now. Switch to `scdfl.matchups` only after the sync is automated (config flag). |
| EFL | Manual pairings and winners in `pickems.manual_matchups`. |
| Self-votes | Allowed (relevant to Phase 2's Coaches Poll; nothing to enforce here). |
| Leaderboards | Two: DFL and EFL. |

---

## 3. Architecture

```
   pg_cron (every 5 min)
        │  net.http_post  (header: x-cron-secret)
        ▼
 ┌─────────────────────────────── Edge Function: pickems ───────────────────────────────┐
 │  index.ts  → auth check → acquire lease → tick() → release                            │
 │                                                                                        │
 │  tick(): for each active league → for each due calendar step:                          │
 │     SCORE (Tue 8:30) → POST (Tue 9:00) → REMIND (Thu 8pm) → LOCK (Sun 1pm) → COLLECT   │
 │                                                                                        │
 │  sources/   scdfl.ts (DFL regular-season pairings + bowl/rivalry tags)                 │
 │             sleeper.ts (results, playoff brackets)                                     │
 │             manual.ts (EFL pairings + winners)                                         │
 │  discord.ts  thin REST client (post message/poll, expire poll, get voters, 429 retry)  │
 │  render.ts   pure functions → message payloads (standings, polls, reminder, results)   │
 │  db.ts       postgres.js client + queries                                              │
 └──────────────┬──────────────────────────────┬───────────────────────────┬──────────────┘
                ▼                              ▼                           ▼
        Supabase Postgres               Sleeper API (public)        Discord REST API v10
   (scdfl.* read, pickems.* r/w)     api.sleeper.app/v1/...       discord.com/api/v10/...
```

Suggested layout (adapt to the repo; check whether a `supabase/` directory already exists, and run `npx supabase init` if not):

```
supabase/
  config.toml                      # [functions.pickems] verify_jwt = false
  migrations/
    2026111x_pickems_schema.sql
    2026111x_pickems_seed.sql
  functions/
    pickems/
      index.ts                     # HTTP entry: auth, action routing
      tick.ts                      # state machine
      db.ts
      discord.ts
      sleeper.ts
      sources.ts                   # pairings per league/week (scdfl / sleeper bracket / manual)
      render.ts                    # all message formatting (pure)
      calendar.ts                  # ET helpers (pure)
      *_test.ts                    # Deno tests for pure modules
docs/
  pickems-bot-spec.md              # this file (NOT under src/pages — Astro would route it)
```

---

## 4. Weekly lifecycle

### 4.1 Calendar

`pickems.calendar` holds one row per NFL week with four timestamps (timestamptz). It's computed once with time-zone-aware SQL, so DST is handled at seed time and the function never does ET math for scheduling. Zac can edit any row by hand, for example to move a lock earlier for a 9:30 AM ET international game.

2026 anchor: Week 1 Sunday = **2026-09-13**. Week *w* Sunday = anchor + 7·(w−1). Week 17 Sunday = 2027-01-03.

```sql
insert into pickems.calendar (season, week, post_at, remind_at, lock_at, score_at)
select 2026, w,
  ((date '2026-09-13' + 7*(w-1) - 5) + time '09:00') at time zone 'America/New_York', -- Tue
  ((date '2026-09-13' + 7*(w-1) - 3) + time '20:00') at time zone 'America/New_York', -- Thu
  ((date '2026-09-13' + 7*(w-1))     + time '13:00') at time zone 'America/New_York', -- Sun
  ((date '2026-09-13' + 7*(w-1) + 2) + time '08:30') at time zone 'America/New_York'  -- next Tue
from generate_series(10, 17) w;
```

Check: Week 10 → post Tue Nov 10, remind Thu Nov 12, lock Sun Nov 15, score Tue Nov 17. Week 12 is Thanksgiving week (the Thursday reminder still fires at 8 PM, which is fine). **Before go-live, look for international games kicking off before 1 PM ET on Sundays in weeks 11–17 and move `lock_at` to that kickoff.**

### 4.2 Steps per (league, week)

Track progress in `pickems.weeks`, with one row per league and week and a `*_at` timestamp per completed step. A step runs when `now() >= calendar.<step>_at` and its prerequisites are done.

| Step | When | Prereq | What it does |
|---|---|---|---|
| **POST** | `post_at` | previous week SCORED, or no previous week, or previous week skipped. **If the previous week's scoring is blocked (EFL winners missing), post polls anyway** with a "standings pending" line; standings go out when scoring finishes. | Post the standings message (if anything is scored or carried over), a header message, then one poll per matchup. |
| **REMIND** | `remind_at` | POSTED, `now < lock_at` | Fetch live voters, compute active players missing ≥1 pick, post one reminder mentioning only them. If nobody is missing, post nothing (or a short "all picks in" message; see open questions). |
| **LOCK** | `lock_at` | POSTED | `POST .../polls/{id}/expire` on every poll. Treat "already ended" errors as success. |
| **COLLECT** | `lock_at + 10 min` | LOCKED | Re-fetch each poll message. Wait for `poll.results.is_finalized = true` (retry on later ticks; after 2 h proceed anyway and log). Read voters for both answers (paged) and upsert into `pickems.picks`. Auto-insert unknown voters into `pickems.players`. |
| **SCORE** | `score_at` | COLLECTED | Get results (§5). If they're incomplete or not final, alert the admin channel **once** and retry on later ticks. Otherwise set the winner per poll, grade picks, and post a results summary plus fresh standings (or let the 9:00 POST include them; see §8.4). |

**Late deploy / catch-up rule:** if a week's `post_at` has passed but its `lock_at` hasn't, post immediately. If `lock_at` has already passed and the week was never posted, mark it `skipped` and never post it.

**End of season:** after Week 17 is scored, post the final standings with a "🏆 2026 Pick'ems Champion" line, then set `leagues.active = false`.

---

## 5. Data sources

### 5.1 DFL regular-season pairings: `scdfl.matchups`

Facts about the table, verified Nov 9, 2026:
- Columns: `year, week, matchup_id, game_type, roster_id_a, roster_id_b, score_a, score_b, starters_*`.
- Weeks 1–14 of 2026 are fully populated with pairings (`game_type = 0`, `matchup_id` 1–7).
- **Unplayed weeks have `score_a = score_b = 0` (not null), and scores lag a manual sync. Never infer finality from this table.**
- Weeks 15–17 are **placeholder rows** (`game_type = -1`). Don't use them; playoffs come from Sleeper (§5.3).

Franchise names use the **season-aware join**. Quote the reserved words `"from"` and `"to"`, and note the text vs int type mismatch:

```sql
select m.matchup_id as slot,
       m.roster_id_a, fa.abbr as abbr_a, fa.name as name_a,
       m.roster_id_b, fb.abbr as abbr_b, fb.name as name_b
from scdfl.matchups m
join scdfl.franchises fa on fa.sleeper_id = m.roster_id_a::text
                        and m.year between fa."from" and coalesce(fa."to", 9999)
join scdfl.franchises fb on fb.sleeper_id = m.roster_id_b::text
                        and m.year between fb."from" and coalesce(fb."to", 9999)
where m.year = $1 and m.week = $2 and m.game_type = 0
order by m.matchup_id;
```

### 5.2 Bowl Game and Rivalry tags (visibility for special matchups)

`scdfl.spotlight_games (slug, name, type, team_a, team_b)` + `scdfl.spotlight_game_years (slug, year)`. `type` is `'bowl-game'` or `'rivalry'`, and `team_a`/`team_b` are franchise abbreviations. Tag a matchup when its abbreviation pair (in either order) matches a spotlight game active that year.
- **Rivalry:** only in the final regular-season week (week 14).
- **Bowl:** the regular-season meeting of that pair. In 2026, each bowl pair meets exactly once. If a pair ever meets twice, tag both and log a warning.

2026 tags, for test fixtures:

| Week | Tag | Matchup |
|---|---|---|
| 5 | Dominion Classic | TOR–VAN |
| 6 | Blue-Collar Classic | IQT–CHC |
| 7 | Animation Altercation | NNY–SAR |
| 8 | Cascade Cup | LOW–MIS |
| 9 | Gateway Cup | GLD–TBY |
| 10 | Atlantic Bowl | NFD–PEI |
| 11 | Atom Bowl | BKB–WPG |
| 14 | Rivalry Week (all 7) | IQT–PEI, NFD–TBY, MIS–NNY, VAN–WPG, CHC–TOR, GLD–SAR, BKB–LOW |

Use the spotlight game's `name` in the poll question (for example "Atom Bowl"). For Week 14, use "Rivalry Week" plus the rivalry `name` (for example "Rivalry Week · Stars vs Lasercats").

### 5.3 DFL playoff pairings (weeks 15–17): Sleeper brackets

- `GET https://api.sleeper.app/v1/league/{league_id}` → `settings.playoff_week_start` (expect 15). Bracket round `r` is played in week `playoff_week_start + r − 1`.
- `GET .../winners_bracket` and `.../losers_bracket` → arrays of `{ r, m, t1, t2, w, l, p, t1_from, t2_from }` where `t1`/`t2` are roster IDs (null until known) and `p` marks placement games (`p = 1` is the championship, `p = 3` third place, and so on).
- Include every bracket game in the current round where **both** `t1` and `t2` are known. Labels:
  - Winners bracket: round 1 → "Quarterfinal", round 2 → "Semifinal", the `p = 1` game → **"Dynasty Bowl VI"**, the `p = 3` game → "Third-Place Game", other `p` values → "{p}th-Place Game".
  - Losers bracket: "Consolation" (plus a placement label if `p` is present).
- Whether to include consolation games is a config flag (`leagues.include_consolation`, default **true**).
- **Test fixture:** the 2025 DFL league (`1185347458376470528`) has a complete bracket. Use it to unit-test labeling and round→week mapping before Week 15.
- Sleeper's shape for playoff weeks is the main external unknown. Verify it against the 2025 league early, and keep a fallback: if bracket parsing fails, alert the admin channel and let Zac enter pairings in `pickems.manual_matchups` (the manual source works for any league).

### 5.4 Results

**DFL (default `results_source = 'sleeper'`):**
- `GET https://api.sleeper.app/v1/league/{league_id}/matchups/{week}` → `[{ roster_id, matchup_id, points, ... }]`.
- Map `roster_id → points` and grade each poll by comparing its two roster IDs. Match by roster pair, not by `matchup_id`.
- **Finality guard:** run only at or after `score_at` (Tuesday 8:30 ET). If both teams in any polled matchup show 0 points, treat the results as not final, alert, and retry.
- An exact tie (equal points) makes the poll **void**: no one is credited or charged.
- Stat corrections: v1 scores once. The `rescore` admin action (§8.3) handles rare flips.

**`results_source = 'scdfl'`** (future, once `npm run sync:recent` is automated): read `score_a`/`score_b` from `scdfl.matchups`. Implement it behind the same interface but leave it switched off.

**EFL (`'manual'`):** `pickems.manual_matchups.winner_key`. If any winner is null at `score_at`, post one admin alert ("EFL Week N: enter winners in pickems.manual_matchups") and retry every tick until they're filled.

### 5.5 Sleeper etiquette

The API is public and needs no key. Keep calls minimal (a few per week). Use a 10 s fetch timeout with one retry.

---

## 6. Data model (`pickems` schema)

Enable RLS on every table and add **no** policies. The function connects as the database owner via `SUPABASE_DB_URL`, so nothing is exposed to the public API. Store Discord IDs ("snowflakes") as **`text`**: they exceed JS's safe integer range, so never parse them to `Number`.

```sql
create schema if not exists pickems;

create table pickems.leagues (
  key                 text primary key,            -- 'dfl' | 'efl'
  display_name        text not null,               -- 'Sixth City Dynasty' | 'Epsilon Fantasy League'
  short_name          text not null,               -- 'DFL' | 'EFL'
  season              int  not null,               -- 2026
  channel_id          text not null,               -- Discord channel snowflake (start with #bot-lab!)
  matchup_source      text not null check (matchup_source in ('scdfl','sleeper','manual')),
  results_source      text not null check (results_source in ('sleeper','scdfl','manual')),
  regular_season_weeks int not null default 14,
  include_consolation boolean not null default true,
  active              boolean not null default true
);

create table pickems.config (            -- small key/value store
  key text primary key, value text not null
);  -- rows: admin_channel_id, dry_run ('true'/'false')

create table pickems.calendar (
  season int, week int,
  post_at timestamptz not null, remind_at timestamptz not null,
  lock_at timestamptz not null, score_at timestamptz not null,
  primary key (season, week)
);

create table pickems.teams (             -- presentation layer for both leagues
  league_key text references pickems.leagues(key),
  team_key   text,                       -- DFL: Sleeper roster_id as text; EFL: abbr or ESPN id
  display_name text not null,            -- 'Bikini Bottom Stars'
  short_name   text,                     -- 'Stars'
  emoji_id     text,                     -- custom server emoji snowflake (nullable)
  primary key (league_key, team_key)
);

create table pickems.manual_matchups (   -- EFL weekly entry; also a fallback for DFL playoffs
  league_key text references pickems.leagues(key),
  season int, week int, slot int,
  team_a_key text not null, team_b_key text not null,
  label text,                            -- optional, e.g. 'Semifinal'
  winner_key text,                       -- fill after MNF; null until then
  primary key (league_key, season, week, slot)
);

create table pickems.players (
  discord_user_id text primary key,
  display_name    text not null          -- 'Ryan' (real names, set by Zac)
);

create table pickems.player_leagues (
  discord_user_id text references pickems.players,
  league_key text references pickems.leagues(key),
  remind boolean not null default true,  -- include in Thursday reminders
  primary key (discord_user_id, league_key)
);

create table pickems.weeks (             -- progress per league-week
  league_key text references pickems.leagues(key),
  season int, week int,
  posted_at timestamptz, reminded_at timestamptz, locked_at timestamptz,
  collected_at timestamptz, scored_at timestamptz,
  skipped boolean not null default false,
  standings_posted_at timestamptz,
  alert_sent_at timestamptz,             -- dedupe admin alerts
  last_error text,
  primary key (league_key, season, week)
);

create table pickems.polls (
  league_key text, season int, week int, slot int,
  team_a_key text not null, team_b_key text not null,
  label text,                            -- 'Atom Bowl' | 'Semifinal' | null
  message_id text unique,                -- null until posted
  answer_a_id int, answer_b_id int,      -- from Discord's response; don't assume 1/2
  winner_key text, is_void boolean not null default false,
  primary key (league_key, season, week, slot),
  foreign key (league_key, season, week) references pickems.weeks
);

create table pickems.picks (
  league_key text, season int, week int, slot int,
  discord_user_id text references pickems.players,
  pick_key text not null,                -- team_key picked
  is_correct boolean,                    -- null until scored; null if poll void
  primary key (league_key, season, week, slot, discord_user_id),
  foreign key (league_key, season, week, slot) references pickems.polls
);

create table pickems.carryover (         -- 2026 weeks 1–10 from Zac's spreadsheet
  league_key text, season int, discord_user_id text references pickems.players,
  correct int not null, incorrect int not null, through_week int not null,
  primary key (league_key, season, discord_user_id)
);

create table pickems.lease (             -- prevents overlapping ticks
  id int primary key default 1 check (id = 1),
  locked_until timestamptz not null default '-infinity'
);

create table pickems.runs (              -- debugging log
  id bigint generated always as identity primary key,
  started_at timestamptz default now(), finished_at timestamptz,
  action text, summary jsonb, error text
);
```

**`pickems.v_standings`**: per `(league_key, season, discord_user_id)`, carryover plus graded picks (`is_correct` not null). Columns: `display_name, correct, incorrect, pct = correct / nullif(correct + incorrect, 0), last_week_correct, last_week_total, rank`. Rank by `correct desc` using **competition ranking** (1, 2, 2, 4).

**Seeds:**
- `leagues`: dfl (`matchup_source = 'scdfl'`, `results_source = 'sleeper'`) and efl (`'manual'`, `'manual'`). Both `channel_id` values point at a private **#bot-lab** channel until go-live.
- `teams` for DFL from current `scdfl.franchises` (`"to" is null`). `emoji_id` values come from Zac.
- `teams` for EFL: Zac provides 14 names (and emoji if they exist).
- `calendar` (§4.1), `players` and `player_leagues` (Zac provides Discord IDs), `config`, and the `lease` row.

---

## 7. Discord integration

### 7.1 One-time setup (Zac, ~20 min; walk him through it)

1. **discord.com/developers/applications** → New Application (suggested name: "Commissioner's Office" or "Sixth City").
2. **Bot** tab → Reset Token → copy it once and store it immediately as a Supabase secret (§9). Turn **off** "Public Bot". **No privileged intents** are needed, because there's no gateway connection.
3. **OAuth2 → URL Generator**: scope `bot`. Permissions: View Channels, Send Messages, **Send Polls**, Embed Links, Read Message History, Use External Emojis (only if the team emoji live in another server). Open the URL and add the bot to the server.
4. Discord → User Settings → Advanced → **Developer Mode on**. Then right-click to Copy ID for channels (#pickems or whichever channel is used, a private #bot-lab, and a private #bot-admin for alerts) and users.
5. Custom emoji IDs: type `\:emoji_name:` in chat. It renders as `<:emoji_name:123456789>`, and the number is the ID.

### 7.2 Endpoints used (base `https://discord.com/api/v10`)

| Action | Method & path |
|---|---|
| Post message / poll | `POST /channels/{channel_id}/messages` |
| End a poll | `POST /channels/{channel_id}/polls/{message_id}/expire` |
| Re-fetch a message (poll results / `is_finalized`) | `GET /channels/{channel_id}/messages/{message_id}` |
| Voters for one answer | `GET /channels/{channel_id}/polls/{message_id}/answers/{answer_id}?limit=100&after={user_id}` (page until fewer than `limit` are returned) |

Headers: `Authorization: Bot ${DISCORD_BOT_TOKEN}`, `Content-Type: application/json`, `User-Agent: DiscordBot (https://sixthcitydfl.com, 1.0)`.

### 7.3 Poll rules (from Discord's docs)

- Question text ≤ **300** characters, text only (no custom emoji in the question).
- ≤ 10 answers. Answer text ≤ **55** characters, and each answer may carry an emoji: `{ id }` for custom, `{ name }` for unicode.
- `duration` is in **whole hours**, up to 32 days (default 24).
- **Polls can't be edited after creation.** Validate everything before posting.
- Results are only exact once `poll.results.is_finalized` is true, which happens shortly after a poll ends. Collect only then.
- A bot can only end its own polls.

Poll payload:

```json
{
  "nonce": "dfl-2026-11-3",
  "enforce_nonce": true,
  "poll": {
    "question": { "text": "Week 11 · Atom Bowl — Bikini Bottom Stars vs Winnipeg Wranglers" },
    "answers": [
      { "poll_media": { "text": "Bikini Bottom Stars", "emoji": { "id": "<BKB_EMOJI_ID>" } } },
      { "poll_media": { "text": "Winnipeg Wranglers",  "emoji": { "id": "<WPG_EMOJI_ID>" } } }
    ],
    "duration": 124,
    "allow_multiselect": false,
    "layout_type": 1
  }
}
```

- **`duration`** = ceil((lock_at − now) / 1 h). Discord then closes the poll at about lock time **even if the bot is down**. The LOCK step still calls `expire` for exact timing.
- **`nonce` + `enforce_nonce`**: deterministic per poll (`{league}-{season}-{week}-{slot}`, ≤ 25 chars). If a retry re-sends within a few minutes, Discord returns the original message instead of a duplicate. This is a second layer of protection on top of the DB check.
- Read `answer_id`s from the response (`message.poll.answers[].answer_id`) and store them.

### 7.4 Rate limits and errors

- Post sequentially with about 1 s between messages; 14 polls a week is tiny.
- On **429**, wait the JSON `retry_after` seconds and retry (max 3). On 5xx, retry with backoff (max 3).
- Never log the token or the full request headers.

### 7.5 Mentions

Reminders mention users with `<@USER_ID>` and set `"allowed_mentions": { "parse": [], "users": ["id1","id2"] }`, so only those people are pinged. This also makes `@everyone` impossible.

---

## 8. Edge Function design

### 8.1 Entry (`index.ts`)

- Accept `POST` only. Require the header `x-cron-secret` to equal the `CRON_SECRET` env var, otherwise return 401. Deploy with `verify_jwt = false`. The platform's JWT check doesn't understand Supabase's new non-JWT API keys, so authorization happens in code.
- Body: `{ "action": "tick" }` by default. See §8.3 for admin actions.
- Every invocation writes a `pickems.runs` row (action, summary of steps taken, error).

### 8.2 Tick algorithm

```
acquire lease:  update pickems.lease set locked_until = now() + interval '4 minutes'
                where id = 1 and locked_until < now() returning 1
                → if no row returned, exit (another tick is running)

for league in active leagues:
  for cal in calendar rows for league.season where post_at <= now() order by week:
    ensure pickems.weeks row exists
    run, in this order, every step that is due and whose prereqs are met:
      SCORE  (previous weeks first, so standings are current)
      POST   (applies the catch-up/skip rule from §4.2)
      REMIND
      LOCK
      COLLECT
    each step: do the work → set its *_at timestamp in the same transaction as its data writes
    on error: write weeks.last_error, alert the admin channel once per (league, week, step), continue with other leagues

release lease (set locked_until = now())
```

**Idempotency rules (non-negotiable):**
- POST: insert the `pickems.polls` rows first (message_id null). Post only rows with a null `message_id`, and write each `message_id` immediately after its own post succeeds, so a crash mid-week resumes where it stopped. The nonce covers the gap between "posted" and "recorded".
- LOCK: expiring an already-ended poll counts as success.
- COLLECT/SCORE: upserts only, so they're safe to re-run.
- Every step checks its own `*_at` before acting.

### 8.3 Admin actions (same endpoint and secret)

| Body | Effect |
|---|---|
| `{"action":"tick"}` | Normal run. |
| `{"action":"preview","league":"dfl","week":11}` | Build every message for that week and **return the JSON without posting**. Use this before every first-of-its-kind week (first live week, Rivalry Week, each playoff round). |
| `{"action":"rescore","league":"dfl","week":11}` | Re-fetch results, re-grade and repost standings (for stat corrections or manual fixes). |
| `{"action":"post-standings","league":"efl"}` | Repost current standings. |
| `{"action":"skip","league":"efl","week":12}` | Mark a week skipped. |

When `config.dry_run = 'true'`, all Discord writes go to the admin channel instead of league channels.

Zac can call these with `curl` or from the SQL editor with `net.http_post` (show him both).

### 8.4 Message plan per Tuesday (per league channel)

1. **Results recap** for last week, one line per matchup: winner, score, and how many picked the winner.
2. **Standings** (§10.1).
3. **Header**: "🏈 **DFL Week 11 Pick'ems**. Picks lock **Sunday 1:00 PM ET** (`<t:UNIX:F>`)". Discord's `<t:…>` timestamps render in each viewer's local time.
4. **One poll per matchup**, in slot order, with tagged games first in the order: Dynasty Bowl, playoff rounds, Rivalry, Bowl.

Messages 1–2 are produced by SCORE at 8:30 and 3–4 by POST at 9:00. If SCORE is blocked, POST adds a line to the header: "Week 10 standings pending."

---

## 9. Scheduling, secrets and keys

**Edge Function secrets** (`npx supabase secrets set ...`; never in the repo; `.env` files are git-ignored):
- `DISCORD_BOT_TOKEN`
- `CRON_SECRET`: a long random string, e.g. `openssl rand -hex 32`
- Built in, no action needed: `SUPABASE_DB_URL`

**Extensions to enable** (both are currently **not** installed on this project): `pg_cron`, `pg_net`.

**Vault + cron** (run once in the SQL editor):

```sql
select vault.create_secret('https://biukjccnbuhoxrhmwyhu.supabase.co', 'project_url');
select vault.create_secret('<same CRON_SECRET value>', 'pickems_cron_secret');

select cron.schedule('pickems-tick', '*/5 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/pickems',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pickems_cron_secret')
    ),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
```

Debugging: `select * from net._http_response order by created desc limit 20;` (responses are kept for 6 hours), plus `pickems.runs` and the Edge Function logs in the dashboard.

**Postgres client:** `import postgres from 'npm:postgres'` → `postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false })`. Use `prepare: false` because of the transaction pooler.

**Legacy API keys:** this design deliberately uses **no** Supabase API key (direct DB connection plus a custom cron secret). Supabase says the legacy `anon`/`service_role` keys keep working only until the end of 2026, which falls in the middle of the DFL playoffs, so the bot must not depend on them.

---

## 10. Message templates

### 10.1 Standings (code block for alignment, < 2,000 chars)

```
DFL PICK'EMS · THROUGH WEEK 11
 #  Player     W–L     Pct   Wk 11
 1  Ryan      58–19   .753   6–1
 2  Jacob     55–22   .714   5–2
 2  Josh      55–22   .714   7–0   ← perfect week
 4  ...
```

Below it: "Best week: Josh (7–0)".

### 10.2 Poll question

`Week {w}{ · {label}} — {Team A} vs {Team B}`. Fall back to `short_name` if the question would exceed 300 characters or an answer would exceed 55.

### 10.3 Reminder (Thursday)

"⏰ **Week 11 picks lock Sunday 1:00 PM ET** (`<t:UNIX:R>`). Still missing picks: <@id> (3 of 7), <@id> (0 of 7)"

Count picks per player from the live voter lists; include only `player_leagues.remind = true` players with fewer picks than polls. Live counts are approximate before finalization, which is fine for a reminder.

### 10.4 Lock (Sunday)

Default: **no message**; the polls visibly close on their own (see open questions).

### 10.5 Admin alerts (#bot-admin)

Short and actionable: "⚠️ EFL Week 11: winners missing in `pickems.manual_matchups` (slots 2, 5). Retrying every 5 min."

---

## 11. Scoring rules

- A correct pick earns 1 point. An incorrect pick earns 0 points and counts as a loss.
- A **missed** pick (no vote) earns 0 points and is **not** counted as a loss (default; see open questions). Ranking by total correct still penalizes missed picks.
- A void poll (tied score) counts for no one.
- Standings = `carryover` + graded picks for the season.
- Rank by `correct` desc. Ties share a rank (1, 2, 2, 4).

---

## 12. Testing and acceptance

**Unit tests (`deno test`, no network):**
- Calendar: seeded timestamps convert to the right ET wall-clock times, including one EDT week (e.g. Week 1) and one EST week (e.g. Week 12).
- Pairing and labeling: fixtures for Week 10 (Atlantic Bowl), Week 11 (Atom Bowl), Week 14 (7 rivalries), and playoff rounds from the **2025 bracket fixture**.
- Render: question/answer length limits, fallbacks, nonce ≤ 25 chars, standings ranking with ties.
- Reminder recipients: players with full, partial and zero picks, and opted-out players.
- Grading: win, loss, void, missing results → "not final".

**Integration (deployed, `dry_run = true` or channels set to #bot-lab):**
- `preview` for DFL Week 11 matches §5.1/§5.2 exactly.
- Run the full loop for **Week 10 in #bot-lab**: post → Zac and a friend vote → reminder Thursday → lock Sunday 1 PM → collect → score Tue Nov 17 against real Sleeper results. **Compare with Zac's manual Week 10 tally.**
- Kill-switch test: invoke `tick` twice concurrently → exactly one set of polls.
- Retry test: force an error after posting 3 of 7 polls → the next tick posts only the remaining 4.

**Acceptance (go-live gate):**
- [ ] Week 10 #bot-lab results match the manual tally.
- [ ] No secrets in git (`git grep` for the token prefix and `CRON_SECRET`).
- [ ] Carryover imported, and standings through Week 10 match the spreadsheet.
- [ ] `preview` for Week 15 (using the 2025 fixture) shows correct playoff labels.

---

## 13. Rollout timeline (2026)

| Date | Milestone |
|---|---|
| Tue Nov 10 | Week 10 runs **manually** (last fully manual week). Build starts: M0 setup, M1 schema/seeds. |
| Nov 11–15 | M2 clients and render, M3 tick plus admin actions, M4 deploy plus cron. Week 10 dry run in #bot-lab (late post is allowed by the catch-up rule). |
| Tue Nov 17 | Week 10 #bot-lab scored and compared with the manual tally. If they match: **Week 11 goes live** in the real channel for DFL and EFL. Zac keeps the spreadsheet in parallel for one more week. |
| Tue Nov 24 | Week 12 (Thanksgiving). Spreadsheet retired. |
| Tue Dec 1 – Dec 8 | Weeks 13–14 (Rivalry Week tags on Dec 8). Run `preview` for Week 15 against the live bracket once seeds are set. |
| Tue Dec 15 | **DFL playoffs**: Week 15 quarterfinals via Sleeper brackets. |
| Tue Jan 5, 2027 | Week 17 scored → Dynasty Bowl VI recap, final standings, 2026 Pick'ems champions. Set leagues inactive. |

---

## 14. Zac's manual checklist

- [ ] Create the Discord application and bot, invite it (§7.1), and create private #bot-lab and #bot-admin channels.
- [ ] Collect IDs: league channel(s), #bot-lab, #bot-admin, every participant's user ID (both leagues), and the 14 DFL team emoji IDs (plus EFL emoji, if any).
- [ ] Provide the EFL team list (names and keys).
- [ ] Export the 2026 spreadsheet (through Week 10) for the carryover import.
- [ ] Enable `pg_cron` and `pg_net` (Dashboard → Database → Extensions).
- [ ] `npx supabase login` → `npx supabase link --project-ref biukjccnbuhoxrhmwyhu`.
- [ ] Set secrets, create Vault entries and schedule cron (§9).
- [ ] Each Tuesday until EFL moves to Sleeper: enter EFL pairings for the new week and winners for the last week in `pickems.manual_matchups` (Table Editor).

---

## 15. Open questions (defaults in **bold**; build with the defaults and confirm with Zac)

1. Do DFL and EFL share one channel or have two? **Two channel IDs in config; they can be the same value.**
2. Should a missed pick count as a loss? **No, it's just no credit.** Confirm against how the spreadsheet does it.
3. Include consolation games in DFL playoff pick'ems? **Yes**, via a config flag.
4. Post a Sunday lock message? **No.**
5. Thursday when everyone has picked: post "all picks in ✅" or nothing? **Nothing.**
6. Show team records in poll answers, e.g. "Bikini Bottom Stars (8–3)"? **No in v1**; it's easy to add from Sleeper `/rosters` later.
7. Does the spreadsheet have per-week detail or only season totals? **Import totals.**

---

## 16. Phase 2 and later (design so these fit, don't build them now)

- **Coaches Poll**: owners submit a weekly top-5 ballot (5–4–3–2–1 points), ballots are public, and the computed Zacalytics ranking runs alongside. It needs a Discord **Interactions Endpoint URL** (an Edge Function that verifies Discord's Ed25519 signature and replies within 3 s) for the button and dropdowns. It reuses `players`, `calendar`, `discord.ts`, the lease and the runs log.
- **Website leaderboard**: add a `scdfl.v_pickem_standings` view with a read policy, then a page on sixthcitydfl.com.
- **EFL on Sleeper (2027)**: flip `efl.matchup_source` and `results_source` to `'sleeper'` and set its league ID. No code change.
- **Automated `scdfl` sync**: once it exists, flip DFL `results_source` to `'scdfl'`.
- Bowl/Rivalry holder Discord roles, series records in the poll header, upset-of-the-week.

---

## 17. Working notes for Claude Code

- Work on a feature branch off **`dev`** (repo convention: feature → `dev` → `main`). Commit in small, reviewable steps that follow the milestones.
- Before writing any `scdfl` query into code, **run it against the live database first** and show Zac the output. Repo SQL rules: query `scdfl`, not `public`; quote `"from"`/`"to"`; cast `roster_id::text` when joining franchises.
- Don't place markdown files under `src/pages/`.
- Keep `render.ts`, `calendar.ts` and grading logic **pure** (no I/O) so they can be tested without Discord.
- When something Discord-specific appears for the first time (snowflakes, nonces, `allowed_mentions`, poll finalization), add a one-paragraph explanation in a code comment for Zac.
- Ship a short `supabase/functions/pickems/README.md`: how to deploy, set secrets, run `preview`, rescore a week, enter EFL results, and pause the bot (`select cron.unschedule('pickems-tick');`).

---

## 18. Amendments from spec review (Nov 9, 2026) — these override earlier sections

1. **Scope: DFL only for v1.** EFL is out of scope. Keep the schema league-keyed (`league_key`) so EFL can be added later, but seed only `dfl`, skip the `manual` source/EFL admin flow, and don't build EFL alerts. §1 goals, §5.4 EFL, §14 EFL items and §10.5's EFL example are deferred.
2. **Voters:** non-league-participants picking is normal, not an anomaly. Anyone who votes is auto-inserted into `players` (and `player_leagues` for `dfl`) and ranked. Display name defaults to the Discord `global_name`/username from the voters response until Zac sets a real one. `remind = true` for everyone who has picked at least once this season (set on their first collected/live-seen pick); Thursday reminders mention anyone with `remind = true` who is missing ≥1 pick that week.
9. **Carryover skipped for now.** Testing is sandbox-only, so no spreadsheet import; `pickems.carryover` stays empty (keep the table and view logic so it can be loaded later).
10. **Missed pick = not scored at all** for that user (no win, no loss; matches §11 default).
11. **Lock is always Sunday 1:00 PM ET** (`America/New_York`; EST for all remaining 2026 weeks) regardless of TNF, international, Thanksgiving/Black Friday, Christmas or other earlier games. Drop the §4.1 "move lock_at for international games" pre-go-live step; seed the calendar as written.
3. **Tuesday flow:** keep two stages. SCORE (8:30) posts recap + standings once, guarded by `standings_posted_at`. POST (9:00) posts header + polls, and adds standings only if scoring was blocked ("pending" line otherwise).
4. **Week 10:** lab run in #bot-lab for validation only. `v_standings` counts graded picks only where `week > carryover.through_week`, so Week 10 is never double-counted with the spreadsheet carryover.
5. **Playoff labels (fix to §5.3):** label by origin, not round number. A winners-bracket game with either `t1_from`/`t2_from` key = `l` is a placement-path game (not a "Semifinal"); labels: `p=1` Dynasty Bowl VI, `p=3` Third-Place, `p=5` 5th-Place, etc. Verified against the 2025 bracket (round 3 has p=1, 3, 5; round 2 has an extra loser-vs-loser game). Unit-test with the 2025 fixture.
6. **Empty pairings at POST time** (e.g. Sleeper hasn't advanced the bracket): alert the admin channel once, retry every tick until `lock_at`, then mark `skipped`.
7. **Dynasty Bowl numeral:** duplicate `toRoman` in the function (it can't safely import `src/lib/format.ts`), with a comment pointing at the original.
8. **Docs/tooling:** this file moves to `docs/pickems-bot-spec.md`. Local `deno` and `supabase` CLI aren't installed; the first session installs them (or deploys via the dashboard) before M4. `pg_cron` and `pg_net` are not yet enabled; `vault` already is.
12. **Discord IDs (sandbox).** `#bot-lab` = `1569485776968745070` → `leagues.channel_id` for `dfl`. `#bot-admin` = `1569486062512775189` → `config.admin_channel_id`. Store as `text`. Keep `dry_run` semantics from §8.3. No player IDs, guild ID or custom emoji IDs are needed up front (voters are read from Discord; see item 2). The bot token is never pasted in chat or committed; Zac sets it via `npx supabase secrets set DISCORD_BOT_TOKEN=...`.
13. **Team emoji are standard Unicode emoji, not custom server emoji.** Replace `teams.emoji_id` with `teams.emoji text` holding the character. Poll answers use `"emoji": { "name": "🚂" }` (not `{ "id": ... }`); no "Use External Emojis" permission is required. Mapping, keyed by nickname (fuzzy/suffix-match the nickname against `scdfl.franchises.name` where `"to" is null`; all 14 verified to match uniquely) and seeded per `abbr`:

| abbr | Nickname | Emoji | Discord shortcode |
|---|---|---|---|
| BKB | Stars | 🍍 | `:pineapple:` |
| CHC | Railfans | 🚂 | `:steam_locomotive:` |
| GLD | Sharks | 🦈 | `:shark:` |
| IQT | Trout | 🐟 | `:fish:` |
| LOW | Lasercats | 🐱 | `:cat:` |
| MIS | Mastodons | 🦣 | `:mammoth:` |
| NFD | Blowers | 🫎 | `:moose:` |
| NNY | Benders | 🤖 | `:robot:` |
| PEI | Islanders | 🛥️ | `:motorboat:` |
| SAR | SeaSnakes | 🐍 | `:snake:` |
| TBY | Mustangs | 🐴 | `:horse:` |
| TOR | Hogs | 🐗 | `:boar:` |
| VAN | Mounties | 🚓 | `:police_car:` |
| WPG | Wranglers | 🏇 | `:horse_racing:` |

14. **Emoji placement and message layout follow the original spec** (§7.3 poll payload, §10 templates): each poll answer carries its own team's emoji and nickname/name, and matchup order carries no meaning. There is no mirrored left/right emoji layout in text lines; plain-text lines (header, recap, reminders) may show a team's emoji beside its name, but placement is not significant. Zac's earlier pasted pairings were purely illustrative.

---

## 19. Build footnotes (added during the Nov 2026 build)

1. **Migration-ledger divergence (discovered applying M1, Nov 9 2026).** The remote project's `supabase_migrations.schema_migrations` table holds 28 versions (`20260402180203` … `20260824181808`) from earlier `scdfl` work that was applied outside this repo (dashboard / MCP), and those versions have no corresponding files in `supabase/migrations/`. Consequence: `supabase db push --remote` fails with `DbPushMissingLocalError` and will keep failing until the histories are reconciled. The pick'ems migrations were therefore applied through the Supabase MCP connection (recorded remotely as `pickems_schema` / `pickems_seed`); the files in `supabase/migrations/` are the source of truth and contain exactly the SQL that ran. If CLI pushes are ever wanted, reconcile first — either `supabase db pull --remote` (dumps the whole existing schema into a baseline migration) or `supabase migration repair` per the CLI's suggestion. Until then, treat `db push` errors on this project as expected and pre-existing, not as a pick'ems problem.

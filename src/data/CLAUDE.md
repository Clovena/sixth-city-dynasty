# CLAUDE.md — Supabase Schema Reference (`scdfl`)

All SCDFL league data lives in the `scdfl` schema in Supabase. This file documents table shapes, relationships, constraints, and maintenance processes. For the full DDL, see `SUPABASE_DEFINITIONS.sql` at the project root.

---

## Client Access

**Build-time (Astro pages):** `src/lib/supabase.ts` — uses `SUPABASE_ANON_KEY` via `import.meta.env`
```ts
import { supabase } from '../lib/supabase';
const { data } = await supabase.schema('scdfl').from('franchises').select('*');
```

**Sync scripts:** Each script in `scripts/lib/` creates its own client using `SUPABASE_SERVICE_KEY` (write access).

**All queries must use `.schema('scdfl')`** — tables are not in the `public` schema.

---

## Tables

### `franchises`
**Maintenance:** Manual
**PK:** `(id, "from")` — composite; same `id` can appear with different era ranges
**Unique index:** `abbr` — globally unique across all eras

Franchise identity records. Uses a temporal model: one row per identity era. Active franchises have `"to" IS NULL`. Historical identities (rebrands, predecessor teams) have a non-null `"to"`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer | Numeric franchise ID (1–14); equals Sleeper `roster_id` |
| `sleeper_id` | text | String version of `id` — used as join key to `results` |
| `abbr` | text | Three-letter abbreviation (e.g., `TOR`, `BKB`); also logo filename |
| `name` | text | Full franchise name |
| `owner` | text | Current owner name |
| `conf` | text | Conference: `'SCC'` or `'HCC'` |
| `colors` | text[] | Array of hex color codes (primary, secondary, tertiary) |
| `"from"` | integer | First year this identity is active (reserved word — always quote) |
| `"to"` | integer | Last year this identity was active; `NULL` = still active (reserved word — always quote) |

**Common queries:**
```sql
-- Active franchises only
SELECT * FROM scdfl.franchises WHERE "to" IS NULL ORDER BY id;

-- Franchise identity for a specific year
SELECT * FROM scdfl.franchises WHERE "from" <= 2025 AND ("to" >= 2025 OR "to" IS NULL);

-- Lookup by abbreviation (current)
SELECT * FROM scdfl.franchises WHERE abbr = 'TOR' AND "to" IS NULL;
```

---

### `seasons`
**Maintenance:** Manual
**PK:** `year`

Per-season metadata. One row per SCDFL season.

| Column | Type | Notes |
|--------|------|-------|
| `year` | integer | Season year (e.g., 2025) |
| `league_id` | text | Sleeper league ID for this season |
| `regular_season_weeks` | integer | Number of regular season weeks (default 14) |
| `playoff_teams` | integer | Number of playoff teams (default 7) |
| `scc_champion` | text | SCC conference champion franchise `abbr` |
| `hcc_champion` | text | HCC conference champion franchise `abbr` |
| `charity` | text | Charity associated with this season |
| `retreat_location` | text | Annual retreat location |

**Current season** is derived as `MAX(year)` from this table — there is no explicit "current" flag.

---

### `results`
**Maintenance:** `npm run sync:results` (API fields) + manual (`playoff`, `seed`, `finish`)
**PK:** `(sleeper_id, year)`
**FK:** `year → seasons(year)`

Per-franchise, per-season aggregate stats.

| Column | Type | Notes |
|--------|------|-------|
| `sleeper_id` | text | Franchise identifier (joins to `franchises.sleeper_id`) |
| `year` | integer | Season year |
| `wins` | integer | Regular season wins |
| `losses` | integer | Regular season losses |
| `ties` | integer | Regular season ties |
| `points_for` | numeric | Total points scored |
| `points_against` | numeric | Total points allowed |
| `playoff` | boolean | Whether the franchise made playoffs |
| `seed` | integer | Playoff seed (null if missed playoffs) |
| `finish` | text | Final placement description (e.g., `'Champion'`, `'Runner-up'`, `'Consolation winner'`) |

**Sync behavior:** `sync:results` only writes `sleeper_id`, `year`, `wins`, `losses`, `ties`, `points_for`, `points_against`. The `playoff`, `seed`, and `finish` columns are commissioner-maintained and preserved across upserts.

---

### `matchups`
**Maintenance:** `npm run sync:matchups`
**PK:** `(year, week, matchup_id)`
**FK:** `year → seasons(year)`

All weekly matchups across all seasons. Each row is one game (two teams).

| Column | Type | Notes |
|--------|------|-------|
| `year` | integer | Season year |
| `week` | integer | Week number (1–17) |
| `matchup_id` | integer | Sleeper's matchup pairing ID |
| `game_type` | smallint | `0` = regular season, `1` = playoff (winners bracket), `-1` = consolation |
| `roster_id_a` | integer | Team A roster ID (always the lower ID of the pair) |
| `roster_id_b` | integer | Team B roster ID |
| `score_a` | numeric | Team A score (null if unplayed) |
| `score_b` | numeric | Team B score |
| `starters_a` | text[] | Team A starter player IDs in display order |
| `starter_points_a` | numeric[] | Team A starter points in corresponding order |
| `starters_b` | text[] | Team B starter player IDs |
| `starter_points_b` | numeric[] | Team B starter points |

**`game_type` classification:** Determined by `sync-matchups.ts` using playoff seed data from `results`. Weeks after `regular_season_weeks` are classified by tracking which teams remain in the winners bracket.

**Score resolution:** `custom_points` (from Sleeper) takes precedence over `points`. Unplayed games (0 points, no starters) are stored as `null`.

**Row count:** ~580 rows across all seasons.

---

### `rosters`
**Maintenance:** `npm run sync:rosters`
**PK:** `player_id`
**FK:** `player_id → players(player_id)`

Current-season roster assignments. One row per player-to-franchise assignment.

| Column | Type | Notes |
|--------|------|-------|
| `player_id` | text | Sleeper player ID |
| `sleeper_id` | integer | Franchise roster ID (1–14) |

**Sync strategy:** Full replacement — all rows are deleted, then fresh data inserted. This ensures dropped players are removed.

**Important:** This is current-snapshot only. There is no historical roster table.

---

### `transactions`
**Maintenance:** `npm run sync:transactions`
**PK:** `id` (serial)
**Natural key:** `(transaction_id, roster_id, action, asset, player_id, pick_season, pick_round, pick_original_roster_id)`
**FK:** `year → seasons(year)`

All asset movements across all seasons. One row per add/drop per team side — trades are exploded into multiple rows grouped by `transaction_id`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial | Auto-increment surrogate PK |
| `transaction_id` | text | Sleeper transaction ID (groups related movements) |
| `year` | integer | Season year |
| `week` | integer | Week number |
| `type` | text | `'trade'`, `'waiver'`, `'free_agent'`, `'commissioner'` |
| `status` | text | `'complete'` or `'failed'` |
| `roster_id` | integer | Which franchise performed this action |
| `action` | text | `'add'` or `'drop'` |
| `asset` | text | `'player'` or `'pick'` |
| `player_id` | text | Sleeper player ID (null if asset is a pick) |
| `pick_season` | integer | Draft pick season (null if asset is a player) |
| `pick_round` | integer | Draft pick round |
| `pick_original_roster_id` | integer | Who originally held the draft pick |
| `waiver_bid` | integer | FAAB bid amount (waivers only) |
| `created` | bigint | Unix timestamp (ms) from Sleeper |

**Row count:** ~5,700 rows. Use explicit `.limit()` or pagination for full-table reads.

---

### `players`
**Maintenance:** `npm run sync:players`
**PK:** `player_id`

Sleeper player metadata. Contains all ~20,000+ NFL players from Sleeper's database.

| Column | Type | Notes |
|--------|------|-------|
| `player_id` | text | Sleeper player ID |
| `first_name` | text | First name |
| `last_name` | text | Last name |
| `position` | text | Primary position |
| `fantasy_positions` | text[] | All fantasy-eligible positions |
| `team` | text | Current NFL team |
| `status` | text | Active, Inactive, etc. |
| `age` | integer | Current age |
| `years_exp` | integer | Years of NFL experience |
| `number` | integer | Jersey number |
| `height` | text | Height |
| `weight` | text | Weight |
| `college` | text | College |
| `espn_id` | text | ESPN player ID (partial coverage) |
| ... | ... | Additional metadata (see `SUPABASE_DEFINITIONS.sql` for full list) |

---

### `player_ids`
**Maintenance:** `npm run sync:pids`
**PK:** `sleeper_id`
**FK:** `sleeper_id → players(player_id)`
**Index:** `gsis_id`

DynastyProcess player ID crosswalk. Supplements Sleeper data with platform IDs.

| Column | Type | Notes |
|--------|------|-------|
| `sleeper_id` | text | Sleeper player ID (FK to `players`) |
| `espn_id` | text | ESPN player ID (better coverage than Sleeper's) |
| `mfl_id` | text | MyFantasyLeague ID |
| `fantasypros_id` | text | FantasyPros ID |
| `pff_id` | text | Pro Football Focus ID |
| `pfr_id` | text | Pro Football Reference ID |
| `ktc_id` | text | KeepTradeCut ID |
| `rotowire_id` | integer | Rotowire ID |
| `yahoo_id` | integer | Yahoo ID |
| `gsis_id` | text | NFL GSIS ID — **join key to `nfl_stats`** |

---

### `v_players` (view)

Joins `players` + `player_ids`, coalescing IDs that exist in both sources (ESPN, Rotowire, Yahoo — Sleeper values used as fallback, DynastyProcess values preferred). Use this view for any query needing `espn_id` (headshot URLs) or `gsis_id` (stats joins).

```ts
// ESPN headshot URL pattern
const url = `https://a.espncdn.com/i/headshots/nfl/players/full/${espn_id}.png`;
```

---

### `drafts`
**Maintenance:** Manual
**PK:** `draft_id`
**FK:** `year → seasons(year)`

Draft configuration. One row per draft event.

| Column | Type | Notes |
|--------|------|-------|
| `draft_id` | text | Sleeper draft ID |
| `year` | integer | Season year |
| `type` | text | `'startup'`, `'rookie'`, or `'idp'` |

---

### `draft_results`
**Maintenance:** `npm run sync:drafts`
**PK:** `(draft_id, pick_no)`
**FK:** `draft_id → drafts(draft_id)`, `player_id → players(player_id)`
**Indexes:** `player_id`, `roster_id`, `(draft_id, draft_slot)`

All draft picks across all drafts.

| Column | Type | Notes |
|--------|------|-------|
| `draft_id` | text | Which draft this pick belongs to |
| `pick_no` | integer | Overall pick number (1-indexed) |
| `round` | integer | Draft round |
| `draft_slot` | integer | Column on draftboard (1–14) |
| `roster_id` | integer | Who actually made the pick (after trades) |
| `original_roster_id` | integer | Who originally held this draft slot (before trades) |
| `player_id` | text | Player selected |

**Note:** `original_roster_id` replaces the old `draft-slots.json` file. Slot ownership is resolved at sync time from Sleeper's draft metadata endpoint.

---

### `exhibitions`
**Maintenance:** Manual
**PK:** `id` (serial)
**Unique:** `(league_id, year, week)`
**FK:** `year → seasons(year)`

Exhibition game configuration.

| Column | Type | Notes |
|--------|------|-------|
| `id` | serial | Auto-increment ID (FK target for `exhibition_matchups`) |
| `year` | integer | Season year |
| `week` | integer | Week number |
| `league_id` | text | Sleeper league ID for this exhibition |
| `exhib_type` | text | `'tagteam'` or `'onevsall'` |
| `team_id_a` | integer | Sleeper roster ID in exhibition league (NOT franchise.id) |
| `team_a_members` | text[] | Franchise abbreviations for team A |
| `team_a_slug` | text | URL slug component |
| `team_a_display_name` | text | Display label |
| `team_id_b` | integer | Sleeper roster ID in exhibition league |
| `team_b_members` | text[] | Franchise abbreviations for team B |
| `team_b_slug` | text | URL slug component |
| `team_b_display_name` | text | Display label |

---

### `exhibition_matchups`
**Maintenance:** `npm run sync:exhibitions`
**PK:** `exhibition_id`
**FK:** `exhibition_id → exhibitions(id)`

Exhibition game results (one-to-one with `exhibitions`).

| Column | Type | Notes |
|--------|------|-------|
| `exhibition_id` | integer | FK to `exhibitions.id` |
| `score_a` | numeric | Team A score |
| `score_b` | numeric | Team B score |
| `starters_a` | text[] | Team A starter player IDs |
| `starter_points_a` | numeric[] | Team A starter points |
| `starters_b` | text[] | Team B starter player IDs |
| `starter_points_b` | numeric[] | Team B starter points |

---

### `spotlight_games`
**Maintenance:** Manual
**PK:** `slug`

Spotlight game definitions (bowl games and rivalries).

| Column | Type | Notes |
|--------|------|-------|
| `slug` | text | URL slug (e.g., `'dynasty-bowl'`, `'i-90-rivalry'`) |
| `name` | text | Display name |
| `type` | text | `'bowl-game'` or `'rivalry'` |
| `team_a` | text | Franchise `abbr` |
| `team_b` | text | Franchise `abbr` |

---

### `spotlight_game_years`
**Maintenance:** Manual
**PK:** `(slug, year)`
**FK:** `slug → spotlight_games(slug)`, `year → seasons(year)`

Which years each spotlight game occurs. Join to `spotlight_games` on `slug`.

| Column | Type | Notes |
|--------|------|-------|
| `slug` | text | FK to `spotlight_games` |
| `year` | integer | Season year this game occurs |

**Note:** This is a structural change from the old JSON — the flat list with `year_established` is now a proper many-to-many between games and years. Every query for spotlight games requires this join.

---

### `nfl_stats`
**Maintenance:** `npm run sync:stats`
**PK:** `(gsis_id, season, week)`
**Indexes:** `(season, week)`, `gsis_id`

Weekly NFL player stats from nflverse.

| Column | Type | Notes |
|--------|------|-------|
| `gsis_id` | text | NFL GSIS player ID — join to `player_ids.gsis_id` |
| `season` | integer | NFL season year |
| `week` | integer | NFL week number |
| `season_type` | text | `'REG'` or `'POST'` |
| `pass_att`, `pass_comp`, `pass_yds`, `pass_tds` | various | Passing stats |
| `rush_att`, `rush_yds`, `rush_tds` | various | Rushing stats |
| `targets`, `receptions`, `rec_yds`, `rec_tds` | various | Receiving stats |
| `fg_att`, `fg_made`, `fg_yds` | various | Kicking stats |
| `fumbles`, `fum_lost` | various | Fumble stats |
| `solo_tkl`, `asst_tkl`, `tfl`, `qb_hit`, `pass_defended`, `sack`, `interception`, `forced_fumble`, `fumble_recovery`, `safety`, `idp_td` | various | IDP stats |

**Row count:** ~95,000. Always paginate or batch when reading.

---

### `accolades`
**Maintenance:** Manual
**PK:** `(year, award_code)`
**FK:** `player_id → players(player_id)`, `year → seasons(year)`

Annual league awards.

| Column | Type | Notes |
|--------|------|-------|
| `year` | integer | Season year |
| `award_code` | text | Award identifier (e.g., `'mvp'`, `'trade_of_year'`) |
| `award_desc` | text | Human-readable award name |
| `player_id` | text | Awarded player (exactly one of player_id/sleeper_id/transaction_id must be non-null) |
| `sleeper_id` | text | Awarded franchise |
| `transaction_id` | text | Awarded transaction |
| `vote_share` | numeric | Vote share (0–1, optional) |
| `total_votes` | integer | Total votes cast (optional, must be > 0 if present) |

**Constraint:** Exactly one of `player_id`, `sleeper_id`, or `transaction_id` must be non-null per row.

---

## Relationships

```
seasons (year) ──────────┬──→ results.year
                         ├──→ matchups.year
                         ├──→ transactions.year
                         ├──→ drafts.year
                         ├──→ exhibitions.year
                         ├──→ spotlight_game_years.year
                         ├──→ accolades.year
                         └──→ nfl_stats (no FK; joined via season = year)

franchises.sleeper_id ───┬──→ results.sleeper_id (text join)
                         └──→ matchups.roster_id_a / roster_id_b (cast to int)

players (player_id) ─────┬──→ rosters.player_id
                         ├──→ draft_results.player_id
                         ├──→ player_ids.sleeper_id
                         └──→ accolades.player_id

player_ids.gsis_id ──────┬──→ nfl_stats.gsis_id (no FK; application-level join)

drafts (draft_id) ───────┬──→ draft_results.draft_id

spotlight_games (slug) ──┬──→ spotlight_game_years.slug

exhibitions (id) ────────┬──→ exhibition_matchups.exhibition_id
```

---

## Maintenance Processes

### Weekly during NFL season
1. `npm run sync` — runs all 7 routine syncs (results → matchups → rosters → transactions → drafts → exhibitions → stats)

### A few times per season
1. `npm run sync:player-meta` — refreshes player database and ID crosswalk
   - Must run `sync:players` before `sync:pids` (FK dependency)
   - Sleeper rate-limits `/players/nfl` to ≤ 1 call/day

### Commissioner tasks (manual SQL or Supabase dashboard)
- **New season:** Insert row into `seasons` with league_id and playoff config
- **Franchise rebrand:** Close current identity (`SET "to" = year`), insert new identity row
- **Playoff results:** Update `results` rows with `playoff`, `seed`, `finish` values
- **New draft:** Insert row into `drafts` with draft_id, then run `sync:drafts`
- **New exhibition:** Insert row into `exhibitions` with config, then run `sync:exhibitions`
- **Spotlight games:** Insert/update `spotlight_games` + `spotlight_game_years`
- **Conference champions:** Update `seasons` row with `scc_champion`, `hcc_champion`
- **Accolades:** Insert rows into `accolades` after season awards are determined

### Data freshness summary

| Table | Source | Sync Command | Cadence |
|-------|--------|-------------|---------|
| `franchises` | Manual | — | On rebrand/adoption |
| `seasons` | Manual | — | Once per new season |
| `results` | Sleeper API + manual | `sync:results` | Weekly (API); post-season (manual) |
| `matchups` | Sleeper API | `sync:matchups` | Weekly |
| `rosters` | Sleeper API | `sync:rosters` | Weekly |
| `transactions` | Sleeper API | `sync:transactions` | Weekly |
| `drafts` | Manual | — | Once per draft |
| `draft_results` | Sleeper API | `sync:drafts` | Once per draft |
| `exhibitions` | Manual | — | When scheduled |
| `exhibition_matchups` | Sleeper API | `sync:exhibitions` | When exhibitions occur |
| `spotlight_games` | Manual | — | On creation/update |
| `spotlight_game_years` | Manual | — | Once per season |
| `nfl_stats` | nflverse CSV | `sync:stats` | Weekly |
| `players` | Sleeper API | `sync:players` | A few times/season |
| `player_ids` | DynastyProcess CSV | `sync:pids` | A few times/season |
| `accolades` | Manual | — | Post-season |

---

## Supabase Client Notes

- **Row limit:** Supabase JS client defaults to 1,000 rows. Use `.limit(n)` for tables with many rows.
- **Reserved words:** `"from"` and `"to"` in `franchises` must be quoted in raw SQL. The JS client handles this automatically.
- **Schema:** Always use `.schema('scdfl')` — nothing is in the `public` schema.
- **Anon vs service key:** Astro pages use the anon key (read-only). Sync scripts use the service key (read-write).

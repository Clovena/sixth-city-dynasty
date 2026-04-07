# CLAUDE.md — Supabase Sync Scripts

Data sync pipeline for the SCDFL site. Standalone TypeScript scripts that fetch from the Sleeper API (and other external sources) and upsert directly into Supabase (schema `scdfl`).

---

## Usage

All scripts are run via `npx tsx` and configured as npm scripts in the root `package.json`.

```bash
# Routine syncs — run weekly during the NFL season
npm run sync              # all 7 routine syncs sequentially
npm run sync:results      # npx tsx scripts/lib/sync-results.ts
npm run sync:matchups     # npx tsx scripts/lib/sync-matchups.ts
npm run sync:rosters      # npx tsx scripts/lib/sync-rosters.ts
npm run sync:transactions # npx tsx scripts/lib/sync-transactions.ts
npm run sync:drafts       # npx tsx scripts/lib/sync-drafts.ts
npm run sync:exhibitions  # npx tsx scripts/lib/sync-exhibitions.ts
npm run sync:stats        # npx tsx scripts/lib/sync-stats.ts

# Player metadata — run sparingly (heavyweight external calls)
npm run sync:players      # npx tsx scripts/lib/sync-players.ts
npm run sync:pids         # npx tsx scripts/lib/sync-pids.ts
npm run sync:player-meta  # sync:players then sync:pids sequentially
```

---

## Environment

All scripts use `dotenv/config` and require:
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — service role key (NOT the anon key; needed for write access)

These are distinct from the Astro build-time env vars (`SUPABASE_ANON_KEY`) used by `src/lib/supabase.ts`.

---

## Scripts

### `sync-results.ts`

**Source:** Sleeper `/league/{league_id}/rosters` endpoint (one call per season)
**Target:** `scdfl.results`
**Upsert key:** `(sleeper_id, year)`

Fetches all seasons from `scdfl.seasons`, calls the Sleeper rosters endpoint for each, and extracts win/loss/points stats per franchise. Points are assembled from Sleeper's split integer+decimal format (`fpts` + `fpts_decimal`).

**Fields written:** `sleeper_id`, `year`, `wins`, `losses`, `ties`, `points_for`, `points_against`
**Fields NOT written (manual):** `playoff`, `seed`, `finish` — preserved across upserts by Supabase's upsert semantics (only specified columns are updated)

---

### `sync-matchups.ts`

**Source:** Sleeper `/league/{league_id}/matchups/{week}` endpoint (weeks 1–17 per season)
**Target:** `scdfl.matchups`
**Upsert key:** `(year, week, matchup_id)`

The most complex sync script. For each season:
1. Fetches all 17 weeks of matchup data from Sleeper
2. Pairs roster entries by `matchup_id` (lower `roster_id` is always `_a`)
3. Classifies game type:
   - Weeks 1–`regular_season_weeks`: `game_type = 0` (regular season)
   - Playoff weeks: uses seed data from `scdfl.results` to track a "winners alive" set
     - Both teams in winners bracket → `game_type = 1` (playoff)
     - Otherwise → `game_type = -1` (consolation)
4. Resolves scores: `custom_points` takes precedence over `points`; unplayed games (0 points, no starters) → `null`

**Starters data:** `starters_a[]`, `starter_points_a[]`, `starters_b[]`, `starter_points_b[]` are stored as PostgreSQL arrays for lineup display on game recap pages.

---

### `sync-rosters.ts`

**Source:** Sleeper `/league/{league_id}/rosters` endpoint (current season only)
**Target:** `scdfl.rosters`
**Write strategy:** Full replace (DELETE all → INSERT)

Fetches the most recent season from `scdfl.seasons` (by `MAX(year)`), calls the Sleeper rosters endpoint, and flattens `roster.players[]` into one row per `(player_id, sleeper_id)`.

**Prerequisite:** `scdfl.players` must be populated first (`sync:players`) — FK constraint on `player_id`.

**Note:** This is current-snapshot only. There is no historical roster table. If a page needs historical rosters, that requires a different approach.

---

### `sync-transactions.ts`

**Source:** Sleeper `/league/{league_id}/transactions/{week}` endpoint (weeks 1–17 per season)
**Target:** `scdfl.transactions`
**Upsert key:** `(transaction_id, roster_id, action, asset, player_id, pick_season, pick_round, pick_original_roster_id)`

Explodes each Sleeper transaction into one row per asset movement per team side:
- `adds` map → rows with `action = 'add'`
- `drops` map → rows with `action = 'drop'`
- `draft_picks` → rows with `asset = 'pick'` (includes `pick_season`, `pick_round`, `pick_original_roster_id`)

Trades produce multiple rows grouped by `transaction_id`. Commissioner reversals are new transactions with new IDs — they don't modify existing rows.

---

### `sync-drafts.ts`

**Source:** Sleeper `/draft/{draft_id}` (metadata) + `/draft/{draft_id}/picks` (picks)
**Target:** `scdfl.draft_results`
**Upsert key:** `(draft_id, pick_no)`
**Config:** Reads draft IDs from `scdfl.drafts` table (manually maintained)

For each draft:
1. Fetches draft metadata to get `slot_to_roster_id` mapping (resolves `draft_slot` → `original_roster_id`)
2. Fetches all picks
3. Shapes each pick into: `draft_id`, `pick_no`, `round`, `draft_slot`, `roster_id` (who picked), `original_roster_id` (who originally held the slot), `player_id`

This replaces the old `draft-slots.json` + `draft-config.json` + raw draft JSON approach. The `original_roster_id` field captures slot ownership directly in `draft_results`.

---

### `sync-exhibitions.ts`

**Source:** Sleeper `/league/{league_id}/matchups/{week}` endpoint (per exhibition)
**Target:** `scdfl.exhibition_matchups`
**Upsert key:** `exhibition_id` (one-to-one with `scdfl.exhibitions`)
**Config:** Reads exhibition configuration from `scdfl.exhibitions` table (manually maintained)

For each exhibition config row:
1. Calls `getMatchups(league_id, week)` on the exhibition's Sleeper league
2. Filters to only the two roster entries matching `team_id_a` and `team_id_b` (exhibition leagues have many empty placeholder slots)
3. Pairs team A and team B, extracts scores + starters
4. Upserts into `exhibition_matchups`

**Note:** Exhibition `roster_id` values do NOT map to `franchises.id` — they belong to separate Sleeper leagues. The `exhibitions` config table provides the team identity mapping.

---

### `sync-stats.ts`

**Source:** nflverse GitHub releases (`stats_player_week_{year}.csv`)
**Target:** `scdfl.nfl_stats`
**Upsert key:** `(gsis_id, season, week)`

Fetches weekly NFL player stats CSVs from the nflverse-data GitHub repository for each year in `scdfl.seasons`. Parses CSV, extracts rushing/passing/receiving/kicking/IDP stats, and upserts in batches of 500.

Preserves both REG and POST season_type rows. Gracefully skips future seasons (nflverse returns "Not found"). Safe for re-runs and mid-season refreshes.

**Row count:** ~95,000 rows across all seasons. Always uses batched upserts.

---

### `sync-players.ts`

**Source:** Sleeper `/players/nfl` endpoint (~5MB JSON payload, ~20k+ players)
**Target:** `scdfl.players`
**Upsert key:** `player_id`

Fetches the full Sleeper player database and upserts all players in batches of 500. This is a heavyweight call — **Sleeper requests it be called no more than once per day.**

Run cadence: a few times per season. Always run this before `sync:pids` (FK dependency).

---

### `sync-pids.ts`

**Source:** DynastyProcess player ID crosswalk CSV (GitHub)
**Target:** `scdfl.player_ids`
**Upsert key:** `sleeper_id`

Supplements the Sleeper player data with platform IDs from DynastyProcess: ESPN, MFL, FantasyPros, PFF, PFR, KTC, Rotowire, Yahoo, GSIS. The `gsis_id` field is critical — it's the join key to `nfl_stats`.

Only upserts rows where `sleeper_id` exists in `scdfl.players` (FK enforced). Run after `sync:players`.

---

## Data Flow

```
External Sources                    Supabase (scdfl schema)
─────────────────                   ──────────────────────
Sleeper /rosters      ──→  sync-results.ts       ──→  results
Sleeper /matchups     ──→  sync-matchups.ts      ──→  matchups
Sleeper /rosters      ──→  sync-rosters.ts       ──→  rosters
Sleeper /transactions ──→  sync-transactions.ts  ──→  transactions
Sleeper /draft        ──→  sync-drafts.ts        ──→  draft_results
Sleeper /matchups     ──→  sync-exhibitions.ts   ──→  exhibition_matchups
nflverse CSV          ──→  sync-stats.ts         ──→  nfl_stats
Sleeper /players/nfl  ──→  sync-players.ts       ──→  players
DynastyProcess CSV    ──→  sync-pids.ts          ──→  player_ids
```

All scripts read season/config data from Supabase (`scdfl.seasons`, `scdfl.drafts`, `scdfl.exhibitions`) rather than from local JSON config files.

---

## Key Mapping: Sleeper `roster_id` → Franchise

**Regular seasons:** `franchises.id` (integer) === Sleeper `roster_id` (1–14). Direct positional mapping.

**Exhibitions:** `exhibitions.team_id_a` / `team_id_b` are Sleeper roster_ids within the *exhibition* league, NOT franchise IDs. The `team_a_members[]` / `team_b_members[]` arrays provide the franchise abbreviation mapping.

---

## Deprecated Scripts

The following files in `scripts/` are from the pre-Supabase era and are no longer used:

| File | Replaced By |
|------|-------------|
| `fetch-sleeper.ts` | Individual `sync-*.ts` scripts |
| `lib/sleeper-api.ts` | Inline fetch calls in each sync script |
| `lib/transform.ts` | `sync-results.ts` handles its own transformation |

These files wrote to local JSON files in `src/data/` and `src/data/raw/`. The new sync scripts write directly to Supabase.

---

## Debugging

Common issues:
- **FK violation on `rosters` insert**: Run `sync:players` first to populate the `players` table
- **FK violation on `player_ids`**: Same — `sync:pids` requires `players` to be populated
- **Sleeper 429 / rate limit**: Space out calls; `sync:players` especially should be ≤ 1x/day
- **nflverse "Not found"**: Normal for future seasons — `sync:stats` skips gracefully
- **Supabase 1,000 row cap**: The sync scripts use the service key client, but large reads still need explicit `.limit()` or pagination

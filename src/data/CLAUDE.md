# CLAUDE.md — Data Files

Reference for all data files that power the SCDFL site. Data sources: manual entry, Sleeper API, and computed transforms.

---

## Manual Configuration

### `config.json`
League configuration — Sleeper league IDs per season.

**Schema:**
```json
{
  "platform": "sleeper",
  "current_season": 2026,
  "seasons": [
    {
      "year": 2021,
      "league_id": "721099701297950720",
      "current": false
    },
    ...
  ]
}
```

**Fields:**
- `platform`: Always `"sleeper"` (future-proofing for multi-platform support)
- `current_season`: Top-level year marker (redundant with `seasons[].current`; maintained for backward compatibility)
- `seasons`: Array of league seasons
  - `year`: Season year (e.g., 2024)
  - `league_id`: Sleeper league ID (string snowflake, ~18 digits)
  - `current`: `true` for the active season; `npm run fetch` without `--all` uses this

**Usage:** `scripts/fetch-sleeper.ts` reads this to determine which league(s) to fetch from the Sleeper API.

---

### `exhibition-config.json`
Exhibition matchup configuration — metadata for special tag-team and one-vs-all games outside the regular season.

**Schema:**
```json
{
  "exhibitions": [
    {
      "year": 2025,
      "week": 4,
      "league_id": "1263323796526333952",
      "exhib_type": "tagteam",
      "team_a_id": 2,
      "team_a_members": ["BKB", "WPG"],
      "team_a_slug": "BKBWPG",
      "team_a_display_name": "Stars / Wranglers",
      "team_b_id": 1,
      "team_b_members": ["NFD", "NNY"],
      "team_b_slug": "NFDNNY",
      "team_b_display_name": "Blowers / Benders"
    }
  ]
}
```

**Fields:**
- `year`, `week`: When the exhibition took place
- `league_id`: Sleeper league ID for this exhibition (separate from regular season leagues)
- `exhib_type`: `"tagteam"` (30 starters) or `"onevsall"` (14 starters)
- `team_*_id`: Sleeper roster ID within the exhibition league (NOT a franchise.id; these are separate leagues)
- `team_*_members`: Array of franchise abbreviations (for display names and logo lookup)
- `team_*_slug`: URL slug component (alphabetized before use in /games/[year]/[slug])
- `team_*_display_name`: Team name for score card display

**Usage:** `scripts/fetch-sleeper.ts` reads this, fetches matchup data from each exhibition's league, filters to specified roster IDs, enriches with config metadata, and saves to `exhibitions.json`.

---

### `draft-config.json`
Draft IDs and metadata for league drafts to fetch.

**Schema:**
```json
{
  "drafts": [
    {
      "year": 2021,
      "draft_id": "721099701922897920",
      "type": "startup"
    },
    {
      "year": 2022,
      "draft_id": "833952111766130688",
      "type": "rookie"
    },
    ...
  ]
}
```

**Fields:**
- `year`: Season year (e.g., 2024) — may have multiple entries if league runs multiple drafts
- `draft_id`: Sleeper draft ID (string snowflake; must be discovered manually from Sleeper UI)
- `type`: Draft type classification (`"startup"`, `"rookie"`, `"idp"`, or other values)
  - Used to build output filename: `{year}-{type}-draft.json`
  - Allows distinguishing between multiple drafts in a single year (e.g., rookie + IDP)

**Usage:** `scripts/fetch-sleeper.ts` iterates over this and calls `getDraftPicks()` for each draft_id. All picks are saved to `src/data/raw/{year}-{type}-draft.json`.

---

### `draft-slots.json`
Helper data mapping draft slots to original franchise assignments.

**Purpose:** Resolves which franchise originally held each draft slot before trades. Used downstream to attribute picks to their original owner.

**Schema:**
```json
{
  "721099701922897920": [
    { "slot": 1, "original_franchise_id": 10 },
    { "slot": 2, "original_franchise_id": 11 },
    ...
  ],
  "833952111766130688": [
    { "slot": 1, "original_franchise_id": 14 },
    ...
  ]
}
```

**Structure:**
- Top-level keys: Draft IDs (match `draft-config.json` `draft_id` values)
- Each value: Array of `{ slot, original_franchise_id }` objects (one per draftboard column)
  - `slot`: Draft slot number (1–14 in SCDFL)
  - `original_franchise_id`: Franchise ID (1–14, matches `franchises.json` `id` field)

**Data flow:**
1. Fetch picks from API: each pick has `draft_slot` (e.g., 5)
2. Look up this file by `draft_id` → find slot 5 → get `original_franchise_id` (e.g., 12)
3. Also use pick's `roster_id` to see who **actually** made the pick (after trades)
4. Result: each pick can now be attributed to both original and final owner

**Manual maintenance:** Entered once per draft, static thereafter. Commissoner must provide this mapping when setting up a new draft in `draft-config.json`.

---

## Sleeper API Data (`raw/` directory)

All raw Sleeper API responses are cached to `raw/` for inspection and debugging. These are written by `npm run fetch`.

### `{year}-rosters.json`
All team rosters for a season, including win/loss/points stats.

**Source:** `GET /league/{league_id}/rosters`

**Structure:** Array of roster objects, one per franchise (1–14).

**Key fields:**
- `roster_id`: Team ID (1–14, maps to `franchises.json` `id`)
- `owner_id`: Sleeper user ID (string)
- `players`: Array of Sleeper player IDs on roster
- `starters`: Array of Sleeper player IDs in starting lineup
- `settings`: Win/loss/points statistics
  - `wins`, `losses`, `ties`: Record to date
  - `fpts`: Points for (integer part)
  - `fpts_decimal`: Points for (decimal part, 0–99)
  - `fpts_against`, `fpts_against_decimal`: Points against

**Processing:** `scripts/fetch-sleeper.ts` reads this file, extracts stats per franchise, and merges into `results.json`.

---

### `{year}-matchups.json`
All matchups for a season, indexed by week.

**Source:** `GET /league/{league_id}/matchups/{week}` (fetched for each week 1–17)

**Structure:** Object keyed by week number (1–17).

```json
{
  "1": [
    {
      "roster_id": 1,
      "matchup_id": 1,
      "points": 145.32,
      "custom_points": null,
      "players": ["6872", "4043", ...],
      "starters": ["6872"],
      "players_points": { "6872": 28.5, "4043": 0, ... }
    },
    {
      "roster_id": 2,
      "matchup_id": 1,
      ...
    },
    ...
  ],
  "2": [...],
  ...
}
```

**Key fields:**
- `roster_id`: Team ID (1–14)
- `matchup_id`: Game ID (same for both teams in a game; null = bye week)
- `points`, `custom_points`: Score; use `custom_points || points || 0`
- `players`, `starters`: Player IDs in that game
- `players_points`: Individual player scoring breakdown

**Note:** Bye weeks appear as roster entries with `matchup_id: null`. Filter these when processing (e.g., preventing NaN keys in frontend grouping).

---

### `{year}-transactions.json`
All transactions (waivers, trades, free agents) for a season, indexed by week.

**Source:** `GET /league/{league_id}/transactions/{round}` (fetched for each week 1–18)

**Structure:** Object keyed by week number (1–18, includes one week past season end for post-draft activity).

See `scripts/lib/CLAUDE.md` for full schema. Key transaction types:
- `"waiver"`: Waiver claim
- `"free_agent"`: Free agent pickup
- `"trade"`: Trade between franchises

**Usage:** Can be displayed on franchise pages to show activity history.

---

### `{year}-{type}-draft.json`
All picks from a single draft, in order.

**Source:** `GET /draft/{draft_id}/picks` (endpoint called once per draft in `draft-config.json`)

**Structure:** Array of pick objects, one per draft pick.

```json
[
  {
    "player_id": "11560",
    "picked_by": "467050157607743488",
    "roster_id": 9,
    "round": 1,
    "draft_slot": 1,
    "pick_no": 1,
    "metadata": {
      "first_name": "Caleb",
      "last_name": "Williams",
      "position": "QB",
      "team": "CHI",
      "player_id": "11560",
      "sport": "nfl",
      "status": "Active",
      ...
    },
    "is_keeper": null,
    "draft_id": "1054586519090008065"
  },
  ...
]
```

**Key fields for reconstruction:**
- `draft_slot` (1–14) + `draft-slots.json` → original franchise that held this pick
- `roster_id` → team that actually made the pick (after trades)
- `round`, `pick_no` → draft sequencing

**Filename:** `{year}-{type}-draft.json` (e.g., `2024-rookie-draft.json`)

---

### `exhibitions.json`
Exhibition matchup data — enriched from `exhibition-config.json` + Sleeper API.

**Source:** `GET /league/{league_id}/matchups/{week}` per entry in `exhibition-config.json`

**Structure:** Array of exhibition objects, one per configured exhibition.

```json
[
  {
    "year": 2025,
    "week": 4,
    "slug": "04-bkbwpg-nfdnny",
    "league_id": "1263323796526333952",
    "exhib_type": "tagteam",
    "team_a": {
      "id": 2,
      "slug": "BKBWPG",
      "display_name": "Stars / Wranglers",
      "members": ["BKB", "WPG"],
      "score": 538.32,
      "starters": ["12508", "5849", ...],
      "starters_points": [19.34, 18.1, ...],
      "players_points": { "12508": 19.34, ... }
    },
    "team_b": { /* same structure */ }
  }
]
```

**Key fields:**
- `slug`: URL component for `/games/[year]/[slug]` links (alphabetized team slugs)
- `team_*`: Full team data including rosters, starters, and scoring
- `exhib_type`: Used by `mapExhibitionStartersToSlots()` to select correct starter schema

**Processing:** `scripts/fetch-sleeper.ts` generates this file by:
1. Reading `exhibition-config.json`
2. For each exhibition: calling `getMatchups(league_id, week)`
3. Filtering raw matchup array to the specified `roster_id` values
4. Enriching with config metadata (display names, members, slugs)
5. Upserting by (year + week + league_id) to support updates

---

### `nfl-state.json`
Current NFL season state.

**Source:** `GET /state/nfl` (fetched once per `npm run fetch` run)

**Structure:**
```json
{
  "week": 0,
  "season": "2026",
  "season_type": "off",
  "display_week": 0,
  ...
}
```

**Usage:** Determines the max week to fetch matchups/transactions for the current season (historical seasons always fetch weeks 1–17).

---

## Computed Data

### `results.json`
Per-franchise, per-season statistics. **Manually maintained for `playoff` and `finish` fields.**

**Structure:**
```json
{
  "TOR": [
    {
      "year": 2021,
      "wins": 8,
      "losses": 5,
      "points_for": 1567.89,
      "points_against": 1432.21,
      "playoff": "1st seed SCC",
      "finish": "Champion"
    },
    {
      "year": 2022,
      "wins": 6,
      "losses": 7,
      "points_for": 1401.56,
      "points_against": 1389.34,
      "playoff": "Consolation 3",
      "finish": "3rd place"
    },
    ...
  ],
  ...
}
```

**Automatically written fields** (by `scripts/fetch-sleeper.ts`):
- `year`, `wins`, `losses`, `points_for`, `points_against`

**Manually maintained fields** (commissioner updates):
- `playoff`: Playoff bracket info (e.g., "1st seed SCC", "Consolation 3")
- `finish`: Final placement (e.g., "Champion", "Runner-up", "Consolation winner")

**Update process:** When running `npm run fetch`, only the 5 API-derived fields are overwritten. If `playoff` and `finish` already exist in the file, they are **never** overwritten — existing values are always preserved.

---

### `player-id-map.json`
Sleeper player ID → ESPN metadata mapping.

**Source:** Generated by `npm run fetch -- --players` (fetches dynastyprocess.com crosswalk CSV)

**Schema:**
```json
{
  "6872": {
    "espn_id": "4035671",
    "full_name": "Justin Jefferson",
    "position": "WR"
  },
  ...
}
```

**Fields:**
- `espn_id` (optional): ESPN player ID for constructing headshot CDN URLs. Absent if ESPN hasn't mapped this player (very recent draft picks, international, etc.)
- `full_name`: Player name string from Sleeper
- `position`: NFL position (WR, QB, RB, TE, K, DEF, etc.)

**Refresh:** Run `npm run fetch -- --players` once per year after NFL draft (~April) to pick up rookie class.

---

## Franchise & League Data

### `franchises.json`
All 14 franchises, with metadata and history.

**Key fields for data joins:**
- `id`: Numeric franchise ID (1–14); **matches Sleeper `roster_id`** — used to join rosters to franchises
- `abbr`: Three-letter abbreviation (e.g., `"TOR"`, `"BKB"`)
- `founded`: Year ownership began (2021 = original; later = adopted)
- `predecessor_abbr`: Previous abbreviation (if adopted)

**Usage:** All picks, matchups, and rosters use `roster_id` (number); joins to `franchises.json` via `id` field.

---

### `seasons.json`
Season-level data: champions, Dynasty Bowl winner/loser, format notes.

**Key fields:**
- `year`: Season year
- `dynasty_bowl.winner`, `dynasty_bowl.loser`: Winner/loser franchise abbreviations (e.g., `"TOR"`)

**Usage:** Determines which team to display Dynasty Bowl trophy on scores page (week 17).

---

## Data Freshness

| File | Source | Refresh Frequency | Editor |
|------|--------|-------------------|--------|
| `config.json` | Manual | Once per new season | Commissioner |
| `draft-config.json` | Manual | Once per draft (multiple per season possible) | Commissioner |
| `draft-slots.json` | Manual | Once per draft | Commissioner |
| `exhibition-config.json` | Manual | Once per exhibition scheduled | Commissioner |
| `{year}-rosters.json` | Sleeper API | `npm run fetch` (weekly during season) | Automated script |
| `{year}-matchups.json` | Sleeper API | `npm run fetch` (weekly during season) | Automated script |
| `{year}-transactions.json` | Sleeper API | `npm run fetch` (weekly during season) | Automated script |
| `{year}-{type}-draft.json` | Sleeper API | `npm run fetch` (once per draft) | Automated script |
| `exhibitions.json` | Sleeper API | `npm run fetch` (whenever exhibition-config changes) | Automated script |
| `nfl-state.json` | Sleeper API | `npm run fetch` (weekly) | Automated script |
| `results.json` | Rosters + Manual | `npm run fetch` (API fields); manual edits for playoff/finish | Hybrid |
| `player-id-map.json` | dynastyprocess.com | `npm run fetch -- --players` (once yearly, post-NFL draft) | Automated script |
| `franchises.json` | Manual | On rebranding or adoption | Commissioner |
| `seasons.json` | Manual | Post-season (after Dynasty Bowl) | Commissioner |

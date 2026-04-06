# Sixth City Editorial — Supabase Migration Brief

## Purpose

This document provides all context needed to migrate one page or file group
from its current JSON-based data sources to Supabase. Read this in full before
touching any file. Migrate one page at a time. Read the target file first,
propose the equivalent Supabase queries, and wait for approval before writing
any code.

---

## Ground Rules

- **One file or file group at a time.** Do not touch other files speculatively.
- **Read before writing.** Always read the current file first and state what
  data it uses before proposing any changes.
- **Propose, then implement.** State the Supabase query you plan to use and
  wait for confirmation before modifying the file.
- **Do not delete JSON files.** They remain as fallback until the migration is
  fully verified. Do not import from them after migration.
- **Do not invent field names.** All field names are documented below. If
  something is unclear, ask rather than assume.

---

## Supabase Setup

- **Project:** Sixth City Dynasty Football
- **Schema:** `scdfl` (all tables live here, not in `public`)
- **Client location:** check for an existing `src/lib/supabase.ts` or similar
- **Environment variables:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`

Client initialization:
```ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.SUPABASE_URL,
  import.meta.env.SUPABASE_ANON_KEY
)
```

All queries must use `.schema('scdfl')`:
```ts
const { data, error } = await supabase
  .schema('scdfl')
  .from('franchises')
  .select('*')
```

---

## JSON → Supabase Mapping

### `src/data/franchises.json`
→ `scdfl.franchises`

One row per franchise identity (including historical rebrands). Active
franchises have `"to" IS NULL`. Historical identities have a non-null `"to"`.

**Key difference from JSON:** the old file had one object per franchise. The
new table has one row per identity. Always filter to active unless historical
data is explicitly needed.

Fields: `id, sleeper_id, abbr, name, owner, conf, colors[], "from", "to"`

Note: `"from"` and `"to"` must be quoted in SQL as they are reserved keywords.

---

### `src/data/seasons.json`
→ `scdfl.seasons`

Fields: `year, league_id, regular_season_weeks, playoff_teams, scc_champion,
hcc_champion, charity, retreat_location`

Removed from old JSON: `dynasty_bowl_*` fields (derivable from matchups),
`notes` (editorial content, not data), `playoff_format` (stored in
`playoff_teams`).

---

### `src/data/results.json`
→ `scdfl.results`

Fields: `sleeper_id, year, wins, losses, ties, points_for, points_against,
playoff, seed, finish`

Join key to franchises: `results.sleeper_id = franchises.sleeper_id`

---

### `src/data/raw/{year}-matchups.json` (all seasons)
→ `scdfl.matchups`

Fields: `year, week, matchup_id, game_type, roster_id_a, roster_id_b,
score_a, score_b, starters_a[], starter_points_a[], starters_b[],
starter_points_b[]`

`game_type` values: `0` = regular season, `1` = playoff, `-1` = consolation

Join key to franchises: `roster_id_a` or `roster_id_b` = `franchises.sleeper_id`
(cast to integer where needed)

---

### `src/data/spotlight_games.json`
→ `scdfl.spotlight_games` + `scdfl.spotlight_game_years`

**Key structural change:** the old JSON was a flat list with `year_established`.
The new structure is two tables joined on `slug`.

`spotlight_games` fields: `slug, name, type, team_a, team_b`
`spotlight_game_years` fields: `slug, year`

`type` values: `'bowl-game'` or `'rivalry'`

To get all active spotlight games for a given year:
```sql
SELECT g.slug, g.name, g.type, g.team_a, g.team_b
FROM scdfl.spotlight_games g
JOIN scdfl.spotlight_game_years y ON y.slug = g.slug
WHERE y.year = 2026
```

To check if a matchup is a spotlight game (either team order):
```sql
WHERE (g.team_a = :abbr_a AND g.team_b = :abbr_b)
   OR (g.team_a = :abbr_b AND g.team_b = :abbr_a)
```

Note: `team_a`/`team_b` store franchise `abbr` values. To join to matchups
(which use `sleeper_id`/`roster_id`), you must first resolve `abbr` to
`sleeper_id` via `scdfl.franchises`.

---

### `src/data/raw/{year}-transactions.json` (all seasons)
→ `scdfl.transactions`

**Key structural change:** old JSON had one object per transaction. New table
has one row per asset movement. Use `transaction_id` to group rows belonging
to the same transaction.

Fields: `id, transaction_id, year, week, type, status, roster_id, action,
asset, player_id, pick_season, pick_round, pick_original_roster_id,
waiver_bid, created`

`type` values: `'trade'`, `'waiver'`, `'free_agent'`, `'commissioner'`
`action` values: `'add'`, `'drop'`
`asset` values: `'player'`, `'pick'`

---

### `src/data/draft-config.json` + `src/data/raw/{year}-*-draft.json`
→ `scdfl.drafts` + `scdfl.draft_results`

`drafts` fields: `draft_id, year, type`
`type` values: `'startup'`, `'rookie'`, `'idp'`

`draft_results` fields: `draft_id, pick_no, round, draft_slot, roster_id,
original_roster_id, player_id`

`roster_id` = who actually made the pick
`original_roster_id` = who originally held that draft slot (before any trades)

---

### `src/data/draft-slots.json`
→ `scdfl.draft_results.original_roster_id`

The slot-to-roster mapping is now embedded directly in `draft_results`. Any
logic that used `draft-slots.json` to look up who originally owned a slot
should instead query `original_roster_id` from `draft_results`.

---

### `src/data/exhibition-config.json` + `src/data/raw/exhibitions.json`
→ `scdfl.exhibitions` + `scdfl.exhibition_matchups`

`exhibitions` fields: `id, year, week, league_id, exhib_type, team_id_a,
team_a_members[], team_a_slug, team_a_display_name, team_id_b,
team_b_members[], team_b_slug, team_b_display_name`

`exhibition_matchups` fields: `exhibition_id, score_a, score_b, starters_a[],
starter_points_a[], starters_b[], starter_points_b[]`

---

### `src/data/config.json`
→ `scdfl.seasons` (`league_id` column)

`league_id` per season is now stored on `scdfl.seasons`. The `platform` and
`current_season` fields are deprecated. Current season = max year in
`scdfl.seasons`.

---

### `src/data/player-id-map.json`
→ `scdfl.v_players` (view joining `players` + `player_ids`)

ESPN headshot URL pattern:
```
https://a.espncdn.com/i/headshots/nfl/players/full/{espn_id}.png
```

Use `scdfl.v_players` for any query needing `espn_id`. It coalesces ESPN IDs
from both Sleeper and the DynastyProcess crosswalk, so coverage is maximized.

---

### `src/data/raw/{year}-rosters.json`
→ `scdfl.rosters` (current season only)

`scdfl.rosters` is a current-snapshot table: `player_id, sleeper_id`

Historical roster data has no direct equivalent. If a page uses historical
roster data, flag it for discussion rather than attempting a direct migration.

---

### `src/data/raw/nfl-state.json`
→ **Deprecated. Do not migrate.** Current week is derived from matchup data.

---

## Common Query Patterns

### Active franchises
```sql
SELECT * FROM scdfl.franchises
WHERE "to" IS NULL
ORDER BY id
```

### Franchise identity for a specific season year
```sql
SELECT * FROM scdfl.franchises
WHERE "from" <= 2024 AND ("to" >= 2024 OR "to" IS NULL)
```

### Franchise by abbr (current identity)
```sql
SELECT * FROM scdfl.franchises
WHERE abbr = 'TOR' AND "to" IS NULL
```

### Season results with franchise info
```sql
SELECT r.*, f.abbr, f.name, f.owner, f.conf, f.colors
FROM scdfl.results r
JOIN scdfl.franchises f
  ON f.sleeper_id = r.sleeper_id
  AND f."from" <= r.year
  AND (f."to" >= r.year OR f."to" IS NULL)
WHERE r.year = 2024
ORDER BY r.wins DESC
```

### Regular season matchups for a franchise
```sql
SELECT * FROM scdfl.matchups
WHERE year = 2024
  AND game_type = 0
  AND (roster_id_a = 1 OR roster_id_b = 1)
ORDER BY week
```

### Playoff matchups only
```sql
SELECT * FROM scdfl.matchups
WHERE year = 2024 AND game_type = 1
ORDER BY week
```

### Head-to-head record between two franchises (all time)
```sql
SELECT
  COUNT(*) FILTER (WHERE
    (roster_id_a = 1 AND score_a > score_b) OR
    (roster_id_b = 1 AND score_b > score_a)
  ) AS wins,
  COUNT(*) FILTER (WHERE
    (roster_id_a = 2 AND score_a > score_b) OR
    (roster_id_b = 2 AND score_b > score_a)
  ) AS losses
FROM scdfl.matchups
WHERE game_type = 0
  AND (
    (roster_id_a = 1 AND roster_id_b = 2) OR
    (roster_id_a = 2 AND roster_id_b = 1)
  )
```

### Current roster with player info
```sql
SELECT p.player_id, p.first_name, p.last_name, p.position, p.team,
       vp.espn_id
FROM scdfl.rosters r
JOIN scdfl.players p ON p.player_id = r.player_id
LEFT JOIN scdfl.v_players vp ON vp.player_id = r.player_id
WHERE r.sleeper_id = 1
```

### Transaction log for a player
```sql
SELECT t.transaction_id, t.year, t.week, t.type, t.action,
       t.roster_id, t.waiver_bid, t.created
FROM scdfl.transactions t
WHERE t.player_id = '9221'
  AND t.asset = 'player'
ORDER BY t.created DESC
```

### Draft board for a specific draft
```sql
SELECT dr.pick_no, dr.round, dr.draft_slot,
       dr.roster_id, dr.original_roster_id,
       p.first_name, p.last_name, p.position, p.team
FROM scdfl.draft_results dr
JOIN scdfl.players p ON p.player_id = dr.player_id
JOIN scdfl.drafts d ON d.draft_id = dr.draft_id
WHERE d.year = 2025 AND d.type = 'rookie'
ORDER BY dr.pick_no
```

### Spotlight games for a season with matchup result
```sql
SELECT g.slug, g.name, g.type, g.team_a, g.team_b,
       m.week, m.score_a, m.score_b, m.game_type
FROM scdfl.spotlight_games g
JOIN scdfl.spotlight_game_years y ON y.slug = g.slug
LEFT JOIN scdfl.franchises fa
  ON fa.abbr = g.team_a AND "fa"."to" IS NULL
LEFT JOIN scdfl.franchises fb
  ON fb.abbr = g.team_b AND "fb"."to" IS NULL
LEFT JOIN scdfl.matchups m
  ON m.year = y.year
  AND m.game_type = 0
  AND (
    (m.roster_id_a = fa.sleeper_id::integer AND m.roster_id_b = fb.sleeper_id::integer) OR
    (m.roster_id_a = fb.sleeper_id::integer AND m.roster_id_b = fa.sleeper_id::integer)
  )
WHERE y.year = 2026
```

---

## Key Identifiers Reference

| Concept | Old JSON field | Supabase field | Table |
|---|---|---|---|
| Franchise identity | `abbr` (string key) | `abbr` + `"to" IS NULL` | `franchises` |
| Franchise join key | `abbr` | `sleeper_id` (text, cast to int for matchup joins) | `franchises` |
| Sleeper roster slot | `roster_id` | `roster_id_a` / `roster_id_b` | `matchups` |
| Player identity | `player_id` (Sleeper) | `player_id` | `players`, `rosters` |
| Player NFL stats | `gsis_id` | `gsis_id` | `nfl_stats`, `player_ids` |
| ESPN headshot | from `player-id-map.json` | `espn_id` from `v_players` | `v_players` |
| Draft slot owner | `draft-slots.json` | `original_roster_id` | `draft_results` |
| Current season | `config.json` → `current_season` | `MAX(year)` from `seasons` | `seasons` |

---

## Page Migration Order

Work through pages in this order. Complete and verify each before starting
the next.

1. `/dev/commish/` — roster audit and transaction audit pages ✅
2. `/spotlight-games/` — index and `[slug]` pages ✅
3. `/history/` — index and `[year]` pages ✅
4. `/games/[year]/[slug].astro` ✅
5. `scores.astro` ✅
6. `/franchises/` — index and `[abbr]` pages ✅
7. `index.astro` ✅
8. `content.astro` — check last, likely minimal changes needed
    * `src/lib/remark-team-headers.ts ✅

---

## Known Pain Points

**`draft-slots.json`** — complex refactor. The slot display logic needs to use
`draft_results.original_roster_id` instead. Discuss approach before
implementing.

**Historical rosters** (`{year}-rosters.json`) — `scdfl.rosters` is
current-snapshot only. If any page renders historical roster state, flag it
for discussion rather than attempting a direct migration.

**`spotlight_games` two-table join** — the old JSON was a flat list. Every
query that filtered or found spotlight games now requires a join between
`spotlight_games` and `spotlight_game_years`. The team fields (`team_a`,
`team_b`) store `abbr` values; joining to `matchups` requires resolving those
to `sleeper_id` via `franchises`.

**`"to"` field quoting** — `to` is a reserved SQL keyword. Always quote it:
`"to"`. This applies in all WHERE clauses, ORDER BY, and SELECT lists.

**Supabase 1,000 row default limit** — the JS client silently caps results at
1,000 rows unless you add `.limit(n)` or paginate. For tables with many rows
(matchups: 580, transactions: 5,724, nfl_stats: 94,735), always set an
explicit limit or paginate. For small tables (franchises: 22, seasons: 6),
the default is fine.

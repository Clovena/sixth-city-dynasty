# CLAUDE.md — Sixth City Dynasty Fantasy Football League Site

Astro 5 static site for the SCDFL. Commissioner: Zac. Est. 2021. 14 franchises, two conferences (SCC, HCC), annual Dynasty Bowl championship.

---

## Commands

```bash
npm run dev          # dev server
npm run build        # static build → dist/
npm run preview      # preview built site

# --- Supabase sync scripts (see scripts/lib/CLAUDE.md for details) ---
npm run sync              # run all routine syncs (results, matchups, rosters, transactions, drafts, exhibitions, stats)
npm run sync:results      # sync win/loss/points per franchise per season
npm run sync:matchups     # sync all weekly matchups (regular + playoff + consolation)
npm run sync:rosters      # sync current-season roster assignments (full replace)
npm run sync:transactions # sync all transactions (waivers, trades, free agents)
npm run sync:drafts       # sync draft pick results for all configured drafts
npm run sync:exhibitions  # sync exhibition matchup scores
npm run sync:stats        # sync weekly NFL player stats from nflverse

# --- Player metadata (run sparingly — heavyweight API calls) ---
npm run sync:players      # sync Sleeper player database (~20k+ players, ≤ 1x/day)
npm run sync:pids         # sync DynastyProcess player ID crosswalk (ESPN, PFF, etc.)
npm run sync:player-meta  # run sync:players then sync:pids sequentially
```

All sync scripts live in `scripts/lib/` and write directly to Supabase (schema `scdfl`). They use `SUPABASE_SERVICE_KEY` (not the anon key). See `scripts/lib/CLAUDE.md` for full documentation.

---

## Tech Stack

- **Astro 5** — static output, content collections, `import.meta.glob`
- **Tailwind CSS 4** — via `@tailwindcss/vite` (not PostCSS)
- **Supabase** — PostgreSQL database (schema `scdfl`); all league data lives here
  - Build-time client: `src/lib/supabase.ts` (uses `SUPABASE_ANON_KEY` via `import.meta.env`)
  - Sync scripts: `scripts/lib/*.ts` (use `SUPABASE_SERVICE_KEY` via `dotenv`)
- **Remark/Rehype** — custom plugin (`src/lib/remark-team-headers.ts`) for markdown AST transformation
- **Node 18+** — see `.nvmrc`; also pinned in `netlify.toml` to fix lightningcss binding issue
- No framework components (vanilla JS for all interactivity)

---

## Routes

| URL | File |
|-----|------|
| `/` | `src/pages/index.astro` |
| `/history` | `src/pages/history.astro` |
| `/franchises` | `src/pages/franchises/index.astro` |
| `/franchises/[abbr]` | `src/pages/franchises/[abbr].astro` |
| `/spotlight-games` | `src/pages/spotlight-games/index.astro` |
| `/spotlight-games/[slug]` | `src/pages/spotlight-games/[slug].astro` |
| `/scores` | `src/pages/scores.astro` |
| `/games/[year]/[slug]` | `src/pages/games/[year]/[slug].astro` |
| `/content` | `src/pages/content.astro` |
| `/players/[id]` | `src/pages/players/[id].astro` |

---

## Supabase Schema (`scdfl`)

All league data is stored in the `scdfl` schema in Supabase. See `SUPABASE_DEFINITIONS.sql` for full DDL, and `src/data/CLAUDE.md` for detailed table shapes, relationships, and maintenance processes.

### Tables

| Table | Maintenance | Purpose |
|-------|-------------|---------|
| `franchises` | Manual | Franchise identities (one row per identity era; active rows have `"to" IS NULL`) |
| `seasons` | Manual | Per-season metadata: league_id, conference champions, playoff config |
| `results` | `sync:results` + manual | Per-franchise per-season stats (wins, losses, PF, PA); `playoff`, `seed`, `finish` are manual |
| `matchups` | `sync:matchups` | All weekly matchups with scores, starters, and `game_type` classification |
| `rosters` | `sync:rosters` | Current-season roster assignments (full replace each sync) |
| `transactions` | `sync:transactions` | All asset movements (one row per add/drop per team side) |
| `players` | `sync:players` | Sleeper player metadata (~20k+ rows) |
| `player_ids` | `sync:pids` | DynastyProcess crosswalk (ESPN, PFF, PFR, etc.) |
| `drafts` | Manual | Draft configuration (draft_id, year, type) |
| `draft_results` | `sync:drafts` | All draft picks with slot/roster/player data |
| `exhibitions` | Manual | Exhibition game configuration (league_id, team members, slugs) |
| `exhibition_matchups` | `sync:exhibitions` | Exhibition scores and starter data |
| `spotlight_games` | Manual | Spotlight game metadata (bowl games, rivalries) |
| `spotlight_game_years` | Manual | Which years each spotlight game occurs |
| `nfl_stats` | `sync:stats` | Weekly NFL player stats from nflverse (~95k rows) |
| `accolades` | Manual | Annual league awards (MVP, trade of the year, etc.) |

### Views

| View | Purpose |
|------|---------|
| `v_players` | Joins `players` + `player_ids`; coalesces ESPN/Rotowire/Yahoo IDs from both sources |
| `v_player_starts` | Unnests matchup starter arrays into one row per player-start with `year`, `week`, `roster_id`, `player_id`, `points` |
| `v_player_season_stats` | Aggregates `v_player_starts` + `player_ids` + `nfl_stats` by player/year; all stat columns (passing, rushing, receiving, kicking, IDP) + `games_started` and `fpts` |

### Key Identifiers

| Concept | Field | Table | Notes |
|---------|-------|-------|-------|
| Franchise identity | `abbr` + `"to" IS NULL` | `franchises` | Active identity; historical rows have non-null `"to"` |
| Franchise join key | `sleeper_id` | `franchises` | Text; cast to int for matchup roster_id joins |
| Matchup roster slot | `roster_id_a` / `roster_id_b` | `matchups` | Integer; equals `franchises.id` |
| Player identity | `player_id` | `players`, `rosters` | Sleeper player ID (text) |
| NFL stats link | `gsis_id` | `nfl_stats` → `player_ids` | Cross-referenced via `player_ids.gsis_id` |
| ESPN headshot | `espn_id` | `v_players` | `https://a.espncdn.com/i/headshots/nfl/players/full/{espn_id}.png` |
| Draft slot owner | `original_roster_id` | `draft_results` | Who originally held the pick (before trades) |
| Current season | `MAX(year)` | `seasons` | No explicit "current" flag — latest year wins |

---

## Franchise Identity Model

The `franchises` table uses a temporal identity model (one row per identity era) instead of the old single-object-per-franchise approach.

- **Active franchises:** `"to" IS NULL` — always 14 rows
- **Historical identities:** `"to"` is set to the last year that identity was active
- **Composite PK:** `(id, "from")` — same numeric `id` can appear multiple times with different eras
- **Unique index on `abbr`** — abbreviations are globally unique across all eras

### Adoption logic (important — used in multiple places)

To resolve a franchise identity for a specific season year:
```sql
SELECT * FROM scdfl.franchises
WHERE "from" <= :year AND ("to" >= :year OR "to" IS NULL)
```

This replaces the old `founded`/`predecessor_abbr`/`rebrands[]` pattern. The temporal model handles rebrands natively — each identity era is its own row with its own `abbr`, `name`, `colors`, etc.

This affects: franchise pages (`[abbr].astro` season table), scores page team display, game recap pages.

---

## Slug Format (`/games/[year]/[slug]`)

```
[week_zero_padded]-[team_a]-[team_b]
```
- Week zero-padded to two digits (`04`, `17`)
- Teams sorted alphabetically by abbreviation, lowercase
- Example: `04-bkb-tor`, `17-chc-van`

Slugs are the canonical matchup identifier and the lookup key for recap content files.

---

## Content Collections (`src/content.config.ts`)

| Collection | Base path | Pattern | Notes |
|------------|-----------|---------|-------|
| `franchises` | `src/content/franchises/` | `**/*.md` | One file per franchise, filename = `abbr.toLowerCase()` |
| `writeups` | `src/content/writeups/` | `*.md` | Editorial writeups; `archive/` subdir excluded automatically |
| `recaps` | `src/content/recaps/` | `**/*.md` | Organized by season subdir: `recaps/[year]/[slug].md` |

### Astro 5 render() usage

```ts
// Correct — Astro 5 changed render() to a standalone function
import { getCollection, render } from 'astro:content';
const rendered = await render(entry);
const { Content } = rendered;
```

`entry.render()` does NOT exist in Astro 5.

---

## CSS Design Tokens (`src/styles/global.css`)

```css
--color-bg: #0f0f0d
--color-surface: /* slightly lighter bg */
--color-border: /* subtle border */
--color-text-primary: /* main text */
--color-text-muted: /* secondary text */

--color-gold: #f2b22e
--color-gold-light: #ffca5c
--color-gold-dim: #b47e0f
--color-gold-surface: #f2b22e33   /* gold with alpha — used for winner highlight, dynasty bowl banner bg */
--color-gold-glow: #f2b22e66     /* gold with more alpha — used for dynasty bowl banner text/border */

--color-scc: #4a7fa5              /* SCC conference — blue tones */
--color-hcc: #e16a3b              /* HCC conference — orange/rust tones */

--font-display: "Playfair Display"
--font-body: "Inter"
```

---

## Scoped Styles & Markdown-Rendered Content

Astro scoped styles do NOT apply to content rendered by `<Content />` (markdown output has no scope attribute). Use `:global()` for any styles targeting markdown-rendered HTML:

```astro
<style>
  .writeup-content :global(p) { ... }    /* targets <p> inside .writeup-content */
  :global(.team-entry) { ... }           /* targets dynamically injected elements */
</style>
```

---

## Remark Plugin (`src/lib/remark-team-headers.ts`)

Transforms consecutive `**bold**` + `*italic*` paragraph pairs in writeup markdown into styled team header blocks. Runs at build time via Astro's markdown pipeline.

- Finds franchise names in combined text via exact match against `franchiseByName` Map
- 1 match → single-team header (left border + logo)
- 2 matches → matchup header (logos flanking centered text, dual borders)
- Uses direct index iteration over `tree.children` — NOT `unist-util-visit` — to avoid index-drift bugs during splice

---

## Exhibition Matchups

Exhibition games (tag-team, one-vs-all) are configured in the `scdfl.exhibitions` table and scored in `scdfl.exhibition_matchups`.

**Configuration** (`scdfl.exhibitions` — manually maintained):
- `year`, `week`, `league_id` — when and where the exhibition takes place
- `exhib_type` — `'tagteam'` (30 starters) or `'onevsall'` (14 starters)
- `team_id_a` / `team_id_b` — Sleeper roster_ids within the exhibition league (NOT franchise.id)
- `team_a_members[]` / `team_b_members[]` — franchise abbreviations for display + logos
- `team_a_slug` / `team_b_slug` — URL slug components
- `team_a_display_name` / `team_b_display_name` — display labels

**Scores** (`scdfl.exhibition_matchups` — synced via `npm run sync:exhibitions`):
- `exhibition_id` (FK to `exhibitions.id`) — one-to-one with config
- `score_a`, `score_b`, `starters_a[]`, `starter_points_a[]`, etc.

**Slug format:** `[week_zero_padded]-[team_a_slug_lower]-[team_b_slug_lower]` (alphabetized)
- Example slugs: `04-bkbwpg-nfdnny`, `13-pei-world`

**Display locations**:
- `/games/[year]/[slug]` — full game recap page (shares route with regular games)
- `/scores` — exhibition cards above standard matchups (client-side filtered by year/week)
- `/history/[year]` — exhibition section above draft board

**Starters mapping** (`src/lib/lineup.ts`):
- `mapExhibitionStartersToSlots(starters, startersPoints, exhibType)` maps raw starters to display slots
- Exhibition starters arrive in display order (identity mapping, no era remapping needed)
- Uses `ROSTER_SLOTS_TAGTEAM` (30 slots) for tagteam, `ROSTER_SLOTS_ONEVSALL` (14 slots) for one-vs-all

**Team logos** (scores/history pages):
- All `team_*_members[]` logos displayed side-by-side on score cards
- First member used as fallback for recap page header

---

## Sync Scripts (`scripts/lib/`)

Nine standalone TypeScript scripts that sync data from external APIs into Supabase. Each is independently runnable via `npx tsx`. See `scripts/lib/CLAUDE.md` for full documentation.

**Routine syncs** (`npm run sync` runs all):
| Script | Source | Target Table | Cadence |
|--------|--------|--------------|---------|
| `sync-results.ts` | Sleeper rosters API | `results` | Weekly during season |
| `sync-matchups.ts` | Sleeper matchups API | `matchups` | Weekly during season |
| `sync-rosters.ts` | Sleeper rosters API | `rosters` | Weekly during season |
| `sync-transactions.ts` | Sleeper transactions API | `transactions` | Weekly during season |
| `sync-drafts.ts` | Sleeper draft picks API | `draft_results` | Once per draft |
| `sync-exhibitions.ts` | Sleeper matchups API | `exhibition_matchups` | When exhibitions occur |
| `sync-stats.ts` | nflverse GitHub CSV | `nfl_stats` | Weekly during season |

**Player metadata** (run sparingly):
| Script | Source | Target Table | Cadence |
|--------|--------|--------------|---------|
| `sync-players.ts` | Sleeper `/players/nfl` | `players` | A few times per season (≤ 1x/day) |
| `sync-pids.ts` | DynastyProcess CSV | `player_ids` | Same as sync:players |

---

## Scores Page (`/scores`) — Client-Side Data

All matchup data is embedded at build time as a JSON blob via `define:vars`. Client JS handles all filtering and rendering. Key behaviors:
- Season default: latest year with matchup data
- Week default: max week present in that season's data (use numeric comparison — string sort breaks for weeks 1–9)
- Matchup grouping: skip entries where `matchup_id` is null/falsy (bye teams in playoff weeks cause `NaN` keys which crash rendering)
- Dynasty Bowl banner: Week 17 only; matched by resolving each team's effective abbr against `seasons` table conference champion fields

---

## Playoff Bracket (`/history/[year]`) — Clickable Matchups

The playoff bracket on season history pages is fully clickable. Each matchup links to its game recap page:

- **Round 1 matchups** (week 15): All first-round playoff games
- **Semifinal matchups** (week 16): Conference/division semifinals
- **Championship matchup** (week 17): Dynasty Bowl final

Clicking any matchup navigates to `/games/[year]/[slug]` where the slug is built using `buildSlug(teamA, teamB, week)`:
```
[week_zero_padded]-[abbr_a_sorted_lowercase]-[abbr_b_sorted_lowercase]
```

Example: `/games/2025/15-bkb-low` (BKB vs. LOW, week 15)

**Implementation details:**
- Each matchup div is wrapped in an `<a>` tag with no visual changes
- Teams are alphabetized before building the slug
- Matchups with missing team data (byes, incomplete brackets) gracefully render without links
- Replaces the previous playoff format text with "Click a matchup for more details →"

---

## `getStaticPaths` Rule

Astro's `getStaticPaths` runs in an isolated scope — module-level variables are NOT accessible inside it. All data loading (`import.meta.glob`, imports) must be re-initialized inside the function body. Vite deduplicates actual file reads at build time so there is no performance cost.

---

## Historical Matchup Lookup (`src/lib/get-historical-matchups.ts`)

Queries the `scdfl.matchups` table at build time to find historical instances of two teams playing. Used by `/spotlight-games/[slug].astro` to populate the "Historical Results" table.

- `getHistoricalMatchups(teamAAbbr, teamBAbbr)` resolves abbreviations to roster IDs via `franchises`, then queries `matchups`
- Returns array of matchups sorted newest-first (year desc, week desc)
- Each result includes: `year`, `week`, `teamAScore`, `teamBScore`
- Handles bye weeks correctly (null `matchup_id` entries are excluded by the query)

---

## Supabase Query Patterns

All build-time queries use the client at `src/lib/supabase.ts` with `.schema('scdfl')`.

**Important:** Supabase JS client silently caps results at 1,000 rows. For large tables (`matchups`: ~580, `transactions`: ~5,700, `nfl_stats`: ~95,000), always set an explicit `.limit()` or paginate. Small tables (`franchises`: ~22, `seasons`: ~6) are fine with defaults.

**Reserved word quoting:** The `"to"` and `"from"` columns in `franchises` are SQL reserved words. Always quote them in raw SQL. The Supabase JS client handles this automatically when using `.eq('to', null)` etc.

---

## Closing Claude Code Sessions

In most cases, if development is being done with AI assistance, all CLAUDE.md files should be reviewed, updated, and/or created to reflect the recent changes in the project. If work is being done in a focused environment, i.e. subdirectory, a CLAUDE.md file should be initialized or updated. The user will generally prompt this behavior.

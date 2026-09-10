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
- **`@astrojs/netlify` v6** — adapter required so individual routes can opt into on-demand (SSR) rendering. Pin to the 6.x line: 7.x needs Astro 6, 8.x needs Astro 7.
- **Tailwind CSS 4** — via `@tailwindcss/vite` (not PostCSS)
- **Supabase** — PostgreSQL database (schema `scdfl`); all league data lives here
  - Build-time / request-time client: `src/lib/supabase.ts` (uses `SUPABASE_ANON_KEY` via `import.meta.env`, falling back to `process.env` for SSR routes)
  - Sync scripts: `scripts/lib/*.ts` (use `SUPABASE_SERVICE_KEY` via `dotenv`)
- **Remark/Rehype** — custom plugin (`src/lib/remark-team-headers.ts`) for markdown AST transformation
- **Node 18+** — see `.nvmrc`; also pinned in `netlify.toml` to fix lightningcss binding issue
- No framework components (vanilla JS for all interactivity)
- **Shared page utilities** — `src/lib/franchise-identity.ts`, `src/lib/format.ts`, `src/lib/game-utils.ts`. See "Shared Utility Libraries" below — **always import from these** rather than writing a local `toRoman`/`franchiseForYear`/logo-path/slug-builder. A prior audit found these copy-pasted independently across 10+ pages; that is the failure mode to avoid.

---

## Routes

Every route is pre-rendered at build time (`output: 'static'`) **except** `/players/[id]`, which is rendered on demand — see "Rendering Modes" below.

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
| `/hall-of-fame` | `src/pages/hall-of-fame/index.astro` |
| `/hall-of-fame/champions` | `src/pages/hall-of-fame/champions.astro` |
| `/hall-of-fame/superlatives` | `src/pages/hall-of-fame/superlatives.astro` |
| `/hall-of-fame/medals` | `src/pages/hall-of-fame/medals.astro` |
| `/hall-of-fame/records` | `src/pages/hall-of-fame/records.astro` |
| `/hall-of-fame/inductees` | `src/pages/hall-of-fame/inductees.astro` |
| `/players/[id]` | `src/pages/players/[id].astro` (SSR) |

---

## Rendering Modes

The site default is `output: 'static'` — `npm run build` emits plain HTML for every route. `astro.config.mjs` also registers `adapter: netlify()`, which exists solely so a route can opt out of pre-rendering.

**`/players/[id]` is the only on-demand route.** Pre-rendering it meant one HTML file per started player, each firing ~8 Supabase queries at build time, which pushed Netlify builds past 15 minutes. It now carries:

```ts
export const prerender = false;   // no getStaticPaths — Astro errors if both are present
```

Consequences worth remembering:
- **Queries run per request, not per build.** Independent queries in that page are batched with `Promise.all`; only genuinely dependent lookups (roster → franchise, draft → drafts → drafter) stay chained. Keep it that way — each new serial `await` is latency on every pageview.
- **Supabase credentials are baked in at build, not read at runtime.** `import.meta.env.SUPABASE_URL` / `SUPABASE_ANON_KEY` are compile-time substitutions — Vite emits them as string literals into the SSR function bundle, so no runtime env var is required on Netlify. The `?? process.env` fallback in `src/lib/supabase.ts` only engages if the var was absent *at build time*. **Consequence: rotating the Supabase anon key requires a redeploy** — changing it in Netlify's environment variables alone leaves the old key compiled into the deployed function.
- **Build output.** The adapter writes a `.netlify/v1/functions/ssr` bundle (gitignored) alongside `dist/`. The function is registered at `/*` with `preferStatic: true`, so static files always win and only unmatched paths (player pages) invoke it.
- **A failed query degrades silently.** Supabase errors are ignored throughout the page (`.single()` results are read without checking `error`), so a transient network failure renders a player as "Free Agent" / "Undrafted" rather than erroring. At build time this was a one-off; at request time it can vary between pageviews.

To add another on-demand route: add `export const prerender = false`, delete its `getStaticPaths`, and confirm any data it needs is available from the runtime environment.

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

### Identity eras vs. displayed identities

A new era row is created for any `abbr` change, including a pure brand refresh with no rename (e.g. `TOH` → `TOR`, both "Toronto Hogs"). Era rows are the right granularity for *logo/color* resolution by year, but not for *narrative* display — listing "Toronto Hogs 2021–2022" above "Toronto Hogs 2023–present" reads as a rebrand that never happened.

The Identity History block on `franchises/[abbr].astro` therefore collapses **consecutive eras that share a `name`** into one entry (`identityGroups`), and renders nothing when the collapsed list has a single entry. Anything keyed on logos or abbrs (season-record logo column, `franchiseForYear`) must keep using the raw era rows.

---

## Shared Utility Libraries (`src/lib/`)

Common logic used across many pages lives in three small, focused lib files. **Import from these — do not write a local copy.** The codebase went through a full audit and consolidation pass specifically because this logic had been independently reimplemented (with subtly drifting behavior) across 10+ pages; that history is the reason these exist and the reason to keep using them.

### `src/lib/franchise-identity.ts` — franchise identity resolution
- `FranchiseRow` type — `{ id, sleeper_id, abbr, name, owner, conf, colors, from, to }`
- `franchiseForYear(rows, sleeperId, year)` — implements the adoption-logic query above in JS, over an already-fetched row set
- `activeFranchise(rows, sleeperId)` — current identity (`to IS NULL`)
- `franchiseByAbbrForYear(rows, abbr, year)` — reverse lookup; used for `seasons.scc_champion`/`hcc_champion`, which are stored as abbr strings
- `identityFor(rows, rosterId, year)` — convenience wrapper returning `{ abbr, activeAbbr, name }` (era abbr for logos, active abbr for `/franchises/[abbr]` links)
- `loadFranchises()` — fetches every row of `franchises` (all eras); the standard way to get a full identity table for a page

**Key join fact:** `franchises.id` is numerically identical to `Number(franchises.sleeper_id)` for every row (confirmed by direct query: `SELECT id, sleeper_id FROM scdfl.franchises WHERE id::text != sleeper_id` → zero rows), and `matchups.roster_id_a/b` equal `franchises.id`. So any numeric roster_id can be passed to these functions as `String(rosterId)` in place of a sleeper_id — there is no separate by-`id` lookup, and there shouldn't be.

### `src/lib/format.ts` — pure formatting helpers, zero dependencies
- `toRoman(n)` — Dynasty Bowl numbering (`toRoman(year - 2020)`)
- `ordinal(n)`, `pad2(n)`, `draftPickLabel(round, pickNo)`
- `formatPoints(n)` — null-safe `.toFixed(2)`, renders `—` for null/undefined
- `playerName(first, last, fallback)` — joins first/last, dropping whichever half is missing
- `espnHeadshotUrl(espnId)` — always returns a usable `src` (the site placeholder image if there's no `espn_id`), so callers can render an `<img>` unconditionally instead of branching
- `logoPath(abbr)` / `primaryColor(colors, fallback?)` — `/images/logos/{abbr}.png` and `colors[0]` with a `var(--border-default)` fallback
- `readableOnInk(color, ground?)` / `primaryColorOnInk(colors, fallback?)` — a club colour adjusted to read on the dark broadcast band. **Use these for any club accent placed on an ink ground**, never raw `colors[0]`: franchise palettes are authored for light surfaces, and several primaries (VAN `#0c152d`, NFD `#192f5d`) sit within a point of `--ink-900` and vanish on it. The helper raises lightness only, and only until it clears 3:1 (the WCAG threshold for non-text UI, which is what these accents are), so the club's hue survives — 10 of the 14 current primaries come back untouched. Searching the palette for a brighter entry instead is the tempting shortcut and the wrong one: it hands Vancouver its grey tertiary and Gold Coast a pink. Currently used by the homepage lede scorebug; the `/scores` ink panels and the homepage slate band are the obvious next consumers

This file has **no imports of its own** — that's deliberate, not an oversight. `src/lib/remark-team-headers.ts` runs inside `astro.config.mjs`'s evaluation context, before Vite env vars exist; anything it imports must not transitively pull in `src/lib/supabase.ts`, which crashes (`supabaseUrl is required`) if constructed at that point. `logoPath`/`primaryColor` live in `format.ts` rather than the more topically-obvious `franchise-identity.ts` specifically to keep this file import-safe for that plugin — don't move them there.

### `src/lib/game-utils.ts` — game/matchup helpers
- `buildSlug(abbrA, abbrB, week)` — canonical recap slug (see Slug Format below)
- `gameHref(year, week, sideA, sideB)` — full recap href, or `null` if either `SideIdentity` is unresolved
- `GAME_TYPE_LABEL` — `{ 0: 'Regular Season', 1: 'Playoffs', -1: 'Consolation' }`
- `isPlayablePostseasonGame(gameType, scoreA, scoreB)` — the shared "drop the still-0–0 Sleeper bracket placeholder" rule: regular season is always playable, postseason only once it's actually been scored
- `loadChampionshipMatchups()` — every played (not placeholder) week-17/`game_type=1` Dynasty Bowl across all seasons, `.limit(1000)` included

### `src/lib/nfl-state.ts` — live NFL state (Sleeper)
- `loadNflState()` — fetches `https://api.sleeper.app/v1/state/nfl`, returning `{ season, week, seasonType }`. **Every field is nullable**: a build with no network still has to produce a page, so callers fall back to archive-derived behaviour rather than treating this as required data.
- `activeWeekFor(state, year)` — the week a page should lead with, or `null` if the state is unusable or is for a different season. Encodes the preseason rule: Sleeper reports week 0 in the preseason and its preseason counter doesn't track the league schedule, so both cases resolve to Week 1.

**Why this exists:** `matchups` rows are created for the entire season the moment a Sleeper league is created, so "latest week with rows" runs *ahead* of the week actually being played. Any page that leads with "the current week" needs the real-world state, not the archive. Used by `index.astro` (which game leads the front page). `scores.astro` still carries its own inline copy of the fetch — converting it is a pending one-line cleanup, not a second intentional implementation.

### Scope: build-time only
These are for **frontmatter / build-time use**. A client-side `<script>` can only import them if the script has no `is:inline` attribute (Astro then bundles it through Vite, so a normal `import` resolves) — `scores.astro`'s script qualifies but currently still carries local copies of this logic as a deliberately deferred cleanup. `franchises/[abbr].astro`'s scripts use `is:inline` and cannot import at all, so their local `getIdentity`/`teamRow` duplicates are intentional, not a bug. Don't "fix" either without first resolving the `is:inline` question — that's a separate, riskier piece of work than the frontmatter consolidation.

---

## Slug Format (`/games/[year]/[slug]`)

```
[week_zero_padded]-[team_a]-[team_b]
```
- Week zero-padded to two digits (`04`, `17`)
- Teams sorted alphabetically by abbreviation, lowercase
- Example: `04-bkb-tor`, `17-chc-van`

Slugs are the canonical matchup identifier and the lookup key for recap content files. Implemented as `buildSlug(abbrA, abbrB, week)` in `src/lib/game-utils.ts` — always call it rather than reimplementing the pad/sort/join. Some pages wrap it in a thin local helper that accepts a richer object (e.g. `history/[year].astro`'s `buildSlug(teamA: StandingsRow, teamB, week)`, which extracts `.effectiveAbbr` and delegates) — that pattern is fine; a second from-scratch implementation is not.

---

## Content Collections (`src/content.config.ts`)

| Collection | Base path | Pattern | Notes |
|------------|-----------|---------|-------|
| `franchises` | `src/content/franchises/` | `**/*.md` | One file per franchise, filename = `abbr.toLowerCase()` |
| `writeups` | `src/content/writeups/` | `*.md` | Editorial writeups; `archive/` subdir excluded automatically |
| `recaps` | `src/content/recaps/` | `**/*.md` | Organized by season subdir: `recaps/[year]/[slug].md` |
| `homepage` | `src/content/homepage/` | `*.md` | Front-page editorial copy, one file per slot. `lede-blurb.md` is the centre lede |

### Astro 5 render() usage

```ts
// Correct — Astro 5 changed render() to a standalone function
import { getCollection, render } from 'astro:content';
const rendered = await render(entry);
const { Content } = rendered;
```

`entry.render()` does NOT exist in Astro 5.

---

## Design System — "Rust Belt Almanac × Northern Heritage"

The site was rebranded from the old dark "neon-noir" look to the **Sixth City DFL design system** (imported from the `claude_design` MCP project `SCDFL Design System`). Identity in one line: **cream/parchment ground (never white), warm-charcoal ink (never `#000`), a single `ember` primary, supporting `pine / wheat-gold / steel-slate`, unified by a Hudson's Bay point-blanket stripe, hexagon geometry, industrial + almanac type. No neon, no glow, no emoji.**

### Editorial direction (the part that matters most)

The palette and type are the *brand*; they are not a component kit. The site is **a small, obsessive sports publication and statistical archive**, not a SaaS product. Consistency comes from the brand, not from every block having the same geometry. Concretely:

- **Reach for a rule, a ledger, or a band before reaching for a box.** A card is for something that is genuinely a discrete object. Do not box content merely because it *can* be boxed. Stacks of identically-shaped panels are the failure mode — that is what the franchise sidebar, the Hall of Fame wing tiles, and the old homepage nav cards all were before they became ruled lists.
- **Avoid the eyebrow → heading → paragraph → CTA cycle.** Use `.almanac-head` (heading + right-hand `.folio`) instead. A section rarely needs a "View X →" link; a `.folio` count or an inline link in the prose usually carries it.
- **Vary the measure.** `.wrap` (1200), `.wrap-wide` (1460), `.wrap-narrow` (760), `.wrap-column` (560), plus `.measure` (66ch) for running serif prose. Breaking the 1200 grid deliberately — a full-bleed ink band, a narrow reading column — is the point, not an inconsistency.
- **Let content type drive treatment.** Standings look like standings (`.ledger`, dotted leaders, tabular figures), results look like a scoreboard (ink panels, mono figures, gold winner), records look archival, articles look editorial (drop cap, justified serif, narrow measure), franchise pages look like dossiers (club-tinted header band, stamped vitals).
- **Prefer real league material as the visual interest** — logos, scores, records, rivalries, colours, editorial copy — over decorative UI.

### Token files (`src/styles/tokens/`, imported by `global.css`)
`fonts.css` · `colors.css` · `typography.css` · `spacing.css` · `elevation.css` · `motion.css` · `base.css` (the `.sc-*` helpers). Copied largely verbatim from the design project — treat them as the source of truth and edit sparingly.

```css
/* Surfaces (cream) */          --surface-page  #F4ECD8   --surface-card  #FAF5E9
/* Ink (warm charcoal) */       --text-strong   #23201C   --text-muted    #5F574B
/* Brand roles */               --brand-primary ember(#C84B28)  --brand-secondary pine(#1C5B3A)
                                --brand-tertiary gold(#CCA52C)   --brand-cool slate(#335060)
/* Palette ramps */             --ember-*  --pine-*  --gold-*  --slate-*  --paper-*  --ink-*
/* Status (organic) */          win = pine · loss = ember · tie = slate
/* Type */  --font-display "Big Shoulders Display"  --font-serif "Spectral"
            --font-sans "Archivo"  --font-mono "Spline Sans Mono"
/* Signature */  .sc-stripe (HBC blanket)  .sc-eyebrow  .sc-tabular  .sc-data
                 .sc-chamfer  .sc-hex  .sc-paper (grain)  [data-theme="ink"] (broadcast band)
```

### Editorial primitives (`global.css`, `@layer components`)

Shared classes that implement the direction above. **Use these rather than inventing another local card.**

| Class | Purpose |
|-------|---------|
| `.wrap` / `.wrap-wide` / `.wrap-narrow` / `.wrap-column` | Page measures — 1200 / 1460 / 760 / 560, each with 1.5rem gutters |
| `.measure` / `.measure-tight` | 66ch / 52ch prose measure for running serif text |
| `.rule-heavy` / `.rule-mid` / `.rule-hair` / `.rule-dot` | Almanac rules; weight carries meaning (chapter / section / row / leader) |
| `.almanac-head` | Section heading + optional right-hand `.folio`. Replaces the eyebrow/heading/CTA stack |
| `.standfirst` | Italic serif line beneath a section head |
| `.ledger` | Archival record table: dotted leaders, tight rows, tabular figures, no shadow. Helpers: `.num`, `.rank`, `.ledger-break` |
| `.scoreline` | Posted-result layout with `.score` / `.winner` / `.loser` |
| `.band` / `.band-ink` | Full-bleed change of ground; `.band-ink` is the dark broadcast register |
| `.marginalia` | Narrow ruled column beside a main story |
| `.dropcap` | Editorial opening drop cap (ember) |
| `.slugline` | Mono metadata stamp |

The retained legacy classes (`.data-table`, `.franchise-card`, `.bowl-card`, `.page-title`) were **restyled toward print**: `.data-table` now uses a heavy header rule and dotted row leaders, the card classes are flat and ruled (no drop shadow, no hover lift), and `.page-title` is uppercase display.

### Layout chrome

`Layout.astro` renders an **almanac masthead**, not an app header:
- A nameplate that scrolls away (`.masthead-plate`) flanked by publication data — "Established 2021 / Cleveland, Ohio" and "Volume {N} / Fourteen Clubs". The volume is **derived, not queried** (`toRoman(leagueYear - 2020)`, league year rolling in March) because the masthead also renders on the on-demand `/players/[id]` route, where a DB round-trip would cost every pageview.
- A sticky **section rail** (`.section-rail`, ~34px tall) set in the display face and ruled rather than boxed, with an ember underline on the active section. Pages that stick their own control bar beneath it (see `/scores`) offset by `top: 34px`.
- A **colophon** footer — league blurb, index, and a typesetting note — rather than a nav footer.

The blanket stripe appears exactly twice per page, at the masthead and the colophon. Do not add a third; a second stripe within ~150px of the masthead reads as a repeated component rather than a motif.

### Honour marks

Franchise honours use the brand's own hexagon geometry, consistently across the homepage ledger, the franchise register, and the franchise dossier: `⬢` (`&#11042;`) Dynasty Bowl, `⬡` (`&#11041;`) runner-up, `▲` (`&#9650;`) conference title.

### Brand assets (`public/brand/`)
`emblem.svg` (header/favicon), `emblem_white.svg`. The Hudson's Bay stripe is a CSS gradient (`.sc-stripe`), not an asset. Real franchise logos stay in `public/images/logos/` — the design project's `assets/franchises/*` (a fictional demo world) are intentionally NOT used. **The emblem is a placeholder** pending the real league mark. Fonts + Phosphor icons load via CDN (open-license substitutions).

### Legacy `--color-*` bridge (important)
`global.css` keeps a **bridge** that remaps every retired dark-theme `--color-*` name onto the new palette (e.g. `--color-bg → --surface-page`, `--color-text-primary → --text-strong`, `--color-gold → --gold-700`, all `*-glow → *` flat tint). This inverts dark→light automatically, so pages authored against the old variables render correctly in the new brand. When touching a page, prefer the new semantic tokens directly; the bridge is a safety net, not the target.

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

## Hall of Fame (`/hall-of-fame`) — Wings & Derived Placements

Five wings hang off a lobby. The lobby's wing grid **is** the sub-navigation — there is no persistent tab bar; each wing links back with a `← Hall of Fame` breadcrumb.

| Wing | Slug | Source |
|------|------|--------|
| Champions | `champions` | `seasons` + `results` + `matchups` (weeks 15–17) |
| Superlatives | `superlatives` | `accolades` + `transactions` (trade awards) |
| Medals | `medals` | `v_medals` |
| Records | `records` | `matchups` + `v_player_starts` |
| Hall of Famers | `inductees` | None — placeholder/explainer until after Season 6 (2026) |

Shared loaders live in `src/lib/hall-of-fame.ts` (`loadSeasonPodiums`, `loadRecords`, `loadMedals`, `MEDAL_POSITION_ORDER`/`MEDAL_POSITION_COLOR`). Franchise identity helpers and `buildSlug`/`gameHref` live in `src/lib/franchise-identity.ts` and `src/lib/game-utils.ts` respectively (see "Shared Utility Libraries" above) — `hall-of-fame.ts` imports them rather than redefining them, and pages should do the same. The lobby reuses all of these for its "Recent Additions" module, so put new cross-wing data in `hall-of-fame.ts` rather than in a page.

### Placement is derived, not read from `results.finish`

`finish` records **regular-season** standing for non-playoff teams and does not distinguish the two semifinal losers. Two placements are therefore computed in `loadSeasonPodiums`:

- **3rd place** — winner of the Week 17 `game_type = -1` game whose two rosters are exactly the teams with `finish = 'Semifinals'`. Verified against all five completed seasons.
- **Consolation champion** — the non-playoff franchise (`playoff = false`) that won *every* one of its `game_type = -1` games in weeks 15–17. This bracket has no bearing on `finish`, draft order, or accolades, so the two genuinely disagree (2025: TOR finished 8th; IQT won the consolation).

A season is only "complete" when its Week 17 `game_type = 1` matchup has been played — `seasons` rows exist from the moment a league is created on Sleeper, so never treat `MAX(year)` as a finished season.

### Award category is inferred, not stored

`accolades` has no category column. Exactly one of `player_id` / `sleeper_id` / `transaction_id` is non-null, and that determines whether the row is a player, manager, or trade award. Branch on it — do not key off `award_code`.

**Trade awards are not necessarily two-team.** The 2025 `badtrade` is a three-team deal, so trade cards render one column per participating `roster_id` (`--side-count` drives the grid), never a fixed two-logo layout.

### Medals are gold-only

`v_medals` emits `row_number() = 1` per position per season across weeks 1–14 — one winner, no silver or bronze. The leaderboard is a career count of those. Defensive positions (DL/LB/DB) only appear from 2022, when IDP slots entered the league. Adding tiers would mean widening the view, not changing the page.

---

## `getStaticPaths` Rule

Astro's `getStaticPaths` runs in an isolated scope — module-level variables are NOT accessible inside it. All data loading (`import.meta.glob`, imports) must be re-initialized inside the function body. Vite deduplicates actual file reads at build time so there is no performance cost.

Applies to pre-rendered routes only. On a route with `prerender = false`, `getStaticPaths` is meaningless and Astro errors if it is left in — read `Astro.params` directly instead.

---

## Historical Matchup Lookup (`src/lib/get-historical-matchups.ts`)

Queries the `scdfl.matchups` table at build time to find historical instances of two teams playing. Used by `/spotlight-games/[slug].astro` to populate the "Historical Results" table.

- `getHistoricalMatchups(teamAAbbr, teamBAbbr)` resolves abbreviations to roster IDs via `franchises`, then queries `matchups`
- Returns array of matchups sorted newest-first (year desc, week desc)
- Each result includes: `year`, `week`, `teamAScore`, `teamBScore`
- Handles bye weeks correctly (null `matchup_id` entries are excluded by the query)
- Postseason placeholder filtering uses `isPlayablePostseasonGame` from `src/lib/game-utils.ts` (see "Shared Utility Libraries" above)

---

## Supabase Query Patterns

All build-time queries use the client at `src/lib/supabase.ts` with `.schema('scdfl')`.

**Chain order and formatting (standardized — follow it for every new query):** `.schema('scdfl')` → `.from(table)` → `.select()`/write op → filters (`.eq`/`.is`/`.in`/`.lte`/`.gte`/`.or`/`.not`) → `.order()` → `.limit()` → `.single()`, **one method per line**:
```ts
const { data, error } = await supabase
  .schema('scdfl')
  .from('franchises')
  .select('id, sleeper_id, abbr, name, owner, conf, colors, "from", "to"')
  .eq('abbr', abbr)
  .is('to', null)
  .single();
```
`src/` uses single quotes throughout; `scripts/` uses double quotes — each is internally consistent, don't mix within a file.

**Before hand-writing a query, check whether a shared loader already exists:** `loadFranchises()` (all `franchises` rows, all eras) and `loadChampionshipMatchups()` (every played Dynasty Bowl, `.limit(1000)` and postseason-placeholder filtering included) in `src/lib/franchise-identity.ts`/`src/lib/game-utils.ts` cover two of the most commonly repeated queries — see "Shared Utility Libraries" above. `loadSeasonPodiums`/`loadRecords`/`loadMedals` in `src/lib/hall-of-fame.ts` cover the Hall of Fame-specific ones.

**Important:** Supabase JS client silently caps results at 1,000 rows. For large tables (`matchups`: ~580, `transactions`: ~5,700, `nfl_stats`: ~95,000), always set an explicit `.limit()` or paginate. Small tables (`franchises`: ~22, `seasons`: ~6) are fine with defaults.

**Reserved word quoting:** The `"to"` and `"from"` columns in `franchises` are SQL reserved words. Always quote them in raw SQL. The Supabase JS client handles this automatically when using `.eq('to', null)` etc.

---

## Closing Claude Code Sessions

In most cases, if development is being done with AI assistance, all CLAUDE.md files should be reviewed, updated, and/or created to reflect the recent changes in the project. If work is being done in a focused environment, i.e. subdirectory, a CLAUDE.md file should be initialized or updated. The user will generally prompt this behavior.

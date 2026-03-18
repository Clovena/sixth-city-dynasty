# CLAUDE.md — Sixth City Dynasty Fantasy Football League Site

Astro 5 static site for the SCDFL. Commissioner: Zac. Est. 2021. 14 franchises, two conferences (SCC, HCC), annual Dynasty Bowl championship.

---

## Commands

```bash
npm run dev          # dev server
npm run build        # static build → dist/
npm run preview      # preview built site
npm run fetch        # fetch current season from Sleeper API
npm run fetch -- --all  # fetch all seasons from Sleeper API
```

---

## Tech Stack

- **Astro 5** — static output, content collections, `import.meta.glob`
- **Tailwind CSS 4** — via `@tailwindcss/vite` (not PostCSS)
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

---

## Data Files (`src/data/`)

| File | Purpose |
|------|---------|
| `franchises.json` | All 14 franchise records (see schema below) |
| `seasons.json` | Per-season results: conference champions, dynasty bowl, format, notes |
| `results.json` | Per-franchise season stats keyed by abbr (wins, losses, PF, PA, playoff, finish) |
| `config.json` | Sleeper league IDs per season; `current: true` flags the active season |
| `raw/[year]-rosters.json` | Raw Sleeper roster data — written by fetch script |
| `raw/[year]-matchups.json` | Raw Sleeper matchup data keyed by week number — written by fetch script |
| `raw/nfl-state.json` | Raw NFL state (current week, season type) — written by fetch script |

---

## Franchise Schema (`franchises.json`)

```jsonc
{
  "id": 1,               // numeric roster_id — maps directly to roster_id in Sleeper API
  "sleeper_id": "1",     // string version of id — legacy, identical to id
  "abbr": "TOR",         // current abbreviation (also used for logo filename)
  "name": "Toronto Hogs",
  "owner": "Zac",
  "conference": "SCC",   // "SCC" or "HCC"
  "colors": ["#4f4471", "#ea332a", "#7a709b"],
  "founded": 2023,       // year this ownership began; 2021 = original franchise
  "predecessor_abbr": "TOH",   // abbr of predecessor team (only if founded != 2021)
  "rebrands": [          // name history for adopted teams across pre-founding seasons
    { "year": 2021, "name": "Toronto Hogs" },
    { "year": 2022, "name": "Toronto Hogs" }
  ]
}
```

### Adoption logic (important — used in multiple places)

A franchise is **adopted** when `founded !== 2021`. For adopted franchises:
- Seasons **before** `founded`: display `predecessor_abbr` logo, look up name from `rebrands[].name` by year
- Seasons **on or after** `founded`: display current `abbr` logo and `name`

This affects: franchise pages (`[abbr].astro` season table), scores page team display, game recap pages.

The founding year `2021` is a safe hard-coded constant — it will never change.

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

## Sleeper API Fetch Scripts (`scripts/`)

```
scripts/
  fetch-sleeper.ts      # orchestrator — run via npm run fetch
  lib/
    sleeper-api.ts      # typed API wrappers (getRosters, getMatchups, getNflState, etc.)
    transform.ts        # buildSeasonStats() — returns { year, wins, losses, points_for, points_against }
```

- `npm run fetch` fetches current season only (weeks 1 → `nflState.week` for matchups)
- `npm run fetch -- --all` fetches all seasons (weeks 1–17 for non-current seasons)
- Writes raw JSON to `src/data/raw/`
- Merges wins/losses/PF/PA into `results.json` — preserves `playoff` and `finish` fields (manually maintained)
- `franchise.id` (number) === Sleeper `roster_id` — use this for all roster_id → franchise lookups
- `custom_points` takes precedence over `points` for score display; coalesce null with `|| 0`

---

## Scores Page (`/scores`) — Client-Side Data

All matchup data is embedded at build time as a JSON blob via `define:vars`. Client JS handles all filtering and rendering. Key behaviors:
- Season default: latest year whose matchup file is non-empty (`Object.keys(data).length > 0`)
- Week default: max week present in that season's data (use numeric comparison — string sort breaks for weeks 1–9)
- Matchup grouping: skip entries where `matchup_id` is null/falsy (bye teams in playoff weeks cause `NaN` keys which crash rendering)
- Dynasty Bowl banner: Week 17 only; matched by resolving each team's effective abbr against `seasons.json dynasty_bowl.winner/loser`

---

## `getStaticPaths` Rule

Astro's `getStaticPaths` runs in an isolated scope — module-level variables are NOT accessible inside it. All data loading (`import.meta.glob`, imports) must be re-initialized inside the function body. Vite deduplicates actual file reads at build time so there is no performance cost.


## Closing Claude Code Sessions

In most cases, if development is being done with AI assistance, all CLAUDE.md files should be reviewed, updated, and/or created to reflect the recent changes in the project. If work is being done in a focused environment, i.e. subdirectory, a CLAUDE.md file should be initialized or updated. The user will generally prompt this behavior. 

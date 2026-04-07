# Sixth City Dynasty Fantasy Football League

Official website for the Sixth City Dynasty Fantasy Football League (SCDFL) — a 14-team dynasty fantasy football league founded in 2021, hosted on Sleeper. Commissioner: Zac.

## Setup

```bash
npm install
```

Requires a `.env` file with:
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — public anon key (used at build time by Astro pages)
- `SUPABASE_SERVICE_KEY` — service role key (used by sync scripts for write access)

## Development

```bash
npm run dev
```

Open [http://localhost:4321](http://localhost:4321) in your browser.

## Build

```bash
npm run build
```

Output goes to `dist/`.

## Preview production build

```bash
npm run preview
```

## Data Syncing

All league data lives in Supabase (schema `scdfl`). Sync scripts fetch from external APIs and write directly to the database.

```bash
# Routine syncs — run weekly during the NFL season
npm run sync              # all routine syncs (results, matchups, rosters, transactions, drafts, exhibitions, stats)
npm run sync:results      # win/loss/points per franchise per season
npm run sync:matchups     # all weekly matchups (regular + playoff + consolation)
npm run sync:rosters      # current-season roster assignments
npm run sync:transactions # all transactions (waivers, trades, free agents)
npm run sync:drafts       # draft pick results for all configured drafts
npm run sync:exhibitions  # exhibition matchup scores
npm run sync:stats        # weekly NFL player stats from nflverse

# Player metadata — run sparingly (heavyweight API calls)
npm run sync:players      # Sleeper player database (~20k+ players, ≤ 1x/day)
npm run sync:pids         # DynastyProcess player ID crosswalk (ESPN, PFF, etc.)
npm run sync:player-meta  # sync:players then sync:pids sequentially
```

See [`scripts/lib/CLAUDE.md`](scripts/lib/CLAUDE.md) for full details on each script, data flow, and debugging.

## Git Workflow

This project uses two primary branches:

- **`dev`** — the active development branch. All feature work and updates should target this branch. Changes can be committed and pushed immediately; this branch does not trigger deployments.
- **`main`** — production branch. Syncs to `main` trigger automatic Netlify builds and deployments. Merges into `main` should be infrequent and deliberate, and only happen when a sufficient number of changes are ready for production.
- **`debug`** - troubleshooting and problem-solving branch. When using, best practice is to `git pull` from main and dev first to ensure the most recent versions of files.

**Feature branches** should be created off `dev` for larger or longer-running work. Merge back into `dev` via pull request.

## Deployment

The site deploys automatically to Netlify on push to the main branch. Build config is in `netlify.toml`.

## Stack

- [Astro 5](https://astro.build/) — static site generator with content collections
- [Tailwind CSS 4](https://tailwindcss.com/) — styling (via `@tailwindcss/vite`)
- [Supabase](https://supabase.com/) — PostgreSQL database (schema `scdfl`)
- [Netlify](https://netlify.com/) — hosting and deployment
- Node 18+ (see `.nvmrc`)

## Content

| Source | What it drives |
|--------|---------------|
| `scdfl.franchises` | Every franchise page, index cards, name/color/owner lookups sitewide |
| `scdfl.seasons` | History page, roll of honor, conference champions |
| `scdfl.results` | Per-franchise season stats (wins, losses, points) used throughout |
| `scdfl.matchups` | Scores page, game recap pages, playoff brackets |
| `scdfl.spotlight_games` + `spotlight_game_years` | Spotlight games index and individual game pages |
| `scdfl.exhibitions` + `exhibition_matchups` | Exhibition game cards and recaps |
| `scdfl.drafts` + `draft_results` | Draft board displays on history pages |
| `scdfl.transactions` | Transaction audit and franchise activity |
| `scdfl.players` + `player_ids` / `v_players` | Player names, headshots (ESPN CDN), and metadata |
| `scdfl.nfl_stats` | Weekly NFL player stat breakdowns |
| `scdfl.rosters` | Current-season roster assignments |
| `scdfl.accolades` | Annual league awards |
| `src/content/franchises/*.md` | Franchise notes (Markdown, one per franchise) |
| `src/content/writeups/*.md` | Editorial writeups |
| `src/content/recaps/[year]/*.md` | Game recap narratives |

---

## Architecture

### How the site is built

Astro is a static site generator — at build time (`npm run build`), it queries Supabase for all league data, renders every page to plain HTML, and drops it in `dist/`. The dev server (`npm run dev`) does this on the fly so changes show instantly. There's no runtime server — just static files served by Netlify.

### The data layer

All league data lives in the `scdfl` schema in Supabase. At build time, Astro pages query the database through the client at `src/lib/supabase.ts` (using the anon key). Sync scripts in `scripts/lib/` populate the database from external APIs (Sleeper, nflverse, DynastyProcess) using the service key.

The schema includes 16 tables and 1 view. Some tables are manually maintained by the commissioner (franchises, seasons, drafts, exhibitions, spotlight games, accolades), while others are populated by sync scripts. See [`src/data/CLAUDE.md`](src/data/CLAUDE.md) for full schema documentation and [`SUPABASE_DEFINITIONS.sql`](SUPABASE_DEFINITIONS.sql) for the DDL.

### Page routes

```
URL                              File
/                                src/pages/index.astro
/history                         src/pages/history.astro
/franchises                      src/pages/franchises/index.astro
/franchises/TOR                  src/pages/franchises/[abbr].astro     ← generates 14 pages
/spotlight-games                 src/pages/spotlight-games/index.astro
/spotlight-games/atom-bowl       src/pages/spotlight-games/[slug].astro ← generates per spotlight game
/scores                          src/pages/scores.astro
/games/2025/04-bkb-tor           src/pages/games/[year]/[slug].astro   ← generates per matchup
/content                         src/pages/content.astro
```

Files in `[brackets]` are dynamic routes. The `getStaticPaths()` function at the top of each tells Astro which pages to generate. At build time these become individual HTML files.

### Shared infrastructure

**`src/layouts/Layout.astro`** — every page wraps itself in this. It provides the `<html>` shell, the sticky header with nav, and the footer. Pages fill the `<slot />` in the middle.

**`src/styles/global.css`** — imported by the Layout, applies everywhere. The `@theme` block defines CSS custom properties (`--color-gold`, `--font-display`, etc.) referenced throughout. The `@layer components` block defines reusable classes like `.franchise-card`, `.data-table`, `.label-badge`.

### Franchise markdown notes

`src/content/franchises/tor.md` (one per franchise, lowercase filenames) — loaded on individual franchise pages via Astro's content collection API (`getEntry('franchises', abbr.toLowerCase())`). They render as the "Franchise Notes" section. Everything else on the franchise page comes from Supabase.

### Team logos

PNGs go in `public/images/logos/` named by abbreviation (`TOR.png`, `BKB.png`, etc.). The `public/` folder is served as-is — `public/images/logos/TOR.png` becomes `/images/logos/TOR.png` in the browser. All logo `<img>` tags use `onerror="this.style.display='none'"` so a missing file degrades gracefully.

### Tracing a bug

1. Identify the URL → find the corresponding file in the route table above
2. Check the Supabase query in that `.astro` file — all data fetching happens at the top of the frontmatter
3. Look for the specific HTML structure — all styling is inline `style=""` attributes or Tailwind classes, so what you see in devtools maps directly to what's in the file

# CLAUDE.md — Pages (`src/pages/`)

---

## Mobile Responsive Strategy

Breakpoint: `@media (max-width: 768px)`. All mobile overrides use scoped `<style>` blocks at the bottom of each page file (Astro scoped styles apply to class names defined in the same component).

### General patterns applied across pages
- Multi-column grids collapse to `1fr` via `!important` (necessary to override inline styles)
- Elements hidden on mobile use `display: none !important`
- Sidebar/secondary columns move below main content rather than disappearing
- Dynamic border colors are encoded as CSS custom properties on the element (e.g. `--team-b-color: ${teamB?.colors[0]}`) so they can be switched sides (`border-right` → `border-left`) from scoped CSS

---

## Per-Page Mobile Notes

### `index.astro`
Rebuilt as an **almanac front page**, not a landing page. No section-nav cards, no CTA row. Structure, top to bottom:
- `.front-page` — a deliberately asymmetric three-column grid (`260px | 1fr | 230px`): editorial rail (newest writeup preview), centre lede (see below), right rail (the record book extremes). The old "Season Ahead" rail — season blurb, charities played for, derived standing facts — was removed outright; the editorial preview took its column, and moved up from a full-bleed band lower on the page.

**Column order is CSS, not DOM order.** The DOM is lede → editorial → record book, which is the reading order wanted when the grid collapses. Desktop puts the editorial back on the left with `order`. Three states:
- **>1080px** — three columns, `order` 1/2/3 placing editorial | lede | record book
- **≤1080px** — two columns via *explicit* `grid-column`/`grid-row`: lede row 1 col 1, editorial row 2 col 1, record book spanning `1 / span 2` in col 2. The span matters — without it a tall record book forces row 1 tall and strands white space under the short lede
- **≤760px** — one column; the explicit placement is *released* (`grid-column: auto; grid-row: auto; order: 0`) so DOM order applies: lede, editorial, record book

Changing any of these three requires checking the other two — they are not independent, and the ≤760 rules undo the ≤1080 rules rather than restating them.

The editorial preview is sized for a column at rail width: no justification and no `.dropcap`, both of which need a much wider measure than 260px. At ≤1080 it widens to `66ch` with a larger head.

**The centre lede is half editorial, half live data — keep the halves separate.**
- *Copy* comes from the `homepage` content collection (`src/content/homepage/lede-blurb.md`): `title` sets `.lede-head`, `subtitle` sets `.lede-head-tail`, and the markdown body renders into `.lede-body`. Because that body is markdown output it carries **no scope attribute**, so its `<p>` is styled through `.lede-body :global(p)` — see root CLAUDE.md's "Scoped Styles & Markdown-Rendered Content".
- *The game* is never authored. It is the **first matchup (by `matchup_id`) of the live NFL week**, resolved via `loadNflState()`/`activeWeekFor()` from `src/lib/nfl-state.ts`, so the front page turns over with the schedule. Do not switch this to "latest week with rows" — `matchups` holds the whole season from the day the Sleeper league is created, so that reads ahead of the week being played. The week clamps down to a week that actually has rows, and falls back to the first week of the schedule if the state fetch fails.
- *Winner formatting* (`.lede-num.win`, gold) is gated on `status: "final"` in the markdown frontmatter — `scheduled` and `active` render both figures neutral no matter how they sit. The credit line's last link follows the same gate ("Full box score" vs "Matchup detail").
- *Club keels* — the scorebug carries each side's accent as a border, team A left and team B right, passed in as `--side-a`/`--side-b` inline custom properties from `primaryColorOnInk()`. Do not use raw `colors[0]` here; the slab is `--ink-900` and several club primaries are near-black against it (see root CLAUDE.md's format.ts notes).
- There is no longer an issue-date slug above the headline; the article starts at `.lede-head`.
- **The page is static, so the lede is only as current as the last build** — a week rolls over on Sleeper without the site changing until it rebuilds.
- `.slate-band` — full-bleed ink band showing the latest played week, or the **next set of fixtures** when the season has not started (`slateIsFixtures`); ruled columns, not boxes, so an incomplete last row reads as a list rather than an empty tile
- `.two-up` — all-time `.ledger` (1.75fr) beside the champions roll (1fr)
- Bowl games index — the current season's **bowl games only**, dense and multi-column. `spotlight_games.type` also carries `'rivalry'`, which is filtered out at the data step (`bowlGames`): Rivalry Week is redrawn every season and carries no history of its own, so it doesn't belong in a standing index. The section's classes are `.bowl-*` (scoped to this page); there is no longer a `.named-*` anything
- Almanac facts (e.g. "No. 1 seeds are 0–3 in Dynasty Bowls") are **derived from `results`**, never hardcoded, so they stay true as seasons are added
- Breakpoints: see the three front-page grid states above; 520px additionally collapses the record book to one column and shrinks the scoreboard

### `history/index.astro`
Reframed as **the archive**: a large `.archive-plate` title, prose at a real measure with a `.archive-margin` counts column beside it, then a `.ledger` of seasons (bowl numeral, year + charity, both conference champions, champion, runner-up, final score), and playoff-format notes as two ruled columns. The Roll of Honor was removed — the seasons ledger already names every champion, so it was a second listing of the same facts.
- Season ledger wraps in `.ledger-scroll` and hides `.col-hide-mobile` columns under 768px
- The champion cell's flex box sits on an inner `<span>`, not the `<td>` — making a `<td>` a flex container drops it out of table layout and its rule stops short of the row
- **`.season-ledger td` overrides `vertical-align` to `middle`.** The shared `.ledger td` uses `baseline`, and a flex container takes its baseline from its first item — here the 24px logo, whose baseline is its bottom edge. That sits well below the text baseline of the neighbouring cells, so baseline alignment drags the champion cell's content visibly upward. Don't revert this to inherit from `.ledger` without re-checking that column

### `history/[year].astro`
- Final Standings grid goes vertical (HCC below SCC, each full width)
- Playoff bracket `bracket-wrap` goes vertical
- **Playoff bracket interaction**: All matchup elements are clickable links to game recaps. Each matchup wraps in an `<a href="/games/{year}/{slug}">` tag where slug is built using a local `buildSlug(teamA, teamB, week)` that takes `StandingsRow` objects and delegates to the shared `buildSlug(abbrA, abbrB, week)` in `src/lib/game-utils.ts` — see root CLAUDE.md's "Shared Utility Libraries":
  - Round 1: week 15
  - Semifinals: week 16
  - Championship: week 17
  - Teams in slug are alphabetized and lowercased (e.g., `15-bkb-low`)
  - Matchups without both teams (byes, incomplete) skip the link wrapper
- Text above bracket changed from "{teamCount}-team field • ..." to "Click a matchup for more details →"

### `franchises/[abbr].astro`
Opens with a **dossier header** (`.dossier`): a full-bleed band tinted with the club's own primary (`color-mix` over the page ground) and keeled with it on top, carrying the crest, the name at display scale, and `.dossier-vitals` — all-time record, pct, seasons, points for — as a stamped mono block, with honours on a ruled strip below.
- The old "Franchise Facts" sidebar panel was **removed**: the dossier header already carries every number it held
- The remaining sidebar is `.dossier-margin` — ruled `<section>`s (Dynasty Bowl history, conference titles, bowl games, rivalry week), not a stack of five identical boxes
- Section headings use `.sect-head` (display caps over a heavy rule)
- Sidebar moves below Main column at full width; Season Record table hides PF and PA columns

### `spotlight-games/index.astro`
Rebuilt as a **named-games index**. The two definition panels are ruled columns (`.explain-grid` / `.explain-col`), not tinted boxes, and both slates render as one `.game-list` — crest pair, game name at display scale, the two clubs each underlined in their own primary via a `--c` custom property, a one-sentence description, and an `est./inaugural` stamp in the right margin.
- Both slates come from a single template loop over a `[{ title, folio, games, kind }]` array; a slate with no games renders nothing
- `.explain-grid` stacks at 860px; at 768px `.game-stamp` moves under the body and the crest column stays

### `spotlight-games/[slug].astro`
- Fetches historical matchup data via `getHistoricalMatchups(teamA, teamB)` which scans all `/data/raw/*-matchups.json` files to find instances where both teams played in the same week with matching `matchup_id`
- Historical Results table displays: Year | Week | Team A | Score A | Score B | Team B with winner highlighted in gold, loser muted
- Score boxes and column widths use `min-width` to ensure consistent vertical alignment across all matchup rows
- `.matchup-card-grid`: 3-col (A | vs | B) collapses to single column; Team B's color border swaps from right to left via `--team-b-color` CSS variable
- `.matchup-desc-grid`: "About This Matchup" + "Historical Results" stack vertically

### `scores.astro`
Presented as a **scoreboard**. A `.plate` title, a sticky `.score-bar` control strip (offset `top: 34px` to clear the section rail) whose season/week `<select>`s are styled as underlined display-face controls rather than form fields, then ink `.matchup-card` panels with mono figures and a gold winner.
- Two-up grid (`repeat(auto-fill, minmax(360px, 1fr))`), one-up under 768px where the control bar also stops sticking
- A week with no scores yet renders as **fixtures**, not a wall of `0.00`: `weekScheduled` is computed per week in `renderScores`, `teamRow` takes a `scheduled` flag and emits `·` in place of the figure, and a "Week N · Scheduled" label is prepended
- JS-generated markup uses `.scores-section-label` (not the global `.section-label`) so it stays legible against the cream ground while the panels are ink

### `content.astro`
The **editorial** register. A `.desk-plate` title, an optional `.desk-bar` "Now reading" strip (the piece `<select>`, styled as an underlined display-face control), and the article itself centred at `.wrap-narrow` with a `.piece-head` (mono slug + display title over a heavy rule) and a drop cap on the first paragraph.
- **The print packer depends on DOM shape**: it reaches for `article > div:first-child` as the title block and expects a `<p>` and an `<h2>` inside it, so `.piece-head` must stay a `<div>` holding exactly that
- The drop cap is applied via `.writeup-content :global(p:first-of-type)::first-letter`, a screen-only selector — the packer rebuilds the content DOM for print, so it correctly stops matching there

### `games/[year]/[slug].astro`
- `.lineup-grid`: 2-col side-by-side roster view collapses to 1 column
- CSS `order` property resequences grid items so all Team A rows render first, then Team B header (`order: 50`), then all Team B rows (`order: 51`)
- `.lineup-row-b` gets `flex-direction: row` on mobile (was `row-reverse` on desktop) so element order matches Team A: pos | thumb | name | score
- Team A `border-right` removed (no adjacent column on mobile)

### `hall-of-fame/index.astro`
- Hero is a `data-theme="ink"` broadcast band (dark section on the cream page) — it re-scopes the colour tokens, so any child must use semantic tokens, not hardcoded light values. It carries **no `.sc-stripe`**: the masthead already has one, and a second within ~150px reads as a repeated component
- The five wings render as `.wing-index` — a numbered, ruled **table of contents** with each wing's own tally (`wing.note`), not five identical tiles
- The locked "Hall of Famers" row is inert (`<div>`, not `<a>`) and styled as anticipated, with "Opens after Season VI" in place of a tally
- Recent additions are a ruled `.recent-index`, one entry per wing, rather than four cards

### `hall-of-fame/champions.astro`
- `.podium` is a 3-column grid rendered silver | gold | bronze so the champion sits centred; differing top/bottom padding per tier builds the podium silhouette
- On mobile the grid collapses to 1 column and `--stack-order` (set inline per tier) drives CSS `order` so the champion leads
- `season-card-foot` (conference titles + consolation) collapses to 1 column
- Logos use the **era** abbr (`entry.abbr`); links use the **active** abbr (`entry.activeAbbr`)

### `hall-of-fame/superlatives.astro`
- `award-grid` is `auto-fill, minmax(320px, 1fr)` → 1 column on mobile
- `trade-sides` uses `grid-template-columns: repeat(var(--side-count), 1fr)` so a three-team trade renders three columns; collapses to 1 column on mobile
- Timeline rows are unadorned — repeat winners are deliberately **not** highlighted (an earlier ember-spine treatment was removed)

### `hall-of-fame/medals.astro`
- Card-per-position timelines, deliberately mirroring `superlatives.astro` — no table, no sorting, no client JS. One `.medal-card` per position, each holding a year-by-year `.timeline` newest-first, so a new season appends a row to eight existing cards rather than reshuffling a leaderboard
- `sections` (frontmatter) drives both bands from one template loop: Offense (QB/RB/WR/TE) and Kicker & Defense (K/DL/LB/DB). A section with no cards is filtered out, so the IDP band would disappear rather than render empty
- Card accent is set per-position from `MEDAL_POSITION_COLOR` as inline `--accent` / `--accent-surface` custom properties (top border + head tint). DL/LB/DB all map to `idp`, so the three defensive cards intentionally share a colour
- Card head is just the position chip + full position name; timeline rows are unadorned. No repeat-winner highlight and no per-card counts — both were tried and cut
- Logos use the **era** abbr (`win.abbr`); the link uses the **active** abbr (`win.activeAbbr`)
- `.medal-grid` is a fixed 2-up that collapses to 1 column at 900px

### `hall-of-fame/records.astro`
- Rows are clickable to `/games/[year]/[slug]` via `onclick`; the player-name link inside calls `event.stopPropagation()` so it wins over the row handler
- All columns except rank, score, and the subject are `col-hide-mobile`, and the wrapper drops `overflow-x` on mobile

### `hall-of-fame/inductees.astro`
- Placeholder wing. Season numbering is derived (`SEASON_ONE_YEAR = 2021`), and "complete" is judged by a played Week 17 `game_type = 1` matchup, not by a `seasons` row existing
- The gallery preview is `aria-hidden` and deliberately inert — dashed plaques showing the future grid shape

### `players/[id].astro`
- **Only on-demand (SSR) route on the site** — `export const prerender = false`, no `getStaticPaths`. Data is fetched per request, so independent Supabase queries are batched in one `Promise.all` and only the roster→franchise and draft→drafts→drafter chains stay sequential. Adding a serial `await` here costs every visitor, not the build.
- Page wrapper (`player-page-wrap`) constrains to screen width with `overflow-x: hidden` and tighter padding
- Hero section reduces padding/margin
- Layout grid (`player-layout-grid`) stacks to single column; sidebar moves below stats
- Bio grid collapses from 3 to 2 columns
- Stats table: all position-specific stat columns hidden via `col-hide-mobile` class; only Year, GS, and FPTS remain
- Stats table wrapper switches from `overflow-x: auto` to `hidden` (no horizontal scroll needed with reduced columns)

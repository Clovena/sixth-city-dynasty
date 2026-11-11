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
- `.front-page` — a two-column grid (`1fr | 260px`): the centre lede — **the playoff picture** — and the **score rail**, which opens with the featured game. Both the old "Season Ahead" rail and the editorial-preview rail that replaced it have been removed; the record book that used to hold the right rail now lives in its own horizontal band at the foot of the page.

**Column order is CSS, not DOM order.** The DOM is lede → score rail, which is also the reading order wanted when the grid collapses, so `order` only does desktop placement and ≤760 simply releases it (`order: 0`).

**The centre lede is the playoff picture** (`<PlayoffBracket>`, data from `loadSeasonPicture` — see root CLAUDE.md). It replaced the editorial headline and blurb.
- **Which season:** `ledeYear` (the live Sleeper season when it has matchups), unless that season's phase is `pre` — then the latest season with a played Dynasty Bowl, so the offseason front page shows the last real bracket rather than a 0–0 projection.
- **Phase sets the heading**, set in the big display `.lede-head` with a `.lede-head-tail`: `regular` → "Playoff Picture / If the season ended after Week N" (projected, unlinked, with the seeding rule and a link to `/sim` in `.lede-credit`); `post` → "{year} Playoffs"; `complete` → "Dynasty Bowl N / {champion}, champions", linking to that season's history page.
- `N` is `lockedThrough` (weeks Sleeper has finalized), not the live week.

**The score rail (`.rail-right`) is the featured game, then the week's remaining games.**
- *The featured game* is the old centre scorebug, restacked for rail width (`.feature-*`): each side is a `crests | label | figure` row keeled on the left in its club colour (`--keel` from `primaryColorOnInk()` — the ground is `--ink-900`; don't use raw `colors[0]`). **An exhibition in the live week is featured**; failing that, the **first matchup (by `matchup_id`) of the live NFL week**, resolved via `loadNflState()`/`activeWeekFor()` from `src/lib/nfl-state.ts`. Do not switch this to "latest week with rows" — `matchups` holds the whole season from the day the Sleeper league is created. The week clamps down to a week that actually has rows, and falls back to the first week of the schedule if the state fetch fails. The frontmatter still uses the `lede*` names (`ledeGame`, `LedeSide`, `clubSide()`/`squadSide()`) from when this game was the lede.
- *Squad sides* (`.is-squad`, exhibition) split one crest's width between their members (`--n`), so the figures stay in one column.
- *The rest of the week* is the `slate` data. **The featured game is filtered out of it** — matched on the full `year`/`week`/`matchup_id` key, so nothing is dropped when the featured week and the slate week differ (they do whenever the live week has no rows yet). Each game stacks its two sides (`.rail-side`, a `22px | 1fr | auto` grid) so the figures form one right-aligned column.
- The rail carries `data-theme="ink"` and an `--ink-900` background. **That attribute re-scopes the colour tokens**, which is why the rules underneath use semantic names (`--text-strong`, `--border-default`, `--rule-ink`, `--text-link`) and flip automatically. Three values deliberately don't: the hover wash, the winner gold (`--gold-400` — pine goes muddy here), and the resting figure colour, the ramp value `--paper-200`.
- *Winner formatting* is gated on `status: "final"` in `src/content/homepage/lede-blurb.md`, via `weekIsFinal`. **That flag governs both scorebugs in the rail.** While it reads `scheduled` or `active`, every figure renders in `--paper-200`: a live score is a number, not yet a result. The credit line's last link follows the same gate ("Full box score" vs "Matchup detail"). `status` is now the only field of that file that's read; `title`/`subtitle` are optional in the schema and no longer rendered.
- Responsive: the slate runs two-up under 760px, back to one column under 520px.

**The record book (`.record-section`) is a horizontal band below the bowl games.** Four `.record-cell` columns under a heavy rule each — a rule over each figure rather than a box around it, so the columns read as one band of like facts. `2` columns at ≤1080 (a 1.75rem figure plus a club name needs the measure), `1` at ≤520. "The complete record book" link sits immediately beneath, over a hairline.

- **The page is static, so the lede and rail are only as current as the last build** (nightly — see root CLAUDE.md "Nightly automation").
- `slateIsFixtures` — when the season has not started, the rail shows the **next set of fixtures** instead of results: the header reads "The Opening Slate" and the score column renders empty rather than a wall of `0.00`
- `.two-up` — a standings `.ledger` (1.75fr) beside the champions roll (1fr). **Which ledger is season-gated** via `showSeasonStandings`: Sleeper `season_type` of `'regular'` or `'post'` renders the active season's table (`standingsYear`, the same season the lede resolves), one `<tbody>` per conference with a `.conf-row` sub-head, ranked by pct then points for; anything else — `'off'`, `'pre'`, or a failed state fetch — keeps the all-time order. Note Sleeper's values are the short forms (`off`/`pre`/`regular`/`post`). Season rows come from `results` (already fetched for the all-time view), and the "Through Week N" folio is the last *scored* regular-season week in `matchups`, not the live week. The all-time table's gold honours column is targeted as `td.bowls`, not `td.num:last-child`, so the season table's PA column isn't painted gold
- Bowl games index — the current season's **bowl games only**, dense and multi-column. `spotlight_games.type` also carries `'rivalry'`, which is filtered out at the data step (`bowlGames`): Rivalry Week is redrawn every season and carries no history of its own, so it doesn't belong in a standing index. The section's classes are `.bowl-*` (scoped to this page); there is no longer a `.named-*` anything
- Almanac facts (e.g. "No. 1 seeds are 0–3 in Dynasty Bowls") are **derived from `results`**, never hardcoded, so they stay true as seasons are added
- Breakpoints: 1080px halves the record book to two columns and stacks `.two-up`; 760px goes single column (lede, then score rail) and runs the rail's games two-up (the bracket goes vertical at 768, inside its component); 520px returns the rail and the record book to one column

### `history/index.astro`
Reframed as **the archive**: a large `.archive-plate` title, prose at a real measure with a `.archive-margin` counts column beside it, then a `.ledger` of seasons (bowl numeral, year + charity, both conference champions, champion, runner-up, final score), and playoff-format notes as two ruled columns. The Roll of Honor was removed — the seasons ledger already names every champion, so it was a second listing of the same facts.
- Season ledger wraps in `.ledger-scroll` and hides `.col-hide-mobile` columns under 768px
- The champion cell's flex box sits on an inner `<span>`, not the `<td>` — making a `<td>` a flex container drops it out of table layout and its rule stops short of the row
- **`.season-ledger td` overrides `vertical-align` to `middle`.** The shared `.ledger td` uses `baseline`, and a flex container takes its baseline from its first item — here the 24px logo, whose baseline is its bottom edge. That sits well below the text baseline of the neighbouring cells, so baseline alignment drags the champion cell's content visibly upward. Don't revert this to inherit from `.ledger` without re-checking that column

### `history/[year].astro`

**The page has two registers, switched on `isActiveSeason`.** A completed season is the archival view described below; the season in progress is a live one. The switch is `allRows.every(r => !r.finish)` — a completed season records a placement for every team, an in-progress one has `finish IS NULL` across the board. Don't switch this to `MAX(year)`: `seasons` and `results` rows exist from the moment a Sleeper league is created.

What the active season changes, and nothing else:
- **"Current Standings"** in place of "Final Standings". The table itself is unchanged apart from **dropping the Finish column** (header and cells), which would otherwise be a live header over fourteen blank cells. Row order still comes from `sortStandings`, which falls through to wins → points for when no team has a `finish`
- **No bracket.** The live playoff picture moved to the homepage lede; the whole bracket section is gated on `!isActiveSeason`. In its place, a **"Run the playoff simulator →"** button (`.sim-link`, display caps in an ink outline, ember on hover) sits at the foot of the Current Standings section, linking to `/sim`
- **The subhead** reads "In progress — through Week N" rather than "Won by X over Y", which would render as "Won by  over ". N is `lockedThrough` from `loadSeasonPicture` — the last week Sleeper has finalized, not the live NFL week
- **A "Medal Race" section** sits between the bracket and the draft board — the top five scorers at each of the eight contested positions, via `loadPositionLeaders`. It reuses the Medals wing's card and timeline shapes deliberately (`.medal-card` / `.timeline`, accent from `MEDAL_POSITION_COLOR`, Offense and Kicker & Defense bands), with a rank column where that page has a year column. Those styles are **copied into this page's scoped block** rather than shared, which is the established per-page pattern here
- The medal race reads weeks `1..lockedThrough` — finalized weeks only, so a week's live points join the race once Sleeper closes it. Its starts aggregation is gated on `isActiveSeason`

Ties at the leaderboard cutoff are real — two player-franchise pairings can finish level, and `loadPositionLeaders` breaks them on player id purely so a static rebuild of unchanged data doesn't shuffle the row.

Everything below describes the archival view and the mobile behaviour, both of which are shared by the two registers:

- Final Standings grid goes vertical (HCC below SCC, each full width)
- **The bracket is `<PlayoffBracket>`** (`src/components/`), fed by `loadSeasonPicture(yearNum, …).bracket`; it goes vertical at 768px on its own. The champion and runner-up in the subhead come from the same `bracket`. Matchups link to recaps (round 1 = week 15, semis = 16, final = 17) only where the `game_type = 1` row exists — see root CLAUDE.md's `playoff-bracket.ts` notes
- Text above bracket: "Click a matchup for more details →"

### `sim.astro` (`/sim`)
**The playoff simulator.** Static, rebuilt nightly. The finalized weeks (`lockedThrough`) are fixed; every regular-season game after them is the reader's to call, and the field re-seeds on each pick. Season = the latest `seasons` row; the page only opens when its phase is `regular` and games remain, and otherwise renders a one-line note.
- **Same rules as the real picture.** The client script imports `computePlayoffPicture` and `clinchStatus` straight from `src/lib/playoff-picture.ts` (and `logoPath` from `format.ts`) — both import-free, so the bundle stays ~7 kB with no Supabase. Data reaches it as `<script type="application/json" id="sim-data">`, **not `define:vars`**, which would force `is:inline` and break the imports (that's why `scores.astro` carries local copies of lib code)
- **A pick is a winner only.** It adds a W/L and a 1–0 head-to-head result; points for stays frozen at the real totals (the page says so). Ties aren't pickable
- **The DOM is server-rendered and updated in place**, never rebuilt from JS — that keeps Astro's scoped styles applying. Schedule rows toggle `aria-pressed`/`.is-picked` and rewrite `[data-rec]` records; the bracket's `[data-seed]` slots and the bar's `[data-strip-seed]` strip get a new logo/abbr; the two conference `.ledger` tables re-append their existing `<tr>`s in the new order and restate seed/W/L/mark
- Standings order within a conference: seed, then wins, then PF. `.below-cut` (dashed rule) marks the first unseeded row; `.out` fades eliminated clubs. Marks: `z` conference, `x` berth, `e` eliminated — conservative, see root CLAUDE.md
- **State:** the URL hash, `#10=ab-ba-a&11=...` (one char per game in `matchup_id` order, `-` open), mirrored to `localStorage` (`scdfl-sim-{year}`, try/catch). Hash wins on load. Keyed by week, so stale picks for a week that has since locked are dropped. Week jumps use buttons + `scrollIntoView`, not `#anchors`, which would clobber the hash
- **Controls (sticky `.sim-bar`, `top: 34px`):** fill open games by higher PF, coin flip, or live leaders (only when a week is under way) — fills never overwrite a reader's own picks; Reset; Copy share link. Per-week "Clear week"; clicking a club in the tables filters the schedule to its games
- **Layout:** ≥1100px, schedule (left) beside the picture (right, sticky with its own scroll). Below that, one column — schedule first — and the bar grows a **seed strip** (the field in seed order) so picks visibly reshuffle it without scrolling. ≤640px stacks the two conference tables

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
- **On-demand (SSR) route** — `export const prerender = false`, no `getStaticPaths`. The slug is resolved per request (week from the slug prefix → that week's matchups/exhibitions → match on `buildSlug`); see "Rendering Modes" in the root CLAUDE.md. The recap is fetched with `getEntry('recaps', '<year>/<slug>')`, not a full `getCollection` scan, since this now runs on every pageview
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
- **On-demand (SSR) route** — `export const prerender = false`, no `getStaticPaths`. Data is fetched per request, so independent Supabase queries are batched in one `Promise.all` and only the roster→franchise and draft→drafts→drafter chains stay sequential. Adding a serial `await` here costs every visitor, not the build.
- Page wrapper (`player-page-wrap`) constrains to screen width with `overflow-x: hidden` and tighter padding
- Hero section reduces padding/margin
- Layout grid (`player-layout-grid`) stacks to single column; sidebar moves below stats
- Bio grid collapses from 3 to 2 columns
- Stats table: all position-specific stat columns hidden via `col-hide-mobile` class; only Year, GS, and FPTS remain
- Stats table wrapper switches from `overflow-x: auto` to `hidden` (no horizontal scroll needed with reduced columns)

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
- Header nav collapses to hamburger (handled globally in `Layout.astro`)
- Quick Stats: 2×2 grid
- Dynasty Bowl loser div hidden
- Bottom nav links stack vertically
- Footer nav hidden

### `history/index.astro`
- Season Results table hides all columns except Season and Champion; adds a "See more →" column
- Playoff Format grid stacks vertically

### `history/[year].astro`
- Final Standings grid goes vertical (HCC below SCC, each full width)
- Playoff bracket `bracket-wrap` goes vertical

### `franchises/[abbr].astro`
- Sidebar moves below Main column at full width
- Season Record table hides PF and PA columns
- All content constrained to screen width (no x-axis overflow)

### `spotlight-games/index.astro`
- `explain-grid`: 2-col info cards stack to 1 column
- `bowl-card`: outer grid collapses to 1 column; `.bowl-teams-inner` switches from `flex-direction: column` to `row`; `.bowl-team-a` gets `flex-direction: row-reverse` so the layout reads badge | logo | name ↔ vs. ↔ name | logo | badge (badges outside, names inside, logos between)
- `.bowl-team-name` spans hidden on mobile to save space

### `spotlight-games/[slug].astro`
- Fetches historical matchup data via `getHistoricalMatchups(teamA, teamB)` which scans all `/data/raw/*-matchups.json` files to find instances where both teams played in the same week with matching `matchup_id`
- Historical Results table displays: Year | Week | Team A | Score A | Score B | Team B with winner highlighted in gold, loser muted
- Score boxes and column widths use `min-width` to ensure consistent vertical alignment across all matchup rows
- `.matchup-card-grid`: 3-col (A | vs | B) collapses to single column; Team B's color border swaps from right to left via `--team-b-color` CSS variable
- `.matchup-desc-grid`: "About This Matchup" + "Historical Results" stack vertically

### `games/[year]/[slug].astro`
- `.lineup-grid`: 2-col side-by-side roster view collapses to 1 column
- CSS `order` property resequences grid items so all Team A rows render first, then Team B header (`order: 50`), then all Team B rows (`order: 51`)
- `.lineup-row-b` gets `flex-direction: row` on mobile (was `row-reverse` on desktop) so element order matches Team A: pos | thumb | name | score
- Team A `border-right` removed (no adjacent column on mobile)

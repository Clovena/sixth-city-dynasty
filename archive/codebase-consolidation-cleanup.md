# Codebase Standardization Audit — Franchise Identity, Roman Numerals, Supabase Queries, and Other Duplication

## Context

This Astro site was built up across many separate Claude Code sessions as it grew to ~24 pages. Common logic — resolving a franchise's identity for a given year, converting a season to a Dynasty Bowl roman numeral, querying Supabase, and a long tail of smaller formatting helpers — was frequently written fresh on each page rather than reused, because a `src/lib/hall-of-fame.ts` already contains several of these correctly but is named in a way that (per the audit) discourages non-Hall-of-Fame pages from importing it. The user asked for a full audit (no code changes yet) so they can decide what to standardize and when.

Three parallel Explore agents audited: (1) franchise-abbr/roman-numeral functions, (2) Supabase query chaining, (3) all other repeated logic. This plan is the synthesis. Decisions already made with the user: new helpers go into **topic-based lib files** (not one grab-bag, not stuffed into `hall-of-fame.ts`), and **client-side `<script>` duplication is out of scope** for this pass (two pages use `is:inline`, which blocks ES imports entirely — untangling that is a separate, riskier effort).

---

## 1. Franchise Identity Resolution (`getEffectiveAbbr` / `getHistoricalAbbr` / etc.)

**Finding:** the `"from" <= year && ("to" === null || "to" >= year)` predicate is implemented **18 separate times across 11 files**, under 7+ different names (`franchiseForYear`, `franchiseByAbbrForYear`, `activeFranchise`, `identityFor`, `getEffectiveAbbr`, `getActiveAbbr`, `getHistoricalAbbr`, `getFranchise`, `getIdentity`, `eraFor`/`activeFor`, `franchiseAbbrForId`). A correct, general version already exists in `src/lib/hall-of-fame.ts` (`franchiseForYear`, `activeFranchise`, `franchiseByAbbrForYear`, `identityFor`) but is only imported by 3 of the 5 Hall of Fame pages — every other page reimplements it locally.

**Real behavioral divergences found (not just copy-paste noise):**
- `src/pages/index.astro:16-20` searches only *active* rows (`activeFranchises`), so its `from <= yr` check can never actually resolve a defunct/renamed identity — silently different from every other instance.
- Two files key the lookup on `franchises.id` instead of `franchises.sleeper_id`: `src/pages/spotlight-games/[slug].astro:115-120` (`getHistoricalAbbr`) and `src/pages/players/[id].astro:201-206` (`franchiseAbbrForId`), plus `src/lib/get-historical-matchups.ts`. **Confirmed via direct query** (`SELECT id, sleeper_id FROM scdfl.franchises WHERE id::text != sleeper_id` → zero rows) that `id` and `int(sleeper_id)` are identical for every franchise, so this is safe to consolidate: standardize the centralized helper on `sleeper_id` (per CLAUDE.md's documented join-key convention) and migrate the 3 `id`-keyed call sites to match. No need for a separate by-`id` variant.
- `src/pages/franchises/[abbr].astro:123` names its all-rows variable `activeFranchises` even though it holds every era — misleading, not a bug, but worth renaming during the touch.

**Plan:** create `src/lib/franchise-identity.ts` containing the canonical set (moved/adapted from `hall-of-fame.ts`, which re-exports them for its own backward compatibility if needed):
- `franchiseForYear(rows, sleeperId, year)` — identity a franchise carried in a given season
- `activeFranchise(rows, sleeperId)` — current identity
- `franchiseByAbbrForYear(rows, abbr, year)` — reverse lookup (used for `seasons.scc_champion`/`hcc_champion`, which are stored as abbr strings)
- `identityFor(rows, sleeperId, year)` — the `{abbr, activeAbbr, name}` convenience wrapper already used by 3 HOF pages
- A resolved `franchiseByRosterId(rows, id, year)` (or single dual-key function) once the `id` vs `sleeper_id` question above is settled

Then update every call site in the Category-1 table (index.astro, bets/index.astro, franchises/[abbr].astro, history/index.astro, history/[year].astro, spotlight-games/[slug].astro, games/[year]/[slug].astro, players/[id].astro, plus the 3 already-importing HOF pages to import from the new location instead) to import instead of reimplement. `history/[year].astro`'s SQL-pushed-into-query variant (`getEffectiveAbbr`/`getActiveAbbr` backed by a pre-built `Map`) is a legitimate performance optimization for a page iterating many rows — keep the map-building approach there but back the map construction with the shared predicate function rather than an inline copy.

`getFranchise` (scores.astro) and `getIdentity` (franchises/[abbr].astro) are the two client-`<script>` instances — per the scope decision above, leave these duplicated as-is for this pass.

---

## 2. Roman Numeral Conversion (`toRoman`)

**Finding:** simple, clean win. One correct implementation lives in `src/lib/hall-of-fame.ts:57-67` and is **never imported by any page** — every call site (`index.astro`, `scores.astro`, `franchises/[abbr].astro`, `history/index.astro`, `history/[year].astro`) pastes an identical algorithm locally (one variant mutates its input parameter directly rather than a local copy — harmless for primitives, but worth normalizing on the non-mutating version). All 6 instances are one-directional (int → numeral) and always called as `toRoman(year - 2020)`.

**Plan:** move `toRoman` (and its `ROMAN_VALUES`/`ROMAN_SYMBOLS` tables) into the new `src/lib/format.ts` (see §4), delete the 5 local copies, import in each of those 5 files.

---

## 3. Supabase Query Chaining

**Finding:** good news — the core convention (`.schema('scdfl')` → `.from()` → `.select()`/write-op → filters → `.order()` → `.limit()` → `.single()`) is followed with **zero ordering violations** across all ~90 call sites in `src/pages`, `src/lib`, and `scripts/lib`. No query is missing `.schema('scdfl')`. What's inconsistent is formatting and a few structural patterns:

- **Three line-break styles** coexist: one-method-per-line (dominant, ~70 sites), `.schema().from()` combined on one line with the rest stacked (`players/[id].astro`, `games/[year]/[slug].astro` — 23 sites), and fully inline single-line (`hall-of-fame/inductees.astro`, parts of `franchises/[abbr].astro` and `history/[year].astro` — 4 sites).
- **Quote style splits exactly on the `src/` vs `scripts/` boundary**: single quotes in `src/`, double quotes in `scripts/`. Internally consistent per directory, but not one project-wide style.
- **Three different ways of obtaining a client**: the shared `supabase` singleton (default, most files); a dynamic `await import('../lib/supabase')` inside `getStaticPaths` (used in 3 files to route around a scoping issue); and a fully separate `createClient(...)` in `spotlight-games/[slug].astro` that duplicates env-var wiring and — unlike the other two paths — doesn't get the `?? process.env` SSR fallback (harmless today since that route is fully prerendered, but inconsistent).
- **Missing `.limit()` on 7 `matchups` queries** (index.astro, franchises/[abbr].astro, franchises/index.astro, history/index.astro, history/[year].astro, hall-of-fame/inductees.astro, get-historical-matchups.ts) — all variants of the same "week-17 championship matchup" or "all historical matchups between two teams" lookup. Safe today under Supabase's 1000-row default cap (matchups is ~580 rows) but will silently truncate once the table grows, and sibling queries in the same files already correctly add `.limit(500)`/`.limit(1000)`.
- **Two different large-table strategies for `transactions`** (~5,700 rows): `dev/commish/trans-audit.astro` and `dev/commish/trade-timing.astro` manually paginate with `.range()` in a loop (arguably more correct — doesn't silently truncate), versus the single-query-plus-`.limit()` pattern used for `matchups` elsewhere.

**Plan (formatting/structure — no query logic changes):**
1. Adopt one line-break convention project-wide. Recommend the dominant one-method-per-line style since it's already ~78% of call sites; reformat `players/[id].astro`, `games/[year]/[slug].astro`, `hall-of-fame/inductees.astro`, and the inline spots in `franchises/[abbr].astro`/`history/[year].astro` to match.
2. Standardize on single quotes in `src/` (already 100%) — leave `scripts/` on double quotes as its own consistent convention, or unify both if the user wants one project-wide rule (flag as a quick decision at implementation time, low risk either way).
3. Consolidate client access to the shared `supabase` singleton everywhere, including `spotlight-games/[slug].astro`; drop its standalone `createClient` call so it inherits the same SSR env-var fallback as every other route.
4. Add `.limit(1000)` (matching the existing `hall-of-fame.ts` precedent and its documented "~580 rows across all seasons, one padded read covers the table" rationale) to the 7 unguarded `matchups` reads. Since 6 of these 7 are the same "week-17/game_type=1 championship matchup" query repeated across files, consider also pulling this into a small shared helper (`loadChampionshipMatchup(year)` in `src/lib/game-utils.ts`, §4) rather than just patching each call site's `.limit()` independently.
5. Decide once, project-wide, between `.limit()` and `.range()`-pagination as the canonical "large read" strategy for tables like `transactions`; document the choice so future pages don't invent a third approach.

---

## 4. Other Duplicated Logic (from the third audit pass)

The audit surfaced a long tail of smaller repeated helpers. Grouped by where they'd land and rough priority:

### `src/lib/format.ts` (new) — pure formatting, no data dependency
- **`toRoman(n)`** — see §2.
- **`ordinal(n)`** — byte-identical in `hall-of-fame/superlatives.astro:152-157` and `hall-of-fame/index.astro:133-138`. Move, import in both.
- **`pad2(n)`** (`String(n).padStart(2, '0')`) — used standalone in ~10 files beyond slug-building (week padding, draft-pick-label padding). `franchises/[abbr].astro:1100` already has a local one-off named exactly this. Centralize and reuse for both the week-padding and the separate draft-pick-label pattern (`history/[year].astro:383` and `players/[id].astro:136` duplicate an identical `round.pick` formatter — fold that into a `draftPickLabel(round, pickNo)` helper alongside `pad2`).
- **`formatPoints(n)`** — unify `hall-of-fame/champions.astro`'s `fmt()` (null-safe, `.toFixed(2)`) and `hall-of-fame/medals.astro`'s `fmtPoints()` (`.toLocaleString` with fixed decimals, no null handling) into one null-safe formatter; then replace the ~30 bare `.toFixed(2)` call sites that currently bypass both.
- **`playerName(first, last, fallback)`** — 6 variants across `hall-of-fame.ts`, `hall-of-fame/index.astro`, `hall-of-fame/superlatives.astro`, `hall-of-fame/medals.astro`, `players/[id].astro`, `games/[year]/[slug].astro` diverge on null-handling and technique (template+trim vs. filter+join). Pick one behavior (recommend: filter+join, since it cleanly drops a missing first *or* last name instead of leaving a stray space) and centralize.
- **`espnHeadshotUrl(espnId)`** — 4 near-identical implementations (`players/[id].astro`, `hall-of-fame/medals.astro`, `hall-of-fame/superlatives.astro`, `games/[year]/[slug].astro`) diverge on fallback (`'/images/player-placeholder.png'` vs `null`). Centralize with the placeholder-path fallback baked in, since every caller re-adds its own `onerror` handling regardless.

### `src/lib/franchise-identity.ts` (new, extends §1)
- **`logoPath(abbr)`** (`` `/images/logos/${abbr}.png` ``) — ~45 call sites across 17 files, currently always inlined. Centralize the path template; leave each call site's `onerror` fallback markup as-is (that's presentation, not logic).
- **`primaryColor(franchise, fallback?)`** — `colors[0]`/`colors?.[0]` extraction currently has 3 different fallback conventions (`'var(--color-border)'`, `'var(--border-default)'`, none at all) across `franchises/[abbr].astro`, `players/[id].astro`, `bets/index.astro`, `remark-team-headers.ts`, `index.astro`, `spotlight-games/index.astro`, `spotlight-games/[slug].astro`. Centralize with one agreed default fallback CSS var.

### `src/lib/game-utils.ts` (new)
- **`buildSlug(abbrA, abbrB, week)` / `gameHref(...)`** — already correctly implemented in `hall-of-fame.ts` and used by exactly one page (`records.astro`). Move to `game-utils.ts` and get the other 5 independent reimplementations (`scores.astro`, `franchises/[abbr].astro` — byte-identical `makeSlug` copy — `history/[year].astro` — 2 separate local variants — `games/[year]/[slug].astro`, `spotlight-games/[slug].astro`) to import it instead. This is the highest-value single consolidation in the "other" category: one canonical slug format enforced everywhere instead of 6 hand-maintained copies.
- **`GAME_TYPE_LABEL`** — already centralized but only consumed by `records.astro`; adopt it in `scores.astro`, `franchises/[abbr].astro`, `history/[year].astro`, `spotlight-games/[slug].astro`, `games/[year]/[slug].astro` in place of their scattered `'Regular Season'`/`'Playoffs'`/`'Consolation'` literals.
- **`isPlayablePostseasonGame(gameType, scoreA, scoreB)`** — the "drop 0–0 postseason placeholder games, always keep regular season" rule is real business logic, independently reimplemented **5 times** with subtly different shapes (`continue`-based filtering vs. inverted-boolean vs. `.filter().map()`) in `scores.astro` (twice), `franchises/[abbr].astro`, `hall-of-fame.ts` (twice, itself inconsistent — `toPostseasonSides` vs. `loadRecords`), and `get-historical-matchups.ts`. This is the one item in this section that's a behavioral rule rather than formatting, so it's worth prioritizing alongside the slug consolidation — a single exported predicate removes 5 independent chances for the rule to drift.

### Flagged but not recommended for action now
- **Client-side `teamRow`/`exhibTeamRow` HTML-string builders** (`scores.astro`, `franchises/[abbr].astro`) and the **exhibition multi-logo row markup** (`scores.astro` template string vs. `history/[year].astro` JSX) — genuinely duplicated, but per the client-script scope decision above, `franchises/[abbr].astro`'s copy lives inside an `is:inline` script and can't import a shared module without first resolving that constraint. Leave documented, revisit if/when the `is:inline` scripts are tackled separately.

---

## Verification

Since this plan produces no code changes, verification is about confirming the plan's factual claims before implementation begins, not testing a build:

1. **Franchise `id` vs `sleeper_id`** — already confirmed identical for all rows (see §1); no further check needed before migrating the 3 `id`-keyed call sites.
2. **Spot-check the "byte-identical" duplicate claims** for a couple of the larger items (`toRoman`, `buildSlug`/`makeSlug`, `ordinal`) by diffing the call sites listed above before deleting any of them, since the audit was thorough but not infallible.
3. Once any consolidation is implemented, run `npm run build` to confirm the static build still succeeds (this will catch any missed import or signature mismatch across the ~15+ touched pages) and spot-check a handful of pages in `npm run preview` (a franchise page, `/scores`, a game recap, a Hall of Fame wing) to confirm no visual/behavioral regression from the consolidation.

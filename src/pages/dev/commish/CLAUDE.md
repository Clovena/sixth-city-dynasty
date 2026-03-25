# CLAUDE.md — Commissioner Tools (`src/pages/dev/commish/`)

---

## Directory Purpose

Private audit and utility pages for league commissioner use only. Kept separate from general dev pages that may eventually become public-facing. All pages in this directory are commissioner-only tooling and should not be surfaced in public navigation.

**URL pattern:** `/dev/commish/[page-name]`

---

## Available Tools

| Tool | File | URL | Purpose |
|------|------|-----|---------|
| **Roster Audit** | `roster-audit.astro` | `/dev/commish/roster-audit` | Week-by-week starting lineup changes per franchise; see when starters changed and by how many |
| **Transactions Audit** | `trans-audit.astro` | `/dev/commish/trans-audit` | Transaction activity per franchise grouped by type (waiver/free agent/trade) and completion status; pivot table by week |

---

## Roster Audit (`roster-audit.astro`)

### Purpose

Forensic inspection of starting lineup changes week-by-week per franchise. Answers questions like:
- "When did this team last change their starters?"
- "How often does franchise X make weekly lineup adjustments?"
- "What was the exact starting roster for week X?"

### Data Flow

**Build-time (Astro frontmatter):**
- Loads all `/src/data/raw/*-matchups.json` files via `import.meta.glob`
- For each entry, extracts: `roster_id` and `starters` array (player IDs only, 15 starters per franchise per week)
- Skips bye-week entries (null `matchup_id`) — these have no meaningful starters
- Builds compact structure: `{ [year]: { [week]: { [rosterId]: string[] } } }`
- Loads franchise lookup data from `franchises.json` (id → name/abbr)

**Client-side:**
- Data injected via `<script define:vars={{ startersData, franchiseMap }}>`
- Franchise + Year selectors trigger `renderResults()`
- Renders week-by-week table: each row = 1 week, 15 columns = 15 starter slots
- Diff logic compares each week's starters against previous week; highlights changes

### Table Display

| Element | Details |
|---------|---------|
| **Week column** | Formatted as "W01", "W02", etc. |
| **Starter slots (15 columns)** | Shows player ID truncated to 4 chars + "…" (e.g., "6797…"). Hover title shows full ID. |
| **Cell colors** | Green = unchanged from prior week; Amber = changed; Week 1 shows "unchanged" (baseline) |
| **Changes column** | Count of roster changes vs. prior week; "—" for Week 1 |

### Key Implementation Details

1. **JSON key serialization:** When data is passed via `define:vars`, all object keys become strings in the serialized JSON. Numeric roster IDs like `1` become string keys `"1"`. Lookups must use `String(rosterId)` to match. See [roster-audit.astro:241](src/pages/dev/commish/roster-audit.astro#L241).

2. **Player ID limitation:** Raw Sleeper `starters` arrays contain only player IDs (strings like `"6797"`), not player names or positions. This is intentional — the audit page focuses on roster composition, not player metadata. Commissioner can cross-reference IDs in Sleeper if needed.

3. **Bye week handling:** Entries with null `matchup_id` are skipped during build-time aggregation. These represent byes (no actual matchup) and have no meaningful starters to audit.

4. **Client-side script:** Uses vanilla JS (no framework). All state lives in the select elements; `renderResults()` is the single render function called on franchise/year change. No re-querying — all data is embedded at build time.

### Adding New Commissioner Pages

1. Create file at `src/pages/dev/commish/[page-name].astro`
2. Follow the pattern: load data at build time → inject via `define:vars` → render client-side
3. Use `franchises.json` and roster IDs for franchise lookups (see roster-audit for example)
4. Update this CLAUDE.md with details if the new page introduces new patterns or data structures

### Debugging Notes

- Browser console will log:
  - Data structure keys loaded: `startersDataKeys`, `franchiseMapKeys`
  - Event changes: franchise/year selection
  - Lookup results: whether franchise and year data were found
- Build-time: validates that franchise IDs match between Sleeper data and franchises.json (mismatches will result in "Franchise not found" at runtime)

---

## Transactions Audit (`trans-audit.astro`)

### Purpose

High-level overview of transaction activity per franchise — how many roster moves (adds/drops/trades) they made per week and season, broken down by transaction type and completion status. Answers questions like:
- "How active was this franchise in the waiver market?"
- "In what weeks did this team make the most roster moves?"
- "How many waiver claims failed vs. succeeded?"

### Data Flow

**Build-time (Astro frontmatter):**
- Loads all `/src/data/raw/*-transactions.json` files via `import.meta.glob`
- For each transaction, extracts: `week`, `type`, `status`, `roster_ids` (compact record)
- Builds: `txData: { [year]: TxRecord[] }` — a flat array of compact records per year
- A franchise "owns" a transaction if its `roster_id` appears in the transaction's `roster_ids` array
- Loads franchise lookup data from `franchises.json` (id → name/abbr)

**Client-side:**
- Data injected via `<script define:vars={{ txData, franchiseMap }}>`
- Franchise + Year selectors + Type checkboxes (waiver, free_agent, trade, commissioner)
- Franchise/Year selection renders the pivot table; type checkboxes toggle row visibility
- Client-side filtering: only shows transactions where franchise's `roster_id` is in `roster_ids`

### Table Display

**Layout:**
- **Rows grouped by week** — each week is a row grouping with type sub-rows underneath
- **Columns:** Week | Type | Completed | Failed | Total
- Weeks with zero total activity across all types are omitted
- Types with zero activity in a week still shown (all-zero row) so patterns are visible
- **Grand-total row** at the bottom sums across all weeks

**Styling:**
- Zero cells → muted text, no background
- Failed > 0 → amber-tinted background (calls attention to failed claims)
- Total > 3 → light gold background (highlights high-activity weeks)

### Transaction Types

Four types: `waiver`, `free_agent`, `trade`, `commissioner`.

| Type | Status | Notes |
|------|--------|-------|
| `waiver` | complete/failed | FAAB waiver claim; can fail if overbid or timing. Failed claims still counted. |
| `free_agent` | complete | Immediate add/drop, no bidding. `failed` status not seen in data. |
| `trade` | complete/failed | Multi-roster player swap; `roster_ids` includes both sides. Rare to see `failed` trades. |
| `commissioner` | complete | Rare (~3 in 2021, 0 in 2025). Commissioner-forced move; `consenter_ids: null`. |

### Key Implementation Details

1. **Flat array storage:** Unlike roster-audit's nested-by-roster-id structure, trans-audit stores one flat array of `TxRecord` per year. Keeps the JSON compact and lets the client filter dynamically by franchise. See [trans-audit.astro:28-35](src/pages/dev/commish/trans-audit.astro#L28-L35).

2. **Status split columns:** The Complete/Failed/Total columns split by `tx.status` field. This lets commissioners quickly spot patterns of failed waivers or other issues. See [trans-audit.astro lines 245-255](src/pages/dev/commish/trans-audit.astro#L245-L255).

3. **Franchise ownership:** A transaction is attributed to a franchise if `roster_ids.includes(rosterId)`. For trades, both teams appear in `roster_ids`, so a trade counts toward both franchises' activity. See [trans-audit.astro:216](src/pages/dev/commish/trans-audit.astro#L216).

4. **Client-side script:** Vanilla JS, single `renderResults()` function. All state (franchise, year, checked types) lives in the DOM selectors/checkboxes. Type checkboxes re-trigger the render to show/hide rows. See [trans-audit.astro:280+](src/pages/dev/commish/trans-audit.astro#L280).

### Debugging Notes

- Browser console will log: franchise selected, year selected, type checkbox changes (implicit via render calls)
- Build-time: all franchises should appear in the dropdown; if a franchise is missing, check `franchises.json` has all roster IDs
- Empty-state: if a selected franchise has zero transactions in a year, page shows "No transaction activity found"
- Week 17 may have duplicate/multi-week transactions (playoff trades); they're still counted once per transaction entry

---

## Related Files

- Data sources:
  - `src/data/raw/*-matchups.json` (Sleeper API output with starters arrays — used by roster-audit)
  - `src/data/raw/*-transactions.json` (Sleeper API output with transaction details — used by trans-audit)
- Franchise lookup: `src/data/franchises.json` (roster_id → name/abbr/colors)
- Parent page structure pattern: `src/pages/dev/trans.astro` (transaction explorer — similar build-time data loading + client-side UI)

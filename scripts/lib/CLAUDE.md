# CLAUDE.md — Sleeper API Integration

Data fetching and transformation pipeline for the SCDFL site. Converts raw Sleeper Fantasy Football API responses into the JSON shapes consumed by the static site.

---

## Usage

```bash
npm run fetch              # Fetch current season only (uses config.json `current: true`)
npm run fetch -- --all     # Fetch all seasons defined in config.json
npm run fetch -- --players # Fetch Sleeper player database → player-id-map.json (once yearly)
```

**Regular fetch commands** (`npm run fetch` / `--all`):
- Fetch roster, matchup, transaction, and draft pick data from Sleeper's public API (no authentication required)
- Write raw responses to `src/data/raw/` for inspection
- Transform and merge processed stats into `src/data/results.json`
- Preserve manually-maintained `playoff` and `finish` fields in results.json
- Fetch draft picks for all draft IDs in `draft-config.json`

**Transactional data** (fetched automatically with regular fetches):
- Waiver claims, free agent pickups, trades — one file per season, per week
- Stored in `src/data/raw/{year}-transactions.json` as a week-keyed object

**Draft pick data** (fetched automatically if entries exist in `draft-config.json`):
- All draft picks from specified drafts; includes player, roster, and position data
- Stored in `src/data/raw/{year}-{type}-draft.json` as an array of pick objects
- `draft_slot` maps to `draft-slots.json` for original franchise assignments
- `roster_id` in pick data indicates which team actually made the pick (after trades)

**Player fetch** (`npm run fetch -- --players`):
- Fetches Sleeper's `/players/nfl` endpoint (~5MB, contains all ~20k+ players)
- Extracts player ID → ESPN ID mapping (used for headshot URLs), plus full name and position
- Writes to `src/data/player-id-map.json` — checked into repo, regenerated once per year (after NFL draft) to pick up rookies

---

## Files

| File | Purpose |
|------|---------|
| `fetch-sleeper.ts` | Orchestrator — handles season selection, API calls, data merging, player ID mapping, transaction/draft fetching |
| `sleeper-api.ts` | Typed API wrappers — `getRosters()`, `getMatchups()`, `getTransactions()`, `getDraftPicks()`, etc. |
| `transform.ts` | Statistics transformation — rosters → per-franchise season stats |

---

## Data Flow

```
Sleeper API (public, no auth)
         ↓
    getRosters()      [gets one endpoint per season]
         ↓
    saveRaw()         [writes to src/data/raw/{year}-rosters.json]
         ↓
buildSeasonStats()    [extract wins/losses/PF/PA per franchise]
         ↓
 loadResults()        [load existing src/data/results.json]
         ↓
   mergeStats()       [upsert season, preserve playoff/finish fields]
         ↓
  saveResults()       [write back to src/data/results.json]
```

---

## Key Mapping: Sleeper `roster_id` → Franchise

**Rule:** `franchises.json` `id` (number) === Sleeper `roster_id` (number)

In `transform.ts`:
```ts
const rosterMap = new Map<number, string>();
for (const f of franchises) {
  map.set(f.id, f.abbr);  // roster_id → abbr
}
```

Every roster returned by `getRosters()` has a `roster_id` (1–14). This directly maps to the corresponding franchise's `id` field. No user_id matching needed — it's positional.

---

## Fields Written by fetch-sleeper.ts

Into `results.json`, **per season, per franchise:**

| Field | Source | Notes |
|-------|--------|-------|
| `year` | season config | e.g., 2024 |
| `wins` | `roster.settings.wins` | Computed by Sleeper |
| `losses` | `roster.settings.losses` | Computed by Sleeper |
| `points_for` | `roster.settings.fpts` + `fpts_decimal` | Combined, coalesced to 0 if null |
| `points_against` | `roster.settings.fpts_against` + `fpts_against_decimal` | Combined, coalesced to 0 if null |

### Fields NOT written by the script

| Field | Management | Notes |
|-------|------------|-------|
| `playoff` | Manual in results.json | Playoff seed, consolation bracket, etc. |
| `finish` | Manual in results.json | Final placement, dynasty bowl outcome, etc. |

If these fields already exist in `results.json`, they are **never overwritten** — the script always preserves them.

---

## Points Calculation

Sleeper splits points into integer and decimal components:
- `fpts`: integer part (e.g., 174)
- `fpts_decimal`: decimal part (e.g., 52 → 0.52)

Combined in `sleeperPoints()`:
```ts
export function sleeperPoints(integer: number, decimal: number): number {
  return parseFloat(`${integer}.${String(decimal).padStart(2, '0')}`);
}
// sleeperPoints(174, 52) → 174.52
```

Both are coalesced with `|| 0` to handle nulls (e.g., season not yet complete).

---

## Raw JSON Structure

### `{year}-rosters.json`

Array of Sleeper rosters per league. Kept as-is from the API for inspection and potential future use (e.g., player lineup data in v2).

```json
[
  {
    "roster_id": 1,
    "owner_id": "...",
    "league_id": "...",
    "settings": {
      "wins": 8,
      "losses": 2,
      "fpts": 1245,
      "fpts_decimal": 67,
      "fpts_against": 1198,
      "fpts_against_decimal": 43
    },
    "players": [...],
    "starters": [...],
    ...
  },
  ...
]
```

### `{year}-transactions.json`

Week-keyed object containing arrays of transactions per week (week 1–17). Each transaction represents a waiver claim, free agent pickup, or trade.

```json
{
  "1": [
    {
      "status": "complete",
      "type": "waiver",
      "metadata": { "notes": "Your waiver claim was processed successfully!" },
      "created": 1730235793770,
      "settings": { "seq": 1, "waiver_bid": 0 },
      "leg": 1,
      "draft_picks": [],
      "creator": "722626997460733952",
      "transaction_id": "1157096420542025728",
      "adds": { "10935": 2 },
      "drops": null,
      "consenter_ids": [2],
      "roster_ids": [2],
      "status_updated": 1730271991477,
      "waiver_budget": []
    },
    {
      "status": "complete",
      "type": "trade",
      "metadata": null,
      "created": 1730225356038,
      "settings": { "is_counter": 1 },
      "leg": 1,
      "draft_picks": [
        {
          "round": 3,
          "season": "2026",
          "league_id": null,
          "roster_id": 8,
          "owner_id": 1,
          "previous_owner_id": 8
        }
      ],
      "creator": "724464389268324352",
      "transaction_id": "1157052641520787456",
      "adds": { "19": 8 },
      "drops": { "19": 1 },
      "consenter_ids": [1, 8],
      "roster_ids": [1, 8],
      "status_updated": 1730225826495,
      "waiver_budget": []
    }
  ],
  "2": [...],
  ...
}
```

**Schema (TypeScript):**
```ts
interface SleeperTransaction {
  status: string;                                     // 'complete', 'pending', 'failed'
  type: string;                                       // 'waiver', 'trade', 'free_agent'
  metadata: { notes?: string } | null;               // transaction notes (waivers only)
  created: number;                                    // unix timestamp (ms)
  settings: {
    seq?: number;                                     // waiver sequence (waivers only)
    waiver_bid?: number;                              // waiver bid amount (waivers only)
    is_counter?: number;                              // trade counter flag (trades only)
  } | null;
  leg: number;                                        // week number (1–17)
  draft_picks: Array<{
    round: number;
    season: string;
    league_id: string | null;
    roster_id: number;
    owner_id: number;
    previous_owner_id: number;
  }>;
  creator: string;                                    // user_id who initiated
  transaction_id: string;                             // unique transaction ID
  adds: Record<string, number> | null;               // player_id → roster_id
  drops: Record<string, number> | null;              // player_id → roster_id (null if no drops)
  consenter_ids: number[];                            // roster_ids who consented (trades)
  roster_ids: number[];                               // affected roster_ids
  status_updated: number;                             // unix timestamp (ms) of last status update
  waiver_budget: unknown[];                           // always empty in observed data
}
```

---

## Config Structure (`config.json`)

```json
{
  "platform": "sleeper",
  "current_season": 2026,
  "seasons": [
    {
      "year": 2021,
      "league_id": "721099701297950720",
      "current": false
    },
    ...
    {
      "year": 2026,
      "league_id": "1312945374800920576",
      "current": true
    }
  ]
}
```

- `seasons`: Array of all league seasons with their Sleeper league IDs
- `current: true`: One season only — marks the active league for `npm run fetch`
- `league_id`: Required to fetch; if missing, season is skipped

---

## Player ID Map (`player-id-map.json`)

Generated by `npm run fetch -- --players`. Maps Sleeper player IDs to ESPN metadata for headshot display.

```json
{
  "6872": {
    "espn_id": "4035671",
    "full_name": "Justin Jefferson",
    "position": "WR"
  },
  ...
}
```

**Schema:**
- `espn_id` (optional): ESPN player ID, used to construct CDN URL. Absent for players not yet mapped by ESPN (practice squad, international, very recent signings)
- `full_name`: Sleeper's player name string
- `position`: NFL position (WR, QB, RB, TE, K, DEF, etc.)

**Storage & Refresh:**
- Checked into git — included in static builds
- Refresh once per year (typically post-NFL draft, ~April) to capture rookie class
- ~200–300 KB; includes all players regardless of ESPN linkage (ensures names display even if headshots unavailable)

**Usage on pages:**
Pages import `player-id-map.json` and use the `espn_id` to construct headshot URLs:
```ts
const espnHeadshotUrl = (playerId: string) => {
  const espnId = playerIdMap[playerId]?.espn_id;
  return espnId
    ? `https://a.espncdn.com/i/headshots/nfl/players/full/${espnId}.png`
    : null;
};
```

The ESPN CDN is external; images include `onerror` fallback to gracefully degrade if headshots are unavailable.

---

## Draft Pick Data (`{year}-{type}-draft.json`)

Array of all picks from a draft. Each pick includes player, roster assignment, and metadata.

**Schema (TypeScript):**
```ts
interface SleeperDraftPickResult {
  player_id: string;                        // Sleeper player ID
  picked_by: string;                        // user_id of manager who made the pick
  roster_id: string;                        // roster_id of team that made the pick (after trades)
  round: number;                            // draft round (1-indexed)
  draft_slot: number;                       // column on draftboard (1–14); maps to draft-slots.json
  pick_no: number;                          // overall pick number (1-indexed)
  metadata: {
    first_name: string;
    last_name: string;
    position: string;                       // e.g., 'QB', 'RB', 'WR', 'IDP'
    team: string;                           // NFL team (e.g., 'CHI', 'SF')
    player_id: string;                      // duplicate of player_id field
    sport: string;                          // 'nfl'
    status?: string;                        // e.g., 'Active', 'Injured Reserve'
    injury_status?: string;                 // injury designation
    news_updated?: string;                  // unix timestamp (ms)
    number?: string;                        // jersey number
    [key: string]: unknown;
  };
  is_keeper: boolean | null;                // if pick was kept from previous season
  draft_id: string;                         // draft ID (same for all picks in file)
}
```

**Key fields for reconstruction:**
- `draft_slot` + `draft-slots.json` → original franchise that held the pick
- `roster_id` → which team actually made the pick (after potential trades)
- `round`, `pick_no` → pick sequencing

---

## Capabilities

### Current

- ✅ Fetch rosters endpoint (win/loss/points stats per season)
- ✅ Fetch transactions endpoint (waivers, free agents, trades per week per season)
- ✅ Fetch draft picks endpoint (all picks with player/roster metadata)
- ✅ Player ID → ESPN ID mapping (`player-id-map.json`)
- ✅ Player headshot integration (ESPN CDN, with fallback for unmapped players)
- ❌ No full player-level lineups or scoring breakdowns yet
- ❌ Manual maintenance of `playoff` and `finish` fields in results.json

### Future Roadmap

- Fetch matchups endpoint for each week/season
- Display full lineups + scoring breakdowns on game recap pages
- Derive player-level scoring from Sleeper API
- Transaction history display on franchise pages
- Draft board visualization (original vs. final roster assignment)

---

## Debugging

To inspect raw API responses:
1. Run `npm run fetch` or `npm run fetch -- --all`
2. Check `src/data/raw/{year}-rosters.json`
3. Look for `roster_id`, `settings.wins`, `settings.fpts`, etc.

Common issues:
- **Missing `franchise found for roster_id X`**: Check `franchises.json` — ensure all roster_ids 1–14 have corresponding `id` fields
- **Null `points_against`**: Handled by `|| 0` coalescing in `sleeperPoints()`; indicates season not yet complete
- **League ID mismatch**: Verify `config.json` `league_id` matches the actual Sleeper league

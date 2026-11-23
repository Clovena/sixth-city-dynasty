# SCDFL Superlatives Race: Methodology Handoff

**Purpose:** Build a page on sixthcitydfl.com that tracks the **current top five** for each of the 14 Superlative Awards during the 2026 season.
**This document:** Defines how to pick a top five for each award from data in Supabase. The Claude Code session turns it into SQL and Astro pages.
**Prepared:** Nov 15, 2026. At the time of writing, Weeks 1–9 are complete and Week 10 is in progress.
**Supabase project:** `biukjccnbuhoxrhmwyhu`. Always query the `scdfl` schema, never `public`. Computed and experimental tables go in `sandbox`.

The page shows **leaders, not winners.** The league still votes after the regular season. When the season ends, the final top five per award also becomes the ballot nominee list. That ballot list can later feed the Discord bot's ballot feature and the `accolades` table.

---

## 0. Award reference

| # | `award_code` | Display name | Entity | Official description (`accolades_rows.csv`) |
|---|---|---|---|---|
| 1 | `mvp` | Most Valuable Player | player | Veteran player who most meaningfully contributed to his fantasy team. |
| 2 | `breakout` | Breakout Player of the Year | player | Non-rookie player who most outperformed expectations relative to prior all-time career performance. |
| 3 | `waiver` | Waiver Player of the Year | player | Best-performing player who was acquired from waivers immediately before or during the 2026 season. |
| 4 | `comeback` | Comeback Player of the Year | player | Veteran player who, after a disappointing 2025, most strongly rebounded in 2026. |
| 5 | `geriatric` | Old Man of the Year | player | Veteran player who most outperformed expectations relative to his age. |
| 6 | `roty` | Rookie of the Year | player | Rookie player who most meaningfully contributed to his fantasy team. |
| 7 | `vroty` | Value Rookie of the Year | player | Rookie player who most outperformed expectations relative to his draft pedigree. |
| 8 | `jamielee` | Biggest Bust of the Year | player | Veteran player who most underperformed expectations. |
| 9 | `sweeney` | Biggest Rookie Bust of the Year | player | Rookie player who most underperformed expectations. |
| 10 | `injury` | Worst Injury of the Year | player | Player who suffered an injury which most adversely affected his fantasy team. |
| 11 | `moty` | Manager of the Year | franchise | Manager who had the most outstanding 2026 season. |
| 12 | `mif` | Most Improved Franchise | franchise | Franchise who showed the greatest improvement in their performance compared to previous seasons. |
| 13 | `goodtrade` | Most Impactful Trade | transaction | Trade which most meaningfully impacted the teams involved as well as the league as a whole. |
| 14 | `badtrade` | Most Lopsided Trade | transaction | Trade which most positively impacted one team while most negatively impacting the other. |

`scdfl.accolades` keys winners by `player_id` (player awards), `sleeper_id` (franchise awards) and `transaction_id` (trade awards). The page's output uses the same keys (see §5).

---

## 1. Decision log (settled in the planning chat)

| Decision | Choice | Why |
|---|---|---|
| Source of preseason expectations (ADP) | **Sleeper `adp_idp`** from `sandbox.player_projections_2026` (uploaded in late August, so it is a preseason snapshot) | Sleeper's superflex + IDP redraft ADP matches the SCDFL format and includes defenders. The fantasyteamanalyzer.com file was rejected: it is non-PPR, 12-team, 1QB, has no IDP, and lists only 214 players. |
| Expectation for Biggest Rookie Bust | **Sleeper ADP positional rank**, the same method as veteran Bust | Follows the original spec. The card still shows the SCDFL rookie draft slot as context. |
| 2026 production | **Starts only** (`v_player_starts`) | Canonical SCDFL rule: only points a player scored while in a fantasy starting lineup count. |
| Baselines for Breakout and Comeback | **All NFL regular-season games** through 2025 | A starts-only baseline would be thin or empty for players nobody started. Last year's cards counted all NFL games (e.g., Pickens: "Prior to 2025: 48 games"). |
| Tough Break (no injury data exists) | **Automatic proxy plus a manual override table** | The proxy reproduces last year's formula (pre-injury PPG × games missed). The override table fixes the cases the proxy gets wrong. |
| Trade valuation | **The "Welcome to the Farm" ledger, adapted:** tenure crediting (points count only for the receiving roster), plus projected rest-of-season points; picks resolve to the player drafted | Revised Nov 15 after the Weeks 1–9 gut check. Follow-the-asset credited flipped players to trades they'd already left, and short realized windows buried in-season trades. See §4.13. |

Every other knob listed in §6 has a default value. Each default is reasonable but untested, so tune them with the backtest in §7.

---

## 2. Data ground rules and gotchas

These are the traps found while writing this document. Each one breaks a naive query.

1. **Future-week placeholder rows in `v_player_starts`.** For 2026, weeks 11–17 already contain 210 starter rows each, all scoring 0. The week in progress also has partial scores (Week 10 currently has 103 zero-point rows). **Always filter `week <= as_of_week`.** Never use `max(week)` to decide which weeks are complete.
2. **`as_of_week`** is the last fully completed regular-season week, capped at 14. During the season, set it to Sleeper `GET /v1/state/nfl` → `week − 1`. The site rebuilds every night through the Supabase cron, so this value updates on its own. Store it in the output (§5) so the page can display "through Week N".
3. **Regular season only.** Use `week <= 14`. For franchise records, use `matchups.game_type = 0`. Weeks 15–17 are playoffs or placeholders.
4. **Don't use `v_player_season_stats` or `v_medals` for counting starts.** Both inner-join `nfl_stats`, which silently drops started weeks that have no stat row (inactive starters, the week in progress). `v_player_season_stats` also has no week or game-type filter, so it includes playoff weeks. Build from `v_player_starts` directly. Join `nfl_stats` (with `season_type = 'REG'`) only to get stat lines for the cards and to check whether a player actually played.
5. **Definitions used throughout:**
   - `starts`: rows in `v_player_starts` with `week <= as_of_week`.
   - `games`: starts where the player played, meaning he has an `nfl_stats` REG row that week **or** his start scored nonzero points. The fallback is needed because some rookies have no `gsis_id` in `player_ids`. Through Week 9, 5 rookies (35 starts, e.g., David Bailey) had none, and 4 other rookie starts scored points with no stat row. Without the fallback, those rookies show 0 games.
   - `ppg`: `fpts / games`. Starting an inactive player is the manager's mistake, so it should not lower the player's PPG. This matches last year's cards (e.g., Burrow: "4 games, 60.46 fpts").
   - `start_rate`: `starts / available_weeks`, where `available_weeks` is `as_of_week` minus the player's bye if the bye has already passed. If bye detection isn't built yet, use `starts / as_of_week`; the thresholds below allow for that.
6. **IDP points are already real.** `v_player_starts.points` holds Sleeper's actual league scoring, IDP included. Recompute IDP scoring from raw `idp_*` fields only when scoring from `nfl_stats` or projections; see the data-and-modeling notes for the coefficients.
7. **Baseline data: `sandbox.player_windows_thru_2025`.** It holds one row per player per week for 2021–2025, weeks 1–17. The table has 9,075 zero-point rows, some of which are weeks the player didn't play. **Don't count rows as games.** A baseline game is a week where the player has an `nfl_stats` REG row. `points_source` is `sleeper` (real scoring) or `calc` (reconstructed).
8. **`years_exp` rollover.** `players.years_exp` is refreshed from Sleeper every night and gets incremented when the new league year starts (around February). Compute experience relative to the season being scored: `season_exp = years_exp − (current_sleeper_season − season)`. Then rookies are `season_exp = 0`. This also makes backtests work: 2025 rookies show `years_exp = 1` today. **After Week 14, freeze the final top fives into a snapshot table** so the page doesn't change during the offseason.
9. **Position buckets.** Map `players.position` (the positions currently rostered are `CB, DB, DE, DL, DT, FB, K, LB, NT, QB, RB, TE, WR`) as follows:
   - QB, RB, WR, TE stay as they are; FB → RB.
   - K stays K.
   - DE, DT, NT, DL → **DL**.
   - LB, OLB, ILB, MLB → **LB**.
   - CB, S, SS, FS, DB → **DB**.

   Two-way players such as Travis Hunter go in the bucket where most of their starts came. A starter's slot can be found by looking up `roster_positions[idx]`, since the order of the starters array follows the league's slot order.
10. **Transactions.**
    - Require `status = 'complete'`, except where failed waiver claims are counted on purpose (§4.3).
    - Trades are stored as one row per asset per side, so deduplicate on `transaction_id`.
    - `transactions.year = 2026` begins on **Feb 11, 2026** and includes the whole offseason. Every offseason transaction is stored as `week = 1`, so filter on `created` (epoch milliseconds) whenever the date matters.
    - **In 2026, every player add is a waiver claim.** The `free_agent` rows in 2026 contain drops only (209 transactions, no add legs).
11. **Franchise joins.**
    - Season-aware join: `f.sleeper_id = x.roster_id::text AND season BETWEEN f."from" AND COALESCE(f."to", 9999)`.
    - `"from"` and `"to"` are reserved words; quote them everywhere.
    - `roster_id` is an integer and `sleeper_id` is text, so cast before joining.
12. **Which franchise to show on a player card.**
    - Use the current roster (`scdfl.rosters`) if the player is rostered. Otherwise use the franchise that started him most recently.
    - If two franchises each started him at least twice, show both, e.g., "WR, TOR/PEI" as on last year's Nabers card.
    - For the MVP win-percentage gate, use the franchise with the most 2026 starts.
13. **Kickers are excluded** from player awards by default (`include_kickers = false`). The league has never nominated one.

---

## 3. Shared building blocks

Build these once as CTEs or `sandbox` views. The award queries in §4 combine them. Every tunable value lives in one `params` CTE (§6).

### B1. `player_2026`: one row per player, starts only

```sql
-- sketch, not final
starts AS (
  SELECT v.week, v.roster_id, v.player_id, v.points,
         (ns.gsis_id IS NOT NULL) AS played
  FROM scdfl.v_player_starts v
  LEFT JOIN scdfl.player_ids pi ON pi.sleeper_id = v.player_id
  LEFT JOIN scdfl.nfl_stats ns ON ns.gsis_id = pi.gsis_id AND ns.season = v.year
       AND ns.week = v.week AND ns.season_type = 'REG'
  WHERE v.year = :season AND v.week <= :as_of_week
)
SELECT player_id,
       count(*)                               AS starts,
       count(*) FILTER (WHERE played)         AS games,
       sum(points)                            AS fpts,
       sum(points) / NULLIF(count(*) FILTER (WHERE played), 0) AS ppg,
       count(*)::numeric / :as_of_week        AS start_rate
FROM starts GROUP BY player_id;
```

Add the following columns:
- `pos` (bucket from §2.9)
- `season_exp`
- `primary_franchise` (most starts) and `display_franchise` (§2.12)
- Stat-line sums from `nfl_stats` for the cards (passing, rushing and receiving yards and TDs, receptions, carries, tackles, sacks, etc.)

### B2. Replacement level, VORP and positional z-scores

These put a TE and a QB on the same scale.

- **Starters per position are measured, not configured.**
  - `N_pos = round(average number of league-wide starts at that position per week)`, computed from `v_player_starts` for the current season.
  - This handles superflex and flex slots without hard-coding lineup rules.
  - Values for Weeks 1–9 of 2026 are below; recompute them at build time.

  | Bucket | Starts per week (league) | Per team | `N_pos` |
  |---|---|---|---|
  | WR | 52.6 | 3.75 | 53 |
  | RB | 36.9 | 2.63 | 37 |
  | QB | 26.1 | 1.87 | 26 |
  | TE | 23.8 | 1.70 | 24 |
  | LB | 21.2 | 1.52 | 21 |
  | DL | 18.8 | 1.34 | 19 |
  | DB | 16.7 | 1.19 | 17 |
  | K | 14.0 | 1.00 | 14 |

- **Replacement pool:** players with `games >= max(3, ceil(as_of_week / 3))`. Keep this pool loose. Managers rotate starters, so a strict pool can have fewer than `N_pos` players. Example: through Week 9, only 51 WRs had 5+ games against `N_pos = 53`, which pushed WR replacement down to 3.5 ppg.
- `repl_ppg[pos]`: the PPG of the `N_pos`-th ranked player in the replacement pool, ranked by PPG. With a pool of 3+ games through Week 9, this gives QB 13.4, LB 11.2, DB 9.4, TE 9.0, RB 8.9, DL 8.5, WR 7.3. If the pool is still smaller than `N_pos`, use 0.75 × the average points per played start at the position.
- **Qualified pool** (for `ppg_z` and the per-award start-rate gates): `starts >= max(3, qualified_start_rate × as_of_week)`. Default `qualified_start_rate` is 0.5.
- `vorp_total = fpts − games × repl_ppg[pos]`. This is points above a replacement-level starter, accumulated over games played. Being available more often raises it, which is intended.
- `ppg_z = (ppg − mean_pos) / sd_pos`, computed within the position over the qualified pool. Use it where awards compare players across positions without rewarding volume.

### B3. `baseline`: per player per season, all NFL games, 2021–2025

From `sandbox.player_windows_thru_2025`, joined to `nfl_stats` REG to identify games played:
- `games_s`, `pts_s` and `ppg_s` for each season `s`
- `ppw_s = pts_s / 17` (points per available week; low for an injury-shortened season as well as for a bad one)
- Career columns: `career_games_pre`, `career_ppg_pre`, for all seasons before a cutoff year

**Established line:** `estab_ppg[pos, s]` is the PPG of the 14th-best player at the position in season `s`, among players with at least 6 games. The rank 14 is the knob `established_rank`, roughly "every franchise's #1 at that position."

### B4. `expectations`: preseason ADP

From `sandbox.player_projections_2026`:
- `adp_idp < 999` means the player was drafted; 999 is Sleeper's sentinel for undrafted.
- Note that this table's `player_id` is a bigint, so cast it when joining to `players.player_id`.
- `adp_pos_rank`: `row_number()` over `adp_idp` ascending, partitioned by position bucket, among all players with an ADP.
- Coverage check: of the 2026 rookies who were taken in the SCDFL draft or have a Sleeper ADP, all but one TE have an `adp_idp` value (WR 33, DB 18, RB 16, DL 14, LB 13, TE 12 of 13, QB 12). A rookie with no ADP can't qualify for Rookie Bust.

### B5. `franchise_season`: one row per franchise per season

From `scdfl.matchups` with `game_type = 0` and `week <= as_of_week` (the full 14 weeks for past seasons):
- W–L–T, `win_pct` (ties count as half a win)
- PF, PA, PF per game, and ranks for each
- Playoff position: an approximate standing by win% then PF. The official tiebreaker is head-to-head, then PF, with a separate rule for ties between three or more teams; see the data-and-modeling notes. Use `scdfl.results` for past seasons' seeds and finishes.
- `exp_wins_line = projections.win_ou × games / 14`, the preseason win total prorated to games played. This table only has 2026.
- Transaction count: distinct completed `transaction_id`s per roster in the season. Shown on the card; not scored.

### B6. `pick_value`: what a rookie pick is worth, in points

- For each round, the mean SCDFL started points (weeks 14 and earlier) that rookie-draft picks produced over their first 2 seasons (the knob `pick_horizon_seasons`).
- Compute it from rookie drafts with complete windows (2022–2024 for a 2-season horizon).
- 2022 has two drafts (`rookie` and `idp`). Filter on `drafts.type = 'rookie'`; every rookie draft from 2022 to 2026 has exactly 56 picks.
- Two-season values (2022–2024 drafts, as of Nov 2026): **R1 244, R2 80, R3 46, R4 40**. For comparison, rookie-season-only values (2022–2025 drafts) are R1 115, R2 32, R3 19, R4 21. Recompute at build time.
- Used to value future picks in trades (§4.13–4.14).

### B7. `nfl_team_weeks`: bye and schedule (new data needed)

`nfl_stats` has no team column, and `players.team` only shows a player's current team. Two options:

- **(a) Recommended:** load nflverse's `games.csv` into a new table `scdfl.nfl_schedule(season, week, game_type, home_team, away_team)` as part of the nightly ETL. It's small and stable.
- **(b) Fallback:** treat a week as a team's bye if no player whose current `players.team` is that team has an `nfl_stats` row that week. This breaks when a player switches NFL teams mid-season, which is rare.

**Also worth doing:** add nflverse's `recent_team` to the `nfl_stats` ETL. It makes "which team did he play for that week" exact.

B7 is used for byes in `start_rate` and for detecting missed games in Tough Break.

---

## 4. Award methodologies

Each award lists eligibility, the score, what the card shows, and the 2025 reference results (from the ballot images and `scdfl.accolades`). **★** marks last year's winner.

### 4.1 Most Valuable Player (`mvp`)

**Intent:** Highest PPG, nearly every week started, on a winning team.

**Eligibility:**
- `season_exp >= 1` (veteran)
- `start_rate >= 0.75` (knob `mvp_start_rate_min`)
- Primary franchise `win_pct >= 0.500` to date
- Not a kicker

**Score:** `vorp_total` (B2), highest first.
- Tiebreak 1: `team_share = fpts / franchise PF to date`, which measures "meaningfully contributed to his fantasy team."
- Tiebreak 2: `ppg`.

**Card:**
- Line 1: "13 games, 327.52 fpts (25.19 ppg)"
- Lines 2–4: position-specific stats (QB: passing yards, passing TDs, rushing; RB: scrimmage yards, carries/receptions, total TDs; WR/TE: receptions, scrimmage yards, TDs; IDP: tackles, TFL, sacks, QB hits, PBUs, INTs)

**Notes:**
- In the middle of the season, the win-percentage gate can switch on and off from week to week. Show it as a badge so readers understand why a player dropped out.
- The earlier `mvp_comp` (VORP plus z-scores) was built on projections. This version uses actual points but keeps the same VORP idea.

**2025 reference:** Josh Allen (SAR), **★ Jahmyr Gibbs (WPG)**, Christian McCaffrey (TBY), Jaxon Smith-Njigba (BKB), Jonathan Taylor (BKB).

### 4.2 Breakout Player of the Year (`breakout`)

**Intent:** A non-rookie with high 2026 PPG who starts a lot, after a poor career up to 2025.

**Eligibility:**
- `season_exp >= 1`
- `start_rate >= 0.5`
- `ppg_2026 >= repl_ppg[pos]`: he is now a real starter.
- **Never established:** no season from 2021 to 2025 with at least 6 games and `ppg_s >= estab_ppg[pos, s]`. This is the mirror image of Comeback, so a player can't qualify for both.
- `career_ppg_pre2026 <= breakout_ratio × ppg_2026`. Default `breakout_ratio` is 0.65.

**Score:** `(ppg_2026 − career_ppg_pre2026) / sd_pos`, a positional z of the improvement. Tiebreak: `vorp_total`.

**Card:**
- "13 games, 211.5 fpts (16.3 ppg)"
- 2026 stat line, e.g., "75 - 554 - 7"
- "Prior to 2026: {career_games} games, {career_ppg} ppg"

**2025 reference:** Jake Ferguson (TBY), Troy Franklin (CHC), Trey McBride (NNY), George Pickens (TBY), **★ Jaxon Smith-Njigba (BKB)**.

Expect McBride to fail the never-established gate because of his 2024 season. That's acceptable: the 2025 ballot was put together by eye.

### 4.3 Waiver Pickup of the Year (`waiver`)

**Intent:** The best producer acquired on waivers right before or during the season.

**Eligibility:**
- A 2026 transaction with `type = 'waiver'`, `action = 'add'`, `status = 'complete'`, created on or after `waiver_window_start`.
  - Default: **2026-07-19**, the day after the 2026 rookie draft. `drafts` has no date column; July 18 is inferred from the burst of trades involving 2026 picks that day.
  - Changed from Aug 1 after the Week 9 gut check. Post-draft claims (Boye Mafe, Jul 20; Jacob Rodriguez, Jul 19) are "immediately before the season." May claims (e.g., Quincy Williams) are not.
- If a player was claimed more than once in the window, use the earliest claim.
- Not a kicker.
- **At least 3 games** since the claim (`waiver_min_games`). Without this floor, players with one or two big games outranked full-season contributors in the Week 9 gut check.

**Production** counts only starts from the claim's `week` onward, on any roster. This is usually the claiming franchise.

**Score:** `vorp_since_claim`, using the same `repl_ppg` as B2. Tiebreak: `fpts_since_claim`.

**Card:**
- "5 games, 111.66 fpts (22.33 ppg)"
- "$200 FAAB, 0 other bids": `waiver_bid` from the winning claim. "Other bids" is the number of distinct rosters with a failed claim (`status = 'failed'`, `action = 'add'`) on the same `player_id` in the same `week`.
- Position stat lines

**Note:** The largest bid in the data is 1000, so check what the FAAB budget is before the page displays bids.

**2025 reference:** Jacoby Brissett (NFD), Tykee Smith (TOR), Tre Tucker (NNY), Tuli Tuipulotu (NFD), **★ Byron Young (TBY)**.

### 4.4 Comeback Player of the Year (`comeback`)

**Intent:** An established veteran whose 2025 season was ruined by injury, poor play, or both, and who rebounded in 2026.

**Eligibility:**
- `season_exp >= 2`, so there is at least one season before 2025.
- **Established before 2025:** at least one season from 2021 to 2024 with 6 or more games and `ppg_s >= estab_ppg[pos, s]`. Call his best such PPG `peak_ppg`.
- **2025 was a down year:** `ppw_2025 <= comeback_down_ratio × peak_ppg` (default ratio 0.6). Using points per available week means 4 good games followed by 13 missed counts as a down year, just like 17 bad games.
- **Rebound:** `start_rate >= 0.5` and `ppg_2026 >= repl_ppg[pos]`.

**Score:** `(ppg_2026 − ppw_2025) / sd_pos`. Tiebreak: `vorp_total`.

**Card:**
- "9 games, 238.0 fpts (26.4 ppg)" and the 2026 stat line
- "2025 total season: {games_2025} games, {ppg_2025} ppg", where `ppg_2025` is per game played, as on last year's card

**2025 reference:** Travis Etienne (NFD), **★ Christian McCaffrey (TBY)**, Chris Olave (PEI), Dak Prescott (GLD), Devin White (PEI).

### 4.5 Old Man of the Year (`geriatric`)

**Intent:** The best production relative to age.

**Eligibility, by `season_exp`:**
- QB: at least 13 (the spec's "more than 12")
- RB, WR, TE: at least 9
- DL, LB, DB: at least 11

These are soft thresholds. Players exactly one year short are eligible with `near_threshold = true` and a −0.25 penalty to their score (knobs `geriatric_near_margin` and `geriatric_near_penalty`). Kickers are excluded. Each player also needs `start_rate >= 0.5`.

**Score:** `ppg_z`, a positional z of 2026 PPG, so a 12-ppg TE can compete with a 20-ppg QB. Tiebreak: higher `season_exp`.

**Card:**
- "13 games, 276.66 fpts (20.59 ppg)"
- "{season_exp + 1}th NFL season"
- Stat line

**2025 reference:** Davante Adams (LOW), Hunter Henry (MIS), Danielle Hunter (TBY), Travis Kelce (IQT), **★ Matthew Stafford (LOW)**.

### 4.6 Rookie of the Year (`roty`)

**Eligibility:** `season_exp = 0`; `starts >= 2` (knob `roty_min_starts`); not a kicker. There is no start-rate or team-record gate, because rookies often take over partway through the season.

**Score:** `vorp_total`. Tiebreak: `ppg`.

**Card:** Same as MVP.

**2025 reference:** Jaxson Dart (WPG), **★ Emeka Egbuka (NFD)**, Tetairoa McMillan (BKB), Carson Schwesinger (WPG), Tyler Warren (SAR).

### 4.7 Value Rookie of the Year (`vroty`)

**Intent:** Rookie production relative to late SCDFL draft capital.

**Draft slot:**
- `overall_pick` comes from `scdfl.draft_results` joined to `drafts` where `year = 2026` and `type = 'rookie'`. The draft had 56 picks: 4 rounds of 14.
- Rookies nobody drafted in SCDFL (later waiver adds) get `overall_pick = 57` and an `undrafted` flag, since they cost no draft capital.

**Eligibility:**
- `season_exp = 0`
- `overall_pick >= 15`, i.e., round 2 or later (knob `vroty_min_pick`). This keeps "late capital" meaningful; last year's nominees were all picks 29 through 49.
- `starts >= 2`

**Score:** `fpts × ln(1 + overall_pick)`, the "production times inverse draft capital" weighting from the spec.
- This uses raw `fpts` rather than VORP. Most late-round rookies are below replacement, and multiplying a negative number by a weight gives nonsense.
- Applied to the numbers on last year's cards, this formula orders the nominees: Schwesinger ★ (505), Marks (331), Monangai (322), Gadsden (217), Helm (184).
- Alternative to report next to it: `fpts − expected_rookie_fpts_at_slot`, using a by-pick version of B6.

**Card:**
- "8 games, 132.6 fpts (16.6 ppg)"
- "Drafted 4.02 (44th ovr)", or "Undrafted" for waiver rookies
- Stat line

**2025 reference:** Oronde Gadsden (TBY), Gunnar Helm (NNY), Woody Marks (SAR), Kyle Monangai (PEI), **★ Carson Schwesinger (WPG)**.

### 4.8 Biggest Bust (`jamielee`)

**Intent:** A veteran whose positional finish fell far below his positional ADP.

**Eligibility:**
- `season_exp >= 1`
- `adp_pos_rank <= N_pos`: he was drafted as a starter at his position.
- Not a kicker

**Finish rank:** Rank by total started `fpts` within the position, among every player with at least one 2026 start. Players with zero starts are ranked after all of them. Use total fpts (not PPG) so that missed time counts, as on last year's ballot (Burrow: QB4 preseason, QB41 finish).

**Score:** `ln((finish_rank + k) / (adp_pos_rank + k))`, with `k = bust_rank_smoothing` (default 5).
- **Why the constant:** the plain ratio `ln(finish / adp)` explodes when the ADP rank is tiny.
  - In the Week 9 gut check, Ja'Marr Chase (WR1 → WR6) ranked 8th and Roquan Smith (LB1 → LB10, 13.7 PPG) ranked 3rd. Neither is a bust.
  - With `k = 5`, both drop out, and the top eight are all real collapses.
- On last year's ballot, the plain ratio ordered Nabers (3.04), Burrow (2.33), Evans (1.99), Hill (1.90), Thomas ★ (1.75). With `k = 5`, those were extreme enough that the order barely changes.
- Also report a PPG-based finish rank and `pts_shortfall` (the points scored by whoever finished at his ADP rank, minus his own points) as context columns.
- **Known effect:** finish ranks use starts only, so IDP players a manager benches (e.g., Maxx Crosby, Kam Curl: 9 NFL games, 1–2 SCDFL starts) look like busts. Starts-only is the canonical rule; the `nfl_games` column on the card makes it visible.

**Card:**
- "QB4 preseason"
- "60.46 fpts, QB41 finish"
- Flag `injury_driven = true` if he is also flagged by the Tough Break proxy. Last year, Burrow and Nabers appeared on both ballots, so being on both is fine; the flag explains it.

**2025 reference (9 nominees):** Joe Burrow (IQT), James Conner (NFD), Mike Evans (NFD), Tyreek Hill (TBY), Terry McLaurin (LOW), Malik Nabers (TOR/PEI), Calvin Ridley (IQT), **★ Brian Thomas (BKB)**, Garrett Wilson (MIS).

**Limitation:** No 2025 ADP is stored, so this award can't be backtested against numbers (§7).

### 4.9 Biggest Rookie Bust (`sweeney`)

**Method:** Same as §4.8, with `season_exp = 0`. ADP ranks and finish ranks are computed against **all** players at the position, not just rookies, as in the spec.

**Eligibility:**
- `adp_pos_rank <= N_pos`. If fewer than 8 rookies qualify, relax this to the 20 rookies with the best overall `adp_idp`.
- **Taken in round 1 or 2 of the 2026 SCDFL rookie draft** (`rookie_bust_max_round`). The league has to have paid for the expectation.
  - Added after the Week 9 gut check. Without it, Sonny Styles (3.09) was #2 Rookie Bust **and** #5 Value Rookie at the same time, because Sleeper's redraft ADP rated him LB7 while SCDFL took him in round 3.
  - All five of last year's nominees were picks 2–22, so all would pass.

**Score:** `ln((finish_rank + k) / (adp_pos_rank + k))`, the same smoothed ratio as §4.8. A rookie with no starts is ranked last at his position.

**Card:**
- "7 games, 46.5 fpts (6.6 ppg)"
- "WR{adp_pos_rank} preseason, WR{finish_rank} finish"
- "Drafted 2.01 (15th ovr)" for context only; it isn't scored.

**2025 reference:** Luther Burden (PEI), **★ Jacory "Bill" Croskey-Merritt (WPG)**, Matthew Golden (SAR), Travis Hunter (VAN), Kaleb Johnson (PEI).

### 4.10 Worst Injury of the Year (`injury`)

**Intent:** A big-name player whose time out cost his fantasy team the most. Supabase has no injury data, so this uses a proxy plus manual overrides.

**Detecting missed games:**
- A week counts as **missed** if all of these are true:
  - `week <= as_of_week`
  - The player's NFL team played that week (B7)
  - The player has no `nfl_stats` REG row that week
- A **spell** is a run of consecutive missed games. Bye weeks don't end a spell.
- Keep each player's most costly spell in 2026, and ignore spells shorter than 2 games (knob `injury_min_spell`).
- A spell is still **ongoing** if it reaches the player's last NFL team-week through `as_of_week`, or if Sleeper's `players.injury_status` is IR, PUP or Out.
- Players whose `injury_status` is **Sus** are excluded, since suspensions aren't injuries.
- **Don't rely on `injury_status`.** Sleeper's injury status is mostly blank. Through Week 9, Dart, Monangai, Edgerrin Cooper and Hufanga had 4–6 straight missed games with no status and `status = 'Active'`. Use the stat-row gaps as the signal, and treat `injury_status` only as a bonus "ongoing" flag.
- **Bye fallback (until B7 exists):** a team played week `w` if at least 15 players whose current `players.team` is that team have an `nfl_stats` REG row that week. Weekly row counts confirm the feed is complete: about 1,110 per week in Weeks 1–4, dropping only in bye weeks.

**Pre-injury PPG:**
1. Starts-only PPG in 2026 before the spell, if he played at least 2 such games.
2. Otherwise, his 2025 all-games PPG (B3).
3. Otherwise, his preseason projection divided by 17.

**Estimated cost:** `lost_pts = missed_games × pre_injury_ppg`. This is last year's formula: Burrow 15.1 × 9 ≈ −136.0; Nabers 16.0 × 9 ≈ −144.2.

**Eligibility:**
- **He was on an SCDFL roster when the spell began:** a franchise started him in 2026 before the injury, or he is rostered now.
- **Big name:** `adp_pos_rank <= N_pos`, **or** at least 2 games played for an SCDFL franchise in 2026 before the spell with `pre_injury_ppg >= repl_ppg[pos]`.
  - Don't let 2025 PPG qualify a player by itself. In the Week 9 gut check, that let in backups who simply weren't playing: Flacco, Justin Fields, Wentz and Jake Tonges.
- **Franchise credit:** the franchise that held him when the spell began, rebuilt from `transactions` and `draft_results` (his last completed add on or before the spell's start).
  - `scdfl.rosters` only shows current rosters, so it gets this wrong for traded players. Josh Jacobs was hurt from Week 1 while on TOR, but `rosters` now shows TBY.
  - Fallback: the last franchise to start him before the spell.

**Score:** `lost_pts`, highest first. Tiebreak: lower `adp_idp`.

**Override table:** `sandbox.injury_overrides`, with columns:

| Column | Meaning |
|---|---|
| `year` | Season |
| `player_id` | Sleeper player ID |
| `action` | `include`, `exclude` or `adjust` |
| `injury_week` | Week the spell began |
| `return_week` | Week he returned |
| `note` | Free text |

- `exclude` covers benchings, holdouts and false gaps. The proxy can't tell an injury from a benching or a holdout, so **review the top 10 every week until the season ends.**
  - Week 9 example: Myles Garrett ranks #1 (8 missed games, −164 points) but now plays for LAR. That looks like a holdout and trade, not an injury.
  - A player who appeared in a game but recorded no stats may also have no `nfl_stats` row.
- `include` and `adjust` cover injuries the proxy can't see, such as preseason injuries or wrong spell dates.

**Card:**
- "4 games, 60.46 fpts (15.1 ppg)"
- "Injured in Week 2"
- "Missed 9 games" (append "and counting" if the spell is ongoing)
- "Estimated −136.04 fpts"
- Optionally, a manual note such as "Traded to Choccolocco," which last year's McCarthy card had

**2025 reference:** Joe Burrow (IQT), Omarion Hampton (CHC), Aaron Jones (NFD), **★ Malik Nabers (TOR/PEI)**, JJ McCarthy (BKB).

### 4.11 Manager of the Year (`moty`)

**Intent:** The most outstanding 2026 season: a strong win percentage, beating the preseason win line, and heading to the playoffs.

**Inputs (B5):** `win_pct`, `wins_over_line = wins − exp_wins_line`, PF per game, and playoff position.

**Eligibility:** `win_pct >= 0.500` or currently holding a playoff spot.

**Score:** `z(win_pct) + z(wins_over_line) + 0.5 × z(pf_per_game)`, with z-scores taken across all 14 franchises. These weights are a knob.

**Card:**
- "9-5, 2-seed" (add context such as "first HCC title" once it's known)
- "7th in Points For, 8th in Points Against"
- "+1.8 wins vs. preseason line"
- "43 transactions"

**2025 reference (4 nominees):** PEI (Jared), BKB (Jacob), SAR (Pat), **★ TBY (Steve)**.

**Limitation:** `scdfl.projections` only covers 2026, so drop the `wins_over_line` term when backtesting.

### 4.12 Most Improved Franchise (`mif`)

**Intent:** The biggest jump from 2025 to 2026, with extra credit for actually being good in 2026.

**Inputs (B5):**
- `d_win = win_pct_2026 − win_pct_2025`, using 2025's full regular season
- `d_ppg = pf_per_game_2026 − pf_per_game_2025`

**Eligibility: a poor 2025.** The franchise either missed the 2025 playoffs or lost in the first round (`scdfl.results`, `year = 2025`).
- Added after the Week 9 gut check, where the ungated score ranked the defending champion BKB 3rd.
- All four of last year's nominees pass the equivalent gate, including TBY (2024: 8-6, 7-seed, first-round loss).
- There is no gate on the 2026 record. Last year NNY was nominated at 3–11 because it improved from 1–13 and +211.86 PF.

**Score:** `z(d_win) + z(d_ppg) + 0.5 × z(win_pct_2026)`, with z-scores taken across all 14 franchises before the gate is applied.

**Card:**
- "7-7, 2nd playoff appearance, 6-seed"
- "2025: 6-8, no playoffs"
- "+187.04 point differential vs LY", where the differential is `d_ppg × games_2026`

**2025 reference (4 nominees):** NFD, NNY, **★ SAR**, TBY.

### 4.13 Most Impactful Trade (`goodtrade`)

**Method: "Welcome to the Farm" trade valuation, adapted for in-season use.**

**Which trades count:**
- Completed 2026 trades (`type = 'trade'`, `status = 'complete'`, deduplicated on `transaction_id`). That gives 48 trades so far, from Feb 11 onward.
- **Exclude reversals:** a later trade between the same rosters with exactly the mirrored assets within `reversal_window_days` (default 14). Drop both trades.
- **Exclude commissioner undos:** trades whose assets were moved back by `type = 'commissioner'` transactions within a day. The Adams trade on April 30, 2026 is an example.
- **Exclude anything listed in `sandbox.trade_exclusions`** (`transaction_id`, `note`). Use it for joke trades and contract dumps.
- **Flag for review, but don't drop automatically:** trades where the receiver dropped a received player within 24 hours.

**Method:** This uses the documentary's trade ledger with two changes for an in-season page, both adopted on Nov 15 after the Weeks 1–9 gut check:
- **Tenure crediting** replaces follow-the-asset.
- **Projected rest-of-season points** are added for players received.

Each side's value has three parts.

- **Realized points (tenure).** Sum the received player's starts **by the receiving roster** (`v_player_starts.roster_id = receiving roster_id`) from the trade's `week` through `as_of_week`.
  - Points he scores after being flipped elsewhere don't count.
  - Using `roster_id` also handles mid-week trades. Don't use a date-based week cutoff.
  - Picks in the 2026 rookie draft that were traded before the draft resolve to the player actually selected. Match on `pick_season`, `pick_round` and `pick_original_roster_id` against `draft_results`.
    - **If the receiving roster made the pick** (`draft_results.roster_id = receiving roster`), credit that player's starts by the receiving roster like any other player.
    - **If the receiving roster traded the pick away before the draft,** credit it as draft capital at `pick_value[round]`. The receiver spent it as currency in another trade.
    - Without this, a pick the receiver flipped scores 0. In the Week 9 gut check, that made TOR's side of the May 19 Walker trade worth 7 points; TOR had flipped the 2026 first and second the next day.
    - Known effect: a pick that changes hands several times before the draft is credited at full value in each trade. This is the same chain double counting as follow-the-asset, accepted here because a pick's value at the moment of the trade is what each receiver actually got.
  - Known gap: if a player leaves and later returns to the same roster through another trade, his later starts count for both trades. Cap the window at the week he first left the receiving roster if this ever matters.
- **Projected rest of season (`ros`).** For each received player (including resolved 2026 rookies):

  `ros = ppg_2026 × usage × (14 − as_of_week)`
  - `ppg_2026` is his 2026 PPG across all games played.
  - `usage = min(1, starts by the receiving roster since the trade / weeks since the trade)`. A player the receiver doesn't start projects to zero.
  - `ros = 0` if he's no longer on the receiving roster (`scdfl.rosters`), or if his `injury_status` is IR, PUP or Sus.
  - **Why it's added:** draft capital is valued on what it will produce, so players should be valued on what they will still produce this season, too. Otherwise in-season trades are buried by short realized windows.
  - `ros` shrinks to 0 by Week 14, so the final ballot ranks on realized points plus capital only.
- **Draft capital.** Each unresolved pick (2027 or later) is worth `pick_value[round]` from B6.
  - Because the future draft slot isn't known yet, use the average for the round.
  - A possible later refinement: weight the pick by the original owner's projected finish.
- **Side value:** `V = realized + ros + λ × capital`, where `λ` is the knob `capital_weight` (default 1.0).
- **Three-team trades:** Use the documentary's split. A side's value given equals the rest of the trade's value divided evenly among the other participants. **Both of 2025's winning trades involved three teams or big capital packages, so this matters.**

**Balance gate:** `min(V_sides) / max(V_sides) >= trade_balance_gate` (default 0.5).
- Most Lopsided (§4.14) uses the complement, so **a trade can be on one board or the other, never both.**
- Added after the Week 9 gut check, where the Bijan trade ranked #4 Impactful and #1 Lopsided at the same time.

**Score:** `min(V_sides)`, highest first. It's high only when **every** side received a lot, which is the spec's "both teams saw benefit." Tiebreak: `sum(V_sides)`, as the "impacted the league as a whole" part.

**Known effects:**
- **Why not follow-the-asset.** The documentary's rule credits every trade a player passed through.
  - Through Week 9, it credited Mike Evans's BKB points to the April LOW–VAN trade, Javonte Williams's NNY points to the March GLD–TOR trade, and Kenneth Walker's NNY points to TOR's side of the February Lamb trade.
  - It's still available as `credit_mode = 'follow_asset'`. In that mode, drop any start by a sending roster at or after the trade week. Otherwise mid-week trades misfire: Bijan Robinson played Thursday night in Week 3 for TBY before his trade processed, and a date cutoff credited those 38.3 points to TOR.
- **Early trades are favored.** Offseason trades have had the whole season to earn points, while deadline trades have only had a few weeks. This bias is acceptable for a "current leaders" page; say so in the page's methodology text.

**Card:**
- Date and week
- Each side: franchise abbreviation, assets received (player names; picks as "2028 1st (TBY)"), realized points, capital value, total
- A one-line verdict

**2025 reference: ★ `1278818557269938176`** (Sep 30, 2025, Week 4):
- TBY received Christian McCaffrey.
- CHO (now CHC) received Troy Franklin, a 2026 R2 (PEI) and a 2028 R1 (TBY).
- There's no ballot image for trades, so this winner is the only check.

### 4.14 Most Lopsided Trade (`badtrade`)

**Trades and side values:** Same as §4.13.

**Eligibility:**
- `min(V_sides) / max(V_sides) < trade_balance_gate` (the complement of §4.13's gate).
- `max(V_sides) >= lopsided_min_value` (knob, default 100) so a lopsided swap of fringe players doesn't win.

**Score:** `max(V_sides) − min(V_sides)`, highest first. Tiebreak: `max/min` ratio.
- On the card, name the winning side and the losing side.

**2025 reference: ★ `1266941466551275520`** (Aug 28, 2025), a three-team trade:
- PEI received Breece Hall.
- NFD received James Conner, Jimmy Horn, Jaylin Lane, a 2026 R1 (PEI), a 2026 R4 (WPG), a 2028 R2 (PEI) and a 2028 R4 (PEI).
- TOR received Dyami Brown, Malachi Corley, a 2027 R2 (PEI), a 2028 R1 (PEI) and a 2026 R4 (TOR).

---

## 5. Output contract

Produce one long table or view, `sandbox.superlative_leaders`. Promote it to `scdfl` once it's validated.

| Column | Type | Notes |
|---|---|---|
| `season` | int | 2026 |
| `as_of_week` | int | Show as "through Week N" on the page |
| `award_code` | text | Matches `accolades.award_code` |
| `rank` | int | 1–5; MOTY and MIF can stop at 4 |
| `player_id` | text | Player awards |
| `sleeper_id` | text | Franchise awards (roster ID as text) |
| `transaction_id` | text | Trade awards |
| `franchise_abbr` | text | Display franchise (§2.12); for trades, an array or a JSON object per side |
| `score` | numeric | The award's score as defined in §4 |
| `headline` | text | e.g., "13 games, 327.52 fpts (25.19 ppg)" |
| `detail_lines` | text[] | 2–3 card lines, as in §4 |
| `flags` | text[] | e.g., `near_threshold`, `injury_driven`, `ongoing`, `undrafted`, `below_500` |
| `payload` | jsonb | Raw metrics (starts, games, fpts, ppg, vorp, z-scores, ADP ranks) for tooltips and debugging |

- **Freeze it after Week 14.** Write the final rows to a snapshot table such as `sandbox.superlative_leaders_final` (or with a `final` flag). That snapshot becomes the ballot nominee list. Winners then go in `scdfl.accolades` once the vote closes.
- **Expect five per award.** Last year's ballots varied (9 for Bust, 4 for MOTY and MIF). The page shows five. Zac can trim or add when he builds the ballot.

---

## 6. Parameters (one `params` CTE)

| Knob | Default | Used in |
|---|---|---|
| `season` | 2026 | all |
| `as_of_week` | Sleeper `state.week − 1`, capped at 14 | all |
| `include_kickers` | false | player awards |
| `qualified_start_rate` | 0.5 | B2 pool, Breakout, Comeback, Geriatric |
| `mvp_start_rate_min` | 0.75 | MVP |
| `mvp_team_win_pct_min` | 0.500 | MVP |
| `established_rank` | 14 | B3, Breakout, Comeback |
| `min_games_season` | 6 | B3 |
| `breakout_ratio` | 0.65 | Breakout |
| `comeback_down_ratio` | 0.6 | Comeback |
| `waiver_window_start` | 2026-07-19 (day after the rookie draft) | Waiver |
| `waiver_min_games` | 3 | Waiver |
| `bust_rank_smoothing` (k) | 5 | Bust, Rookie Bust |
| `rookie_bust_max_round` | 2 | Rookie Bust |
| `trade_balance_gate` | 0.5 (Impactful at or above, Lopsided below) | trades |
| `geriatric_thresholds` | QB 13 / RB, WR, TE 9 / IDP 11 | Geriatric |
| `geriatric_near_margin` / `geriatric_near_penalty` | 1 year / 0.25 | Geriatric |
| `roty_min_starts` | 2 | ROTY, VROTY |
| `vroty_min_pick` / `undrafted_pick` | 15 / 57 | VROTY |
| `rookie_bust_min_pool` / fallback pool | 8 / top 20 by overall ADP | Rookie Bust |
| `injury_min_spell` | 2 games | Tough Break |
| `pick_horizon_seasons` | 2 (**1 recommended, awaiting Zac's call**; see tuning log) | B6, trades |
| `capital_weight` (λ) | 1.0 | trades |
| `reversal_window_days` | 14 | trades |
| `credit_mode` | `tenure` (`follow_asset` available) | trades |
| `include_ros` | true; rest-of-season = PPG × usage × weeks left through 14; zero if no longer held or on IR/PUP/Sus | trades |
| `lopsided_min_value` | 100 | Lopsided Trade |
| MOTY weights | win% 1, wins over line 1, PF 0.5 | MOTY |
| MIF weights | d_win 1, d_ppg 1, win% 0.5 | MIF |

---

## 7. Validation: backtest on 2025

Run every award with `season = 2025` and `as_of_week = 14`. Compare the results to the reference lists in §4 and the winners in `scdfl.accolades` (`year = 2025`). The 2025 ballots were chosen by eye, so the target is close agreement, not an exact match.

**Pass criteria:**
- **Last year's winner is in the top 5** for MVP, Breakout, Waiver, Comeback, Geriatric, ROTY, VROTY, MOTY, MIF and both trade awards.
- **At least 3 of last year's nominees are in the top 8** for each of those same awards.

**Awards that can't be fully backtested:**

| Award | Problem | What to do |
|---|---|---|
| Bust, Rookie Bust | No 2025 ADP is stored | Check by hand that the nominees' 2025 finish ranks look badly short of their reputations. |
| Tough Break | The 2025 proxy works, but the big-name gate has to use `pre_injury_ppg` instead of ADP | Burrow, Nabers and Hampton should appear. |
| MOTY | No 2025 projections | Drop the `wins_over_line` term for the backtest. |
| All 2025 runs | 2025 rookies show `years_exp = 1` today | Compute `season_exp` as in §2.8. |

**Tuning:** If an award misses the pass criteria, adjust its knobs in §6. Write down what changed and why in a `## Tuning log` section at the end of this file, so the reasoning carries into later sessions.

---

## 8. Implementation notes for Claude Code

These are suggestions. Settle them with Zac.

- **Build order:**
  1. Building blocks B1–B6
  2. MVP, ROTY, Geriatric, Waiver (they depend only on B1 and B2)
  3. Breakout, Comeback (B3)
  4. Bust, Rookie Bust (B4)
  5. MOTY, MIF (B5)
  6. Trades (B6 plus the reversal logic)
  7. Tough Break (B7 plus the override table)
- **Test before committing.** Prototype each award's SQL with `execute_sql` and check the results against the 2025 backtest before writing any migration or view.
- **New objects:**
  - `scdfl.nfl_schedule`, or a `team` column on `nfl_stats` (B7)
  - `sandbox.injury_overrides` (§4.10)
  - `sandbox.trade_exclusions` (§4.13)
  - `sandbox.superlative_leaders` and its final snapshot (§5)
- **Page:**
  - Location: either a "2026 Race" view inside the Hall of Fame `/superlatives` wing, or a standalone route. Zac decides.
  - Layout: one card per nominee, echoing the ballot graphics (a 2-column grid of five cards plus a title block).
  - Styling: the league's design tokens and franchise fonts.
  - **Methodology:** a collapsible "How leaders are chosen" section per award that summarizes §4 in plain language.
- **Astro reminder:** Don't put a `CLAUDE.md` inside `src/pages/`, because Astro treats every file there as a route.
- **Refresh:** The nightly Supabase cron that redeploys Netlify picks up new data automatically. After Week 14, the page should read from the frozen snapshot.

---

## Tuning log

*(Claude Code adds entries here during the backtest.)*

### 2026-11-15: Gut check, 2026 Weeks 1–9 (planning chat)

These were run directly against Supabase while planning.

**Fixes already written into this document:**
- B2 replacement pool
- §2.5 definition of games played (the `gsis_id` gap)
- B6 pick values
- §4.13 effects of flipped players and mid-week trades

**Results through Week 9:**
- **MVP:** JSN, Gibbs, Lamb, Walker, Nacua.
  - QBs are absent: Josh Allen (26.4 ppg) has about 104 VORP, roughly 17th.
  - QB replacement is high in superflex (13.4 ppg vs. WR 7.3), so QBs need a much bigger per-game edge.
  - Open: blend in `ppg_z` if the board should look more like past ballots.
- **Value Rookie:** Reese, Bailey, Thieneman, Downs, Styles, all IDP from round 3.
  - The late offensive picks haven't produced (Malachi Fields, 31.7 fpts, is the best of them), so this reflects the season rather than a formula bias.
- **Manager of the Year:** BKB 3.60, MIS 3.53, NNY 2.88, PEI 2.03, LOW 0.74.
- **Most Impactful Trade:** weakest of the four boards.
  - Under follow-the-asset, flipped players were credited to trades they'd already left (see §4.13).
  - Unresolved R1s at 244 points outweigh 9 weeks of realized production.
  - In-season blockbusters were held down by short realized windows. The Bijan trade (three 2028 1sts) ranked 4th to 7th depending on mode.

**Decision (Zac, Nov 15):** tenure crediting plus projected rest-of-season points. §4.13 and §6 are updated.

**Re-run under the adopted method:**

| # | Trade | `min(V)` | `total` |
|---|---|---|---|
| 1 | LOW–VAN, Apr 30 | 386 | 801 |
| 2 | BKB–TOR Lamb, Feb 17 | 324 | 687 |
| 3 | CHC–TOR Jeanty, May 26 | 224 | 712 |
| 4 | TOR–TBY Bijan, Sep 24 | 196 | 1,166 |
| 5 | GLD–NNY Lamar/Dak, Mar 9 | 181 | 1,043 |

- Bijan improved from 7th to 4th, and the follow-the-asset errors are gone.
- LOW–VAN stays #1 because each side received a 2027 1st plus real production (Hockenson 172, Concepcion 142). Under a "both sides benefited" rule, that's a legitimate #1.

**Open option, not adopted:** score on `sqrt(min × total)` instead of `min`. That gives LOW–VAN 556, Bijan 478, Lamb 472, Lamar/Dak 434, Jeanty 399. It rewards impact on the league as a whole, not only balance. Lowering λ to 0.5 does **not** change #1.

### 2026-11-15: Gut check, round 2 (Weeks 1–9, planning chat)

**Fixes written into this document:**
- §4.10 Tough Break: stricter big-name gate, franchise credit from transaction history, the bye fallback, and the warning about `injury_status`
- §4.12 Most Improved: eligibility gate on a poor 2025

**Old Man of the Year (§4.5 unchanged):**

| # | Player | NFL season | Games | PPG | `ppg_z` |
|---|---|---|---|---|---|
| 1 | George Kittle, TE LOW | 10th | 6 | 18.18 | 1.15 |
| 2 | Christian McCaffrey, RB CHC | 10th | 8 | 20.84 | 1.05 |
| 3 | Davante Adams, WR LOW | 13th | 6 | 18.33 | 0.94 |
| 4 | Kirk Cousins, QB NFD | 15th | 9 | 20.53 | 0.60 |
| 5 | Travis Kelce, TE IQT | 14th | 8 | 14.85 | 0.40 |

- Next: Mike Evans 0.35, Derrick Henry 0.29, Stafford 0.02.
- Five of the top 10 are LOW players (Kittle, Adams, Stafford, Diggs, Goedert).
- No IDP qualifies yet: none at 11+ years of experience has 5+ starts.

**Tough Break (proxy, with the tightened gate):**

| # | Player | Injured | Missed | Lost pts | Note |
|---|---|---|---|---|---|
| 1 | Myles Garrett, DL MIS | Wk 1 | 8 | 164.3 | **Exclude via override:** now on LAR, looks like a holdout and trade |
| 2 | Micah Parsons, LB MIS | Wk 1 | 9 | 118.9 | PUP, ongoing |
| 3 | Kyle Monangai, RB PEI | Wk 5 | 5 | 95.8 | Ongoing, no status |
| 4 | Josh Jacobs, RB | Wk 1 | 6 | 94.6 | Credit should go to TOR, not TBY (see §4.10) |
| 5 | Nick Bosa, DL BKB | Wk 3 | 5 | 93.3 | Returned Wk 9 |
| 6 | Edgerrin Cooper, LB SAR | Wk 5 | 5 | 80.8 | Ongoing, no status |
| 7 | Jaxson Dart, QB WPG | Wk 3 | 6 | 80.7 | Ongoing, no status; check for a benching |

- Before the gate was tightened, backups (Flacco, Fields, Wentz, Tonges) made the top 12.

**Most Improved Franchise, ungated:** NNY 4.93, MIS 2.80, BKB 2.77, CHC 0.77, PEI 0.70.
- **Gated:** NNY (7-2 vs. 3-11, +69.1 PF/g), MIS (7-2 vs. 6-8), CHC (4-5 vs. 4-10), WPG (6-3 vs. 7-7, first-round exit), LOW (5-4 vs. 9-5, first-round exit).
- 4th and 5th are weak, but that's the actual race at Week 9.

### 2026-11-16: Gut check, round 3 (Weeks 1–9, planning chat)

This round covered the last seven boards.

**Fixes written into this document:**
- §4.3 Waiver: window moved to the day after the rookie draft, plus a 3-game minimum
- §4.8 and §4.9: smoothed bust ratio (`k = 5`)
- §4.9 Rookie Bust: round 1–2 gate
- §4.13: spent 2026 picks credited as capital
- §4.13 and §4.14: balance gate that splits the two trade boards

**Breakout (§4.2 unchanged):** Matthew Golden (GLD, 19.8 PPG vs. 5.4 before), Isaiah Likely (TOR, 18.9 vs. 7.9), Braelon Allen (PEI), Dallas Turner (MIS), Ollie Gordon (PEI).

**Comeback (§4.4 unchanged):** Joe Burrow (IQT), Kirk Cousins (NFD), Jayden Daniels (MIS), Fred Warner (TOR), Brock Purdy (BKB).
- QB-heavy. That's partly real, because 2025 had a wave of QB injuries. It's also partly structural: QB PPG has a tight spread, so the same rebound produces a bigger z-score.
- Purdy and Kyler Murray (#7) "rebound" on availability only; their 2026 PPG is below their 2025 per-game rate.
- Optional, not adopted: require `ppg_2026 >= 0.8 × peak_ppg` so a comeback means returning to near-peak form.

**Rookie of the Year (§4.6 unchanged):** Arvell Reese (NNY, 3.01), David Bailey (LOW, 3.12), Denzel Boston (MIS, 1.06), Carnell Tate (VAN, 1.02), KC Concepcion (VAN, 1.09). Reese and Bailey also lead Value Rookie; last year Schwesinger was on both ballots, so this is fine.

**Waiver (window from Jul 19, 3+ games):** Greg Rousseau (TOR, $415, VORP 51.0), Boye Mafe (CHC, 19.5), Quentin Lake (TOR, 14.8), Kalif Raymond (NNY, 4.6), Jacob Rodriguez (VAN, 2.6). Only about five claims have positive VORP so far. Darren Waller ($1,000, TBY) is at −16.

**Biggest Bust (k = 5):** Myles Garrett (DL2 → DL30), De'Von Achane (RB7 → RB49), A.J. Brown (WR11 → WR64), Edgerrin Cooper (LB5 → LB34), Jack Campbell (LB3 → LB26).
- Next: Micah Parsons, Lamar Jackson, Kam Curl.
- Most are injury-driven. Four of the top six are IDP, because the Sleeper ADP covers IDP and last year's offense-only ballot didn't.

**Biggest Rookie Bust (round 1–2 gate):** Makai Lemon (BKB, 1.08, WR36 → WR96, 0 starts), Jordyn Tyson (IQT, 1.04), Jeremiyah Love (WPG, 1.01), Fernando Mendoza (CHC, 1.03), Jadarian Price (SAR, 1.05).

**Trades (spent-pick fix and balance gate):**

| Board | 1-season pick horizon (R1 = 115) | 2-season pick horizon (R1 = 244) |
|---|---|---|
| Most Impactful | NNY–NFD Mar 9 (LaPorta/Brown/R1 ↔ Tucker/R1), LOW–VAN Apr 30, CHC–TOR Jeanty, NFD–TBY Pickens, GLD–TBY Irving ↔ Washington | NNY–NFD Mar 9, LOW–VAN Apr 30, TOR–NNY Walker May 19, BKB–TOR Lamb, CHC–TBY CMC ↔ Hampton |
| Most Lopsided | GLD–NNY Lamar/Dak (NNY wins), TOR–TBY Bijan (TBY), BKB–LOW Achane/Evans ↔ Swift/McMillan (LOW), GLD–SAR Golden ↔ pick swap (GLD), NFD–TBY Herbert (NFD) | TOR–TBY Bijan, GLD–NNY Lamar/Dak, NFD–TBY Herbert, BKB–LOW, PEI–TOR Hubbard ↔ two 2028 1sts |

**Recommendation: `pick_horizon_seasons = 1`.** Players are valued on 2026 only (realized points plus rest of season), so picks should be valued on one season too. At 2 seasons, a future 1st (244) outweighs Bijan's entire 2026 value to TOR (196), and capital-only deals lead the Lopsided board. **Pending Zac's decision.**

### 2026-11-16: Implementation and backtest (Claude Code session)

**What was built.** The whole methodology is one pure SQL function, `scdfl.compute_superlative_leaders(season, as_of_week, top = 5, pick_horizon = 1)` (`supabase/migrations/20261116150100_superlatives_compute.sql`), with every §6 knob as a `k_*` declaration at its top. The `superlatives` sync step writes `scdfl.superlative_leaders` from it nightly and freezes `superlative_leaders_final` at Week 14; `/superlatives` reads those tables. B7 is a new `scdfl.nfl_schedule` table fed by a `schedule` sync from nflverse `games.csv`. The manual tables are `scdfl.injury_overrides` and `scdfl.trade_exclusions` (built in `scdfl` rather than `sandbox`, since the site reads through the API roles and the backtest below is the validation §5 asked for before promotion).

**Deviations from §4, and why:**
- **Waiver window (§4.3)** is derived, not hard-coded: the day after the last completed trade that moved a current-season pick. That gives 2026-07-19 for 2026 (the spec's value) and 2025-08-24 for 2025, which is what makes the 2025 backtest possible (Byron Young's Sep 10 claim). Falls back to Jul 19 if no such trade exists.
- **Tough Break pre-injury PPG (§4.10)** uses the player's SCDFL starts across the whole season (before *and* after the spell), not only the games before it. The 2025 cards did this — Burrow's "4 games, 60.46 fpts (15.1 ppg), −136.04" is reproduced to the cent — and a pre-spell-only sample can be two bad weeks (Burrow's 2025 pre-spell starts averaged 7.9 and failed the big-name gate).
- **Tough Break big-name gate without ADP (backtest only):** an established previous season (≥ 6 games at or above replacement) also qualifies, since §7 says the gate has to work without an ADP table. With ADP present (2026) nothing changes.
- **Three-team trades (§4.13–14):** instead of the documentary's even split, each side's *given* is valued directly from its drop legs (the same assets, valued where they landed). The balance gate is then `min over sides of received/given` and Most Lopsided ranks on the biggest *net* gain (received − given). Both reduce exactly to `vmin/vmax` and `vmax − vmin` for a two-team trade. The card prints `given` and `net` per side when there are three.
- **Null `injury_status`** (Sleeper leaves it null for most players) is treated as no status; the first cut's `not (… = 'Sus')` test silently dropped every such player from Tough Break and zeroed their rest-of-season term in trades.
- Busts with no starts take their current roster's franchise for display.

**2026 through Week 9** reproduces every board in the three earlier gut checks (MVP, Breakout, Comeback, Old Man, ROTY, Value Rookie, Waiver, Bust, Rookie Bust, MOTY, MIF, both trade boards under the 1-season horizon). Tough Break: Garrett 164.3 (holdout — add an `exclude` override), Parsons 118.9, Monangai 95.8, Jacobs 94.6 credited to TOR, Bosa 93.3.

**2025 backtest (`compute_superlative_leaders(2025, 14, 8, …)`):**

| Award | Winner | Nominees in top 8 | Result |
|---|---|---|---|
| MVP | Gibbs #4 | CMC #1, Taylor #2, JSN #3, Gibbs #4 (Allen absent: QB VORP) | pass |
| Breakout | JSN #2 | JSN only; Pickens ≈ #9, Franklin lower; Ferguson and McBride excluded by the never-established rule (both had a top-14 TE season) | **winner passes, 3-of-8 fails** — IDP spreads are tighter, so defenders' z-scores dominate; left as specified |
| Waiver | Byron Young #1 | Tuipulotu #2, Brissett #3, Tykee Smith #4 | pass |
| Comeback | CMC #3 | White #1, Prescott #2, CMC #3 | pass |
| Old Man | Stafford #4 | Adams #3, Stafford #4, Kelce #5 | pass |
| ROTY | Egbuka #3 | McMillan #1, Warren #2, Egbuka #3, Dart #4 | pass |
| Value Rookie | Schwesinger #1 | Schwesinger #1, Marks #5, Monangai #6 | pass |
| Tough Break | Nabers #3 | Bosa #1, Nabers #3, Burrow #5; Hampton ≈ #9 | pass |
| MOTY | TBY #1 | TBY, SAR, BKB, PEI all top 5 | pass |
| MIF | SAR #2 | TBY #1, SAR #2, NNY #4, NFD #5 | pass |
| Most Impactful | `1278818557269938176` #5 at horizon 1, #7 at horizon 2 | — | pass at horizon 1 |
| Most Lopsided | `1266941466551275520` (three-team) outside the top 8 at horizon 1, **#4 at horizon 2** | — | pass at horizon 2 |

**`pick_horizon_seasons`, still Zac's call.** The two trade boards disagree: the 1-season horizon (recommended in the Nov 16 log, and the current default) keeps the 2025 Impactful winner in the top 5 but values the three-team Lopsided winner's future firsts too low to surface it; the 2-season horizon (R1 = 244) puts the Lopsided winner 4th but drops the Impactful winner to 7th. The horizon is a parameter of the function and a constant (`PICK_HORIZON_SEASONS`) in the sync step; changing it is one line.

**Performance.** The function reads ~50 MB (players, the baseline table, all of `nfl_stats`) and the instance reads at a few MB/s, so one season takes 60–130 s. Per-statement profiling (`pg_stat_statements.track = all`) showed the plain table scans dominating, not any plan; the obvious fixes (single pass over `nfl_stats`, indexes and `analyze` on temp tables, semi-joins instead of OR'd `exists`) are in. `service_role` now has a 5-minute statement timeout so the sync step's RPC survives. If the Edge Function's 150 s wall clock becomes the limit, precompute the 2021–25 baselines into a real table (they never change) or run the compute over the function's direct `postgres.js` connection.

**Still to apply by hand** (`supabase/migrations/20261116150200_superlatives_grants.sql`): revoke `execute` on the compute function from `anon`/`authenticated`, and drop the stale two-argument overload left behind by an earlier version (callers pass all four arguments until then).

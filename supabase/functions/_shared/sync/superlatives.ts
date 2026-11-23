import { scopeToSeason } from "./scope.ts";
import { type Client, type SyncContext, type SyncResult, emptyResult, errorMessage } from "./types.ts";

// ------------------------------------------------------------
// Recomputes the Superlatives race (SUPERLATIVES.md) for the scoped
// season and writes it to scdfl.superlative_leaders.
//
// The methodology is SQL — scdfl.compute_superlative_leaders(season,
// week, top, pick_horizon), a pure function that returns the rows
// (supabase/migrations/20261116150100_superlatives_compute.sql). This
// step decides `as_of_week`, calls it, and does the writing:
//   1. upsert the new rows, all stamped with one generated_at
//   2. delete the season's rows that still carry an older stamp
// so the table is never empty for the season between the two calls.
//
// as_of_week is the last fully completed regular-season week, capped
// at 14 (§2.2):
//   - Sleeper's state says this season is in its regular season → week − 1
//   - the season is over (post season, or Sleeper has moved on) → 14
//   - preseason → 0: nothing to compute, the season's rows are removed
// Sleeper down → the step is skipped with a warning; last night's rows
// stand.
//
// The first run at Week 14 copies the rows into superlative_leaders_final
// (the ballot nominee list). Delete a season's rows there to re-freeze.
//
// Must run after results/matchups/rosters/transactions/stats/schedule in
// the chain, since the SQL reads all of them.
// ------------------------------------------------------------

const STATE_URL = "https://api.sleeper.app/v1/state/nfl";

/** Knobs passed to the SQL. The pick horizon is the §6 decision still pending (1 recommended). */
const TOP_N = 5;
const PICK_HORIZON_SEASONS = 1;

interface Season {
  year: number;
}

interface NflState {
  season: number;
  week: number;
  seasonType: string;
}

interface LeaderRow {
  award_code: string;
  rank: number;
  player_id: string | null;
  sleeper_id: string | null;
  transaction_id: string | null;
  franchise_abbr: string | null;
  score: number | null;
  headline: string | null;
  detail_lines: string[];
  flags: string[];
  payload: Record<string, unknown>;
}

async function fetchSeasons(supabase: Client): Promise<Season[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("seasons")
    .select("year")
    .order("year", { ascending: true });

  if (error) throw new Error(`Failed to fetch seasons: ${error.message}`);
  return data as Season[];
}

async function fetchNflState(): Promise<NflState | null> {
  try {
    const res = await fetch(STATE_URL);
    if (!res.ok) return null;
    const s = await res.json();
    const season = Number(s.season);
    const week = Number(s.week);
    if (!Number.isFinite(season) || !Number.isFinite(week)) return null;
    return { season, week, seasonType: String(s.season_type ?? "") };
  } catch {
    return null;
  }
}

/** §2.2: the last fully completed regular-season week for `year`, capped at 14. */
export function asOfWeekFor(state: NflState, year: number): number {
  if (year < state.season) return 14;
  if (year > state.season) return 0;
  if (state.seasonType === "pre" || state.seasonType === "off") return 0;
  if (state.seasonType === "post") return 14;
  return Math.min(Math.max(state.week - 1, 0), 14);
}

async function computeLeaders(supabase: Client, year: number, asOfWeek: number): Promise<LeaderRow[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .rpc("compute_superlative_leaders", {
      p_season: year,
      p_as_of_week: asOfWeek,
      p_top: TOP_N,
      p_pick_horizon: PICK_HORIZON_SEASONS,
    });
  if (error) throw new Error(`compute_superlative_leaders failed: ${error.message}`);
  return (data as LeaderRow[] | null) ?? [];
}

async function writeLeaders(supabase: Client, year: number, asOfWeek: number, rows: LeaderRow[]): Promise<void> {
  const stamp = new Date().toISOString();

  if (rows.length > 0) {
    const { error } = await supabase
      .schema("scdfl")
      .from("superlative_leaders")
      .upsert(
        rows.map((r) => ({ season: year, as_of_week: asOfWeek, ...r, generated_at: stamp })),
        { onConflict: "season,award_code,rank" },
      );
    if (error) throw new Error(`Upsert failed: ${error.message}`);
  }

  // Anything for this season not written just now is stale (an award that
  // lost a leader, or the whole season when as_of_week is 0).
  const { error: dErr } = await supabase
    .schema("scdfl")
    .from("superlative_leaders")
    .delete()
    .eq("season", year)
    .lt("generated_at", stamp);
  if (dErr) throw new Error(`Stale-row cleanup failed: ${dErr.message}`);
}

/** Write-once: the ballot nominee list, taken the first time the season is complete. */
async function freezeIfComplete(supabase: Client, year: number, asOfWeek: number): Promise<boolean> {
  if (asOfWeek < 14) return false;

  const { data: existing, error: eErr } = await supabase
    .schema("scdfl")
    .from("superlative_leaders_final")
    .select("rank")
    .eq("season", year)
    .limit(1);
  if (eErr) throw new Error(`Final-table check failed: ${eErr.message}`);
  if ((existing?.length ?? 0) > 0) return false;

  const { data: rows, error: rErr } = await supabase
    .schema("scdfl")
    .from("superlative_leaders")
    .select("*")
    .eq("season", year)
    .limit(200);
  if (rErr) throw new Error(`Reading leaders for the freeze failed: ${rErr.message}`);
  if (!rows || rows.length === 0) return false;

  const { error: iErr } = await supabase
    .schema("scdfl")
    .from("superlative_leaders_final")
    .insert(rows);
  if (iErr) throw new Error(`Freeze failed: ${iErr.message}`);
  return true;
}

export async function syncSuperlatives({ supabase, scope }: SyncContext): Promise<SyncResult> {
  const result = emptyResult();
  const seasons = scopeToSeason(await fetchSeasons(supabase), scope);
  console.log(`Scope: ${scope.label}. ${seasons.length} season(s).`);

  const state = await fetchNflState();
  if (!state) {
    result.warnings.push("Sleeper NFL state unavailable — superlatives not recomputed");
    return result;
  }

  for (const { year } of seasons) {
    const asOfWeek = asOfWeekFor(state, year);
    try {
      console.log(`  ${year}: through Week ${asOfWeek}…`);
      const rows = asOfWeek === 0 ? [] : await computeLeaders(supabase, year, asOfWeek);
      await writeLeaders(supabase, year, asOfWeek, rows);
      const frozen = await freezeIfComplete(supabase, year, asOfWeek);

      const awards = new Set(rows.map((r) => r.award_code));
      const thin = [...awards].filter((a) => rows.filter((r) => r.award_code === a).length < 5);
      if (asOfWeek > 0 && awards.size < 14) {
        result.warnings.push(`${year}: only ${awards.size} of 14 awards produced leaders`);
      }
      if (thin.length) result.warnings.push(`${year}: fewer than five leaders for ${thin.join(", ")}`);
      result.rows += rows.length;
      console.log(`  ✓ ${year}: ${rows.length} leader rows across ${awards.size} awards${frozen ? " — ballot list frozen" : ""}.`);
    } catch (err) {
      console.error(`  ✗ ${year} failed:`, err);
      result.errors.push(`${year}: ${errorMessage(err)}`);
    }
  }

  console.log("\nSuperlatives refresh complete.");
  return result;
}

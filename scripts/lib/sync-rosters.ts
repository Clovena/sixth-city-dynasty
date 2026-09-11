import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
import { resolveSeasonScope } from "./season-scope";

// ------------------------------------------------------------
// Syncs current roster assignments for the most recent season.
// Fetches from the current season's league_id only — does NOT
// iterate all seasons. Runs a full replacement: delete all
// existing rows, then insert fresh from Sleeper.
// Requires scdfl.players to be populated first (sync:players).
//
// Season scoping (--latest / --year / SCDFL_SEASON) is accepted so
// this script can sit in a scoped chain, but it only ever targets the
// current season: rosters is a snapshot table with no year column, so
// a full replace scoped to an older season would overwrite the live
// rosters with stale ones. A scope naming any other year is skipped.
// ------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Types ---

interface Season {
  year: number;
  league_id: string;
}

interface SleeperRosterRaw {
  roster_id: number;
  players: string[] | null;
}

interface RosterRow {
  player_id: string;
  sleeper_id: number;
}

// --- Fetchers ---

async function fetchCurrentSeason(): Promise<Season> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("seasons")
    .select("year, league_id")
    .order("year", { ascending: false })
    .limit(1)
    .single();

  if (error) throw new Error(`Failed to fetch current season: ${error.message}`);
  return data as Season;
}

async function fetchRosters(leagueId: string): Promise<SleeperRosterRaw[]> {
  const url = `https://api.sleeper.app/v1/league/${leagueId}/rosters`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API error: ${res.status}`);
  return res.json();
}

// --- Transform ---

function flattenRosters(rosters: SleeperRosterRaw[]): RosterRow[] {
  const rows: RosterRow[] = [];

  for (const roster of rosters) {
    if (!roster.players || roster.players.length === 0) continue;
    for (const player_id of roster.players) {
      rows.push({
        player_id,
        sleeper_id: roster.roster_id,
      });
    }
  }

  return rows;
}

// --- Write ---

async function replaceRosters(rows: RosterRow[]): Promise<void> {
  // Full replacement — delete all existing rows first
  const { error: deleteError } = await supabase
    .schema("scdfl")
    .from("rosters")
    .delete()
    .neq("player_id", "");

  if (deleteError) throw new Error(`Delete failed: ${deleteError.message}`);

  const { error: insertError } = await supabase
    .schema("scdfl")
    .from("rosters")
    .insert(rows);

  if (insertError) throw new Error(`Insert failed: ${insertError.message}`);
}

// --- Main ---

async function main() {
  const scope = await resolveSeasonScope(supabase);
  const season = await fetchCurrentSeason();

  if (scope.year !== null && scope.year !== season.year) {
    console.log(
      `Scope is ${scope.label}, but rosters only tracks the current season ` +
        `(${season.year}) — skipping.`
    );
    return;
  }

  console.log(`Syncing rosters for ${season.year} (league ${season.league_id})...`);

  const raw = await fetchRosters(season.league_id);
  const rows = flattenRosters(raw);

  console.log(`  ${raw.length} rosters → ${rows.length} player assignments.`);

  await replaceRosters(rows);
  console.log(`  ✓ Rosters replaced successfully.`);
}

main();
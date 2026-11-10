import { type Client, type SyncContext, type SyncResult, emptyResult } from "./types.ts";

// ------------------------------------------------------------
// Syncs current roster assignments for the most recent season.
// Fetches from the current season's league_id only — does NOT
// iterate all seasons. Runs a full replacement through the
// scdfl.replace_rosters(jsonb) SQL function, which deletes and
// re-inserts in ONE transaction: if anything fails, the previous
// snapshot survives instead of the table being left empty.
//
// rosters.player_id has an FK to scdfl.players. A player Sleeper
// knows about but scdfl.players doesn't yet (a fresh pickup since
// the last sync:players) is skipped by replace_rosters and reported
// back as a warning, rather than failing the whole replace.
//
// The season scope is accepted so this sync can sit in a scoped
// chain, but it only ever targets the current season: rosters is a
// snapshot table with no year column, so a full replace scoped to an
// older season would overwrite the live rosters with stale ones. A
// scope naming any other year is skipped.
// ------------------------------------------------------------

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

interface ReplaceRostersResult {
  inserted: number;
  skipped: string[];
}

// --- Fetchers ---

async function fetchCurrentSeason(supabase: Client): Promise<Season> {
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

async function replaceRosters(supabase: Client, rows: RosterRow[]): Promise<ReplaceRostersResult> {
  const { data, error } = await supabase
    .schema("scdfl")
    .rpc("replace_rosters", { p_rows: rows });

  if (error) throw new Error(`replace_rosters failed: ${error.message}`);
  return data as ReplaceRostersResult;
}

// --- Entry ---

export async function syncRosters({ supabase, scope }: SyncContext): Promise<SyncResult> {
  const result = emptyResult();
  const season = await fetchCurrentSeason(supabase);

  if (scope.year !== null && scope.year !== season.year) {
    console.log(
      `Scope is ${scope.label}, but rosters only tracks the current season ` +
        `(${season.year}) — skipping.`
    );
    return result;
  }

  console.log(`Syncing rosters for ${season.year} (league ${season.league_id})...`);

  const raw = await fetchRosters(season.league_id);
  const rows = flattenRosters(raw);

  console.log(`  ${raw.length} rosters → ${rows.length} player assignments.`);

  const { inserted, skipped } = await replaceRosters(supabase, rows);
  result.rows = inserted;
  console.log(`  ✓ Rosters replaced — ${inserted} rows.`);

  if (skipped.length > 0) {
    const msg =
      `${skipped.length} rostered player(s) missing from scdfl.players, left off ` +
      `rosters until the next sync:players: ${skipped.join(", ")}`;
    console.warn(`  ! ${msg}`);
    result.warnings.push(msg);
  }

  return result;
}

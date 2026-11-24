import { scopeToSeason } from "./scope.ts";
import { type Client, type SyncContext, type SyncResult, emptyResult, errorMessage } from "./types.ts";

// ------------------------------------------------------------
// Syncs the NFL schedule into scdfl.nfl_schedule (SUPERLATIVES.md B7).
// Source: nflverse nfldata games.csv — one row per game, all seasons
// since 1999, ~2 MB. Only the seasons in scdfl.seasons are kept.
//
// Used by the superlatives refresh to know which weeks each NFL team
// played: a player's bye (for start rate) and the games he missed
// (for Tough Break). nfl_stats has no team column and players.team
// is only the current team, so neither can answer that on its own.
//
// Team codes are normalised to Sleeper's: nflverse writes the Rams
// as LA; every other code already matches.
//
// PK: game_id — upsert safe for re-runs.
// ------------------------------------------------------------

const GAMES_URL = "https://github.com/nflverse/nfldata/raw/master/data/games.csv";

const UPSERT_BATCH_SIZE = 500;

const TEAM_CODE: Record<string, string> = { LA: "LAR" };

interface Season {
  year: number;
}

interface ScheduleRow {
  game_id: string;
  season: number;
  week: number;
  game_type: string;
  gameday: string | null;
  home_team: string;
  away_team: string;
}

// games.csv has no quoted fields that matter to us (stadium names can
// carry commas, but they sit after every column we read), so a plain
// split is enough — but guard the row width anyway.
function parseSchedule(csv: string, seasons: Set<number>): ScheduleRow[] {
  const lines = csv.split(/\r?\n/);
  const headers = lines[0].split(",");
  const idx = (name: string) => headers.indexOf(name);
  const col = {
    game_id: idx("game_id"),
    season: idx("season"),
    game_type: idx("game_type"),
    week: idx("week"),
    gameday: idx("gameday"),
    away_team: idx("away_team"),
    home_team: idx("home_team"),
  };
  if (Object.values(col).some((i) => i < 0)) {
    throw new Error("games.csv is missing an expected column");
  }

  const rows: ScheduleRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(",");
    const season = parseInt(c[col.season], 10);
    if (!seasons.has(season)) continue;
    const week = parseInt(c[col.week], 10);
    if (isNaN(week)) continue;
    const home = c[col.home_team];
    const away = c[col.away_team];
    if (!home || !away) continue;
    rows.push({
      game_id: c[col.game_id],
      season,
      week,
      game_type: c[col.game_type],
      gameday: c[col.gameday] || null,
      home_team: TEAM_CODE[home] ?? home,
      away_team: TEAM_CODE[away] ?? away,
    });
  }
  return rows;
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

async function upsertSchedule(supabase: Client, rows: ScheduleRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .schema("scdfl")
      .from("nfl_schedule")
      .upsert(batch, { onConflict: "game_id" });

    if (error) throw new Error(`Upsert failed at batch ${i}: ${error.message}`);
  }
}

export async function syncSchedule({ supabase, scope }: SyncContext): Promise<SyncResult> {
  const result = emptyResult();
  const seasons = scopeToSeason(await fetchSeasons(supabase), scope);
  const wanted = new Set(seasons.map((s) => s.year));
  console.log(`Scope: ${scope.label}. Seasons: ${[...wanted].join(", ")}.`);

  try {
    const res = await fetch(GAMES_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`games.csv returned HTTP ${res.status}`);
    const csv = await res.text();
    if (!csv.startsWith("game_id")) throw new Error("games.csv did not look like the schedule file");

    const rows = parseSchedule(csv, wanted);
    console.log(`  Parsed ${rows.length} games.`);
    await upsertSchedule(supabase, rows);
    result.rows = rows.length;
    console.log("  ✓ nfl_schedule upserted.");
  } catch (err) {
    console.error("  ✗ Schedule sync failed:", err);
    result.errors.push(errorMessage(err));
  }

  console.log("\nNFL schedule sync complete.");
  return result;
}

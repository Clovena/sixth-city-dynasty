import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Types ---

interface SleeperRosterSettings {
  wins: number;
  losses: number;
  ties: number;
  fpts: number;
  fpts_decimal: number;
  fpts_against: number;
  fpts_against_decimal: number;
}

interface SleeperRoster {
  roster_id: number;
  settings: SleeperRosterSettings;
}

interface Season {
  year: number;
  league_id: string;
}

interface ResultRow {
  sleeper_id: string;
  year: number;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
  points_against: number;
}

// --- Helpers ---

function combinePoints(whole: number, decimal: number): number {
  return parseFloat(`${whole}.${String(decimal).padStart(2, "0")}`);
}

async function fetchSeasons(): Promise<Season[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("seasons")
    .select("year, league_id")
    .order("year", { ascending: true });

  if (error) throw new Error(`Failed to fetch seasons: ${error.message}`);
  return data as Season[];
}

async function fetchRosters(leagueId: string): Promise<SleeperRoster[]> {
  const url = `https://api.sleeper.app/v1/league/${leagueId}/rosters`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API error for league ${leagueId}: ${res.status}`);
  return res.json();
}

function shapeResults(rosters: SleeperRoster[], year: number): ResultRow[] {
  return rosters.map((roster) => ({
    sleeper_id: String(roster.roster_id),
    year,
    wins: roster.settings.wins,
    losses: roster.settings.losses,
    ties: roster.settings.ties,
    points_for: combinePoints(roster.settings.fpts, roster.settings.fpts_decimal),
    points_against: combinePoints(roster.settings.fpts_against, roster.settings.fpts_against_decimal),
  }));
}

async function upsertResults(rows: ResultRow[]): Promise<void> {
  const { error } = await supabase
    .schema("scdfl")
    .from("results")
    .upsert(rows, { onConflict: "sleeper_id,year" });

  if (error) throw new Error(`Upsert failed: ${error.message}`);
}

// --- Main ---

async function main() {
  const seasons = await fetchSeasons();
  console.log(`Found ${seasons.length} seasons to sync.`);

  for (const season of seasons) {
    try {
      console.log(`\nSyncing ${season.year} (league ${season.league_id})...`);
      const rosters = await fetchRosters(season.league_id);
      const rows = shapeResults(rosters, season.year);
      await upsertResults(rows);
      console.log(`  ✓ Upserted ${rows.length} rows for ${season.year}.`);
    } catch (err) {
      console.error(`  ✗ Error syncing ${season.year}:`, err);
    }
  }

  console.log("\nSync complete.");
}

main();
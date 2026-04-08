import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

// ------------------------------------------------------------
// Syncs exhibition matchup results into scdfl.exhibition_matchups.
// Config (league_id, week, team_ids) lives in scdfl.exhibitions
// and is manually maintained. This script fetches results only.
//
// Filtering: the exhibition league endpoint returns all roster
// slots in that league, most of which are empty placeholders.
// Only the two roster_ids matching team_id_a and team_id_b are
// retained — all others are discarded.
//
// Upserts on exhibition_id (one-to-one with exhibitions).
// ------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Types ---

interface Exhibition {
  id: number;
  year: number;
  week: number;
  league_id: string;
  team_id_a: number;
  team_id_b: number;
}

interface SleeperMatchupRaw {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  custom_points: number | null;
  starters: string[];
  starters_points: number[];
}

interface ExhibitionMatchupRow {
  exhibition_id: number;
  score_a: number | null;
  score_b: number | null;
  starters_a: string[];
  starter_points_a: number[];
  starters_b: string[];
  starter_points_b: number[];
}

// --- Fetchers ---

async function fetchExhibitions(): Promise<Exhibition[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("exhibitions")
    .select("id, year, week, league_id, team_id_a, team_id_b")
    .order("year", { ascending: true });

  if (error) throw new Error(`Failed to fetch exhibitions: ${error.message}`);
  return data as Exhibition[];
}

async function fetchMatchups(
  leagueId: string,
  week: number
): Promise<SleeperMatchupRaw[]> {
  const url = `https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API error: ${res.status} for ${url}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return [];
  return data as SleeperMatchupRaw[];
}

// --- Transform ---

function resolveScore(raw: SleeperMatchupRaw): number | null {
  if (raw.custom_points !== null && raw.custom_points !== undefined) {
    return raw.custom_points;
  }
  if (raw.points === 0 && (!raw.starters || raw.starters.length === 0)) {
    return null;
  }
  return raw.points;
}

function shapeMatchup(
  exhibition: Exhibition,
  raws: SleeperMatchupRaw[]
): ExhibitionMatchupRow | null {
  // Filter to only the two roster_ids we care about
  const teamA = raws.find((r) => r.roster_id === exhibition.team_id_a);
  const teamB = raws.find((r) => r.roster_id === exhibition.team_id_b);

  if (!teamA || !teamB) {
    console.warn(
      `  Warning: could not find both team rosters in league ${exhibition.league_id} ` +
      `week ${exhibition.week} (looking for roster_ids ${exhibition.team_id_a} and ${exhibition.team_id_b})`
    );
    return null;
  }

  return {
    exhibition_id: exhibition.id,
    score_a: resolveScore(teamA),
    score_b: resolveScore(teamB),
    starters_a: teamA.starters ?? [],
    starter_points_a: teamA.starters_points ?? [],
    starters_b: teamB.starters ?? [],
    starter_points_b: teamB.starters_points ?? [],
  };
}

// --- Write ---

async function upsertExhibitionMatchup(row: ExhibitionMatchupRow): Promise<void> {
  const { error } = await supabase
    .schema("scdfl")
    .from("exhibition_matchups")
    .upsert(row, { onConflict: "exhibition_id" });

  if (error) throw new Error(`Upsert failed for exhibition_id ${row.exhibition_id}: ${error.message}`);
}

// --- Main ---

async function main() {
  const exhibitions = await fetchExhibitions();
  console.log(`Found ${exhibitions.length} exhibitions to sync.`);

  for (const exhibition of exhibitions) {
    console.log(
      `\n  Syncing ${exhibition.year} week ${exhibition.week} ` +
      `(league ${exhibition.league_id}, roster_ids ${exhibition.team_id_a} vs ${exhibition.team_id_b})...`
    );

    try {
      const raws = await fetchMatchups(exhibition.league_id, exhibition.week);

      if (raws.length === 0) {
        console.log(`  No data returned — game may not have been played yet.`);
        continue;
      }

      const row = shapeMatchup(exhibition, raws);
      if (!row) continue;

      await upsertExhibitionMatchup(row);
      console.log(
        `  ✓ Upserted — score: ${row.score_a ?? "TBD"} vs ${row.score_b ?? "TBD"}`
      );
    } catch (err) {
      console.error(`  ✗ Error:`, err);
    }
  }

  console.log("\nExhibition sync complete.");
}

main();
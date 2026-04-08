import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const WEEKS_TO_FETCH = 17;

// --- Types ---

interface Season {
  year: number;
  league_id: string;
  regular_season_weeks: number;
  playoff_teams: number;
}

interface SeasonResult {
  sleeper_id: string;
  seed: number | null;
}

interface SleeperMatchupRaw {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  custom_points: number | null;
  starters: string[];
  starters_points: number[];
}

interface MatchupRow {
  year: number;
  week: number;
  matchup_id: number;
  game_type: number;
  roster_id_a: number;
  roster_id_b: number;
  score_a: number | null;
  score_b: number | null;
  starters_a: string[];
  starter_points_a: number[];
  starters_b: string[];
  starter_points_b: number[];
}

// --- Fetchers ---

async function fetchSeasons(): Promise<Season[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("seasons")
    .select("year, league_id, regular_season_weeks, playoff_teams")
    .order("year", { ascending: true });

  if (error) throw new Error(`Failed to fetch seasons: ${error.message}`);
  return data as Season[];
}

async function fetchSeasonResults(year: number): Promise<SeasonResult[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("results")
    .select("sleeper_id, seed")
    .eq("year", year);

  if (error) throw new Error(`Failed to fetch results for ${year}: ${error.message}`);
  return data as SeasonResult[];
}

async function fetchWeekMatchups(
  leagueId: string,
  week: number
): Promise<SleeperMatchupRaw[]> {
  const url = `https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API error: ${res.status} for ${url}`);
  const data = await res.json();
  // Sleeper returns [] for future/unplayed weeks — treat as empty
  if (!Array.isArray(data) || data.length === 0) return [];
  return data as SleeperMatchupRaw[];
}

// --- Transformation ---

function resolveScore(raw: SleeperMatchupRaw): number | null {
  if (raw.custom_points !== null && raw.custom_points !== undefined) {
    return raw.custom_points;
  }
  // Sleeper returns 0 for unplayed games — treat as null if no starters set
  if (raw.points === 0 && (!raw.starters || raw.starters.length === 0)) {
    return null;
  }
  return raw.points;
}

function pairMatchups(
  raws: SleeperMatchupRaw[],
  year: number,
  week: number,
  gameType: number
): MatchupRow[] {
  const grouped = new Map<number, SleeperMatchupRaw[]>();

  for (const raw of raws) {
    if (raw.matchup_id === null) continue; // bye week slot — skip
    if (!grouped.has(raw.matchup_id)) grouped.set(raw.matchup_id, []);
    grouped.get(raw.matchup_id)!.push(raw);
  }

  const rows: MatchupRow[] = [];

  for (const [matchupId, pair] of grouped.entries()) {
    if (pair.length !== 2) continue; // malformed — skip

    // Stable _a/_b assignment: lower roster_id is always _a
    pair.sort((a, b) => a.roster_id - b.roster_id);
    const [a, b] = pair;

    rows.push({
      year,
      week,
      matchup_id: matchupId,
      game_type: gameType,
      roster_id_a: a.roster_id,
      roster_id_b: b.roster_id,
      score_a: resolveScore(a),
      score_b: resolveScore(b),
      starters_a: a.starters ?? [],
      starter_points_a: a.starters_points ?? [],
      starters_b: b.starters ?? [],
      starter_points_b: b.starters_points ?? [],
    });
  }

  return rows;
}

function classifyPlayoffWeek(
  raws: SleeperMatchupRaw[],
  year: number,
  week: number,
  winnersAlive: Set<number>
): { rows: MatchupRow[]; updatedWinnersAlive: Set<number> } {
  const grouped = new Map<number, SleeperMatchupRaw[]>();

  for (const raw of raws) {
    if (raw.matchup_id === null) continue;
    if (!grouped.has(raw.matchup_id)) grouped.set(raw.matchup_id, []);
    grouped.get(raw.matchup_id)!.push(raw);
  }

  const rows: MatchupRow[] = [];
  const updated = new Set(winnersAlive);

  for (const [matchupId, pair] of grouped.entries()) {
    if (pair.length !== 2) continue;

    pair.sort((a, b) => a.roster_id - b.roster_id);
    const [a, b] = pair;

    const bothInWinners =
      winnersAlive.has(a.roster_id) && winnersAlive.has(b.roster_id);
    const gameType = bothInWinners ? 1 : -1;

    const scoreA = resolveScore(a);
    const scoreB = resolveScore(b);

    // If game is complete and in winners bracket, eliminate the loser
    if (bothInWinners && scoreA !== null && scoreB !== null) {
      if (scoreA > scoreB) updated.delete(b.roster_id);
      else if (scoreB > scoreA) updated.delete(a.roster_id);
      // exact tie: leave both alive — will resolve on re-sync
    }

    rows.push({
      year,
      week,
      matchup_id: matchupId,
      game_type: gameType,
      roster_id_a: a.roster_id,
      roster_id_b: b.roster_id,
      score_a: scoreA,
      score_b: scoreB,
      starters_a: a.starters ?? [],
      starter_points_a: a.starters_points ?? [],
      starters_b: b.starters ?? [],
      starter_points_b: b.starters_points ?? [],
    });
  }

  return { rows, updatedWinnersAlive: updated };
}

async function upsertMatchups(rows: MatchupRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase
    .schema("scdfl")
    .from("matchups")
    .upsert(rows, { onConflict: "year,week,matchup_id" });

  if (error) throw new Error(`Upsert failed: ${error.message}`);
}

// --- Main ---

async function syncSeason(season: Season): Promise<void> {
  console.log(`\nSyncing ${season.year} (league ${season.league_id})...`);

  // Fetch seeds for playoff classification
  const seasonResults = await fetchSeasonResults(season.year);
  const seedMap = new Map<number, number | null>(
    seasonResults.map((r) => [parseInt(r.sleeper_id), r.seed])
  );

  // Initialize winners bracket: all roster_ids with seed <= playoff_teams
  let winnersAlive = new Set<number>(
    [...seedMap.entries()]
      .filter(([, seed]) => seed !== null && seed <= season.playoff_teams)
      .map(([rosterId]) => rosterId)
  );

  let totalUpserted = 0;

  for (let week = 1; week <= WEEKS_TO_FETCH; week++) {
    const raws = await fetchWeekMatchups(season.league_id, week);
    if (raws.length === 0) {
      console.log(`  Week ${week}: no data, skipping.`);
      continue;
    }

    let rows: MatchupRow[];

    if (week <= season.regular_season_weeks) {
      // Regular season — all games are game_type 0
      rows = pairMatchups(raws, season.year, week, 0);
    } else {
      // Playoff weeks — classify winners bracket vs consolation
      const result = classifyPlayoffWeek(raws, season.year, week, winnersAlive);
      rows = result.rows;
      winnersAlive = result.updatedWinnersAlive;
    }

    await upsertMatchups(rows);
    totalUpserted += rows.length;
    console.log(`  Week ${week}: upserted ${rows.length} matchups.`);
  }

  console.log(`  ✓ ${season.year} complete — ${totalUpserted} total matchups.`);
}

async function main() {
  const seasons = await fetchSeasons();
  console.log(`Found ${seasons.length} seasons to sync.`);

  for (const season of seasons) {
    try {
      await syncSeason(season);
    } catch (err) {
      console.error(`  ✗ Error syncing ${season.year}:`, err);
    }
  }

  console.log("\nSync complete.");
}

main();
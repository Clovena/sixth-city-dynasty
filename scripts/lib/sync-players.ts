import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// ------------------------------------------------------------
// NOTE: The Sleeper /players/nfl endpoint is a ~5MB payload.
// Sleeper requests this be called no more than once per day.
// Do NOT include this script in routine sync pipelines.
// Run manually: npm run sync:players
// ------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
const UPSERT_BATCH_SIZE = 500;

// --- Types ---

interface SleeperPlayer {
  player_id: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  fantasy_positions: string[] | null;
  team: string | null;
  status: string | null;
  age: number | null;
  years_exp: number | null;
  number: number | null;
  height: string | null;
  weight: string | null;
  college: string | null;
  birth_country: string | null;
  depth_chart_order: number | null;
  depth_chart_position: number | null;
  injury_status: string | null;
  injury_start_date: string | null;
  practice_participation: string | null;
  hashtag: string | null;
  search_first_name: string | null;
  search_last_name: string | null;
  search_full_name: string | null;
  search_rank: number | null;
  sport: string | null;
  sportradar_id: string | null;
  fantasy_data_id: number | null;
  espn_id: string | null;
  stats_id: string | null;
  rotowire_id: number | null;
  rotoworld_id: number | null;
  yahoo_id: number | null;
}

// --- Fetch ---

async function fetchAllPlayers(): Promise<SleeperPlayer[]> {
  console.log("Fetching players from Sleeper API...");
  const res = await fetch(SLEEPER_PLAYERS_URL);
  if (!res.ok) throw new Error(`Sleeper API error: ${res.status}`);

  const raw: Record<string, Omit<SleeperPlayer, "player_id">> = await res.json();

  // Squash the top-level key (player_id) into each object as a field
  return Object.entries(raw).map(([player_id, data]) => ({
    player_id,
    first_name: data.first_name ?? null,
    last_name: data.last_name ?? null,
    position: data.position ?? null,
    fantasy_positions: data.fantasy_positions ?? null,
    team: data.team ?? null,
    status: data.status ?? null,
    age: data.age ?? null,
    years_exp: data.years_exp ?? null,
    number: data.number ?? null,
    height: data.height ?? null,
    weight: data.weight ?? null,
    college: data.college ?? null,
    birth_country: data.birth_country ?? null,
    depth_chart_order: data.depth_chart_order ?? null,
    depth_chart_position: data.depth_chart_position ?? null,
    injury_status: data.injury_status ?? null,
    injury_start_date: data.injury_start_date ?? null,
    practice_participation: data.practice_participation ?? null,
    hashtag: data.hashtag ?? null,
    search_first_name: data.search_first_name ?? null,
    search_last_name: data.search_last_name ?? null,
    search_full_name: data.search_full_name ?? null,
    search_rank: data.search_rank ?? null,
    sport: data.sport ?? null,
    sportradar_id: data.sportradar_id ?? null,
    fantasy_data_id: data.fantasy_data_id ?? null,
    espn_id: data.espn_id ?? null,
    stats_id: data.stats_id ?? null,
    rotowire_id: data.rotowire_id ?? null,
    rotoworld_id: data.rotoworld_id ?? null,
    yahoo_id: data.yahoo_id ?? null,
  }));
}

// --- Upsert in batches ---

async function upsertPlayers(players: SleeperPlayer[]): Promise<void> {
  console.log(`Upserting ${players.length} players in batches of ${UPSERT_BATCH_SIZE}...`);

  for (let i = 0; i < players.length; i += UPSERT_BATCH_SIZE) {
    const batch = players.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .schema("scdfl")
      .from("players")
      .upsert(batch, { onConflict: "player_id" });

    if (error) throw new Error(`Upsert failed at batch ${i}: ${error.message}`);

    const end = Math.min(i + UPSERT_BATCH_SIZE, players.length);
    console.log(`  ✓ Rows ${i + 1}–${end} upserted.`);
  }
}

// --- Main ---

async function main() {
  const players = await fetchAllPlayers();
  console.log(`Fetched ${players.length} players.`);
  await upsertPlayers(players);
  console.log("\nPlayers sync complete.");
}

main();
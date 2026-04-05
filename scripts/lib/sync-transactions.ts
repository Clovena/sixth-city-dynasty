import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

// ------------------------------------------------------------
// Syncs all transactions for all seasons into scdfl.transactions.
// One row per asset movement per team side — trades are exploded
// into multiple rows grouped by transaction_id.
// Upserts on the natural key: (transaction_id, roster_id, action,
// asset, player_id, pick_season, pick_round, pick_original_roster_id).
// Commissioner reversals appear as new transactions with new IDs —
// they do not modify existing rows, so upsert is safe here.
// ------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const WEEKS_TO_FETCH = 17;

// --- Types ---

interface Season {
  year: number;
  league_id: string;
}

interface SleeperDraftPick {
  season: string;
  round: number;
  roster_id: number;         // original slot owner
  previous_owner_id: number; // sender in this transaction
  owner_id: number;          // receiver in this transaction
}

interface SleeperTransaction {
  transaction_id: string;
  type: "trade" | "waiver" | "free_agent" | "commissioner";
  status: "complete" | "failed";
  leg: number;
  created: number;
  roster_ids: number[];
  adds: Record<string, number> | null;   // { player_id: roster_id }
  drops: Record<string, number> | null;  // { player_id: roster_id }
  draft_picks: SleeperDraftPick[];
  settings: { waiver_bid?: number } | null;
}

interface TransactionRow {
  transaction_id: string;
  year: number;
  week: number;
  type: string;
  status: string;
  roster_id: number;
  action: "add" | "drop";
  asset: "player" | "pick";
  player_id: string | null;
  pick_season: number | null;
  pick_round: number | null;
  pick_original_roster_id: number | null;
  waiver_bid: number | null;
  created: number;
}

// --- Fetchers ---

async function fetchSeasons(): Promise<Season[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("seasons")
    .select("year, league_id")
    .order("year", { ascending: true });

  if (error) throw new Error(`Failed to fetch seasons: ${error.message}`);
  return data as Season[];
}

async function fetchWeekTransactions(
  leagueId: string,
  week: number
): Promise<SleeperTransaction[]> {
  const url = `https://api.sleeper.app/v1/league/${leagueId}/transactions/${week}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API error: ${res.status} for ${url}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return [];
  return data as SleeperTransaction[];
}

// --- Transform ---

function explodeTransaction(
  tx: SleeperTransaction,
  year: number
): TransactionRow[] {
  const rows: TransactionRow[] = [];
  const waiver_bid = tx.settings?.waiver_bid ?? null;
  const base = {
    transaction_id: tx.transaction_id,
    year,
    week: tx.leg,
    type: tx.type,
    status: tx.status,
    created: tx.created,
    waiver_bid: tx.type === "waiver" ? waiver_bid : null,
  };

  // Initialize a ledger for every roster_id involved in this transaction.
  // This is critical for trades where one side only moves picks (adds/drops
  // will be null for that side) — we must not miss those roster_ids.
  const ledger = new Map<number, { adds: TransactionRow[]; drops: TransactionRow[] }>();
  for (const roster_id of tx.roster_ids) {
    ledger.set(roster_id, { adds: [], drops: [] });
  }

  // --- Player adds ---
  if (tx.adds) {
    for (const [player_id, roster_id] of Object.entries(tx.adds)) {
      ledger.get(roster_id)?.adds.push({
        ...base,
        roster_id,
        action: "add",
        asset: "player",
        player_id,
        pick_season: null,
        pick_round: null,
        pick_original_roster_id: null,
      });
    }
  }

  // --- Player drops ---
  if (tx.drops) {
    for (const [player_id, roster_id] of Object.entries(tx.drops)) {
      ledger.get(roster_id)?.drops.push({
        ...base,
        roster_id,
        action: "drop",
        asset: "player",
        player_id,
        pick_season: null,
        pick_round: null,
        pick_original_roster_id: null,
      });
    }
  }

  // --- Pick movements ---
  // Each draft_pick object encodes a transfer: previous_owner_id drops,
  // owner_id adds. roster_id is the original slot owner (for identification).
  for (const pick of tx.draft_picks ?? []) {
    const pickBase = {
      ...base,
      asset: "pick" as const,
      player_id: null,
      pick_season: parseInt(pick.season),
      pick_round: pick.round,
      pick_original_roster_id: pick.roster_id,
    };

    ledger.get(pick.previous_owner_id)?.drops.push({
      ...pickBase,
      roster_id: pick.previous_owner_id,
      action: "drop",
    });

    ledger.get(pick.owner_id)?.adds.push({
      ...pickBase,
      roster_id: pick.owner_id,
      action: "add",
    });
  }

  // Flatten ledger into rows — adds before drops for readability
  for (const { adds, drops } of ledger.values()) {
    rows.push(...adds, ...drops);
  }

  return rows;
}

// --- Write ---

const UPSERT_BATCH_SIZE = 500;

async function upsertTransactions(rows: TransactionRow[]): Promise<void> {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .schema("scdfl")
      .from("transactions")
      .upsert(batch, {
        onConflict:
          "transaction_id,roster_id,action,asset,player_id,pick_season,pick_round,pick_original_roster_id",
        ignoreDuplicates: true,
      });

    if (error) throw new Error(`Upsert failed at batch ${i}: ${error.message}`);
  }
}

// --- Main ---

async function syncSeason(season: Season): Promise<void> {
  console.log(`\nSyncing transactions for ${season.year} (league ${season.league_id})...`);

  const allRows: TransactionRow[] = [];

  for (let week = 1; week <= WEEKS_TO_FETCH; week++) {
    const txs = await fetchWeekTransactions(season.league_id, week);
    if (txs.length === 0) continue;

    for (const tx of txs) {
      const rows = explodeTransaction(tx, season.year);
      allRows.push(...rows);
    }

    console.log(`  Week ${week}: ${txs.length} transactions → ${allRows.length} rows so far.`);
  }

  await upsertTransactions(allRows);
  console.log(`  ✓ ${season.year} complete — ${allRows.length} total rows upserted.`);
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

  console.log("\nTransactions sync complete.");
}

main();
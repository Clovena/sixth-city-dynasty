import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

// ------------------------------------------------------------
// Syncs all draft picks into scdfl.draft_results.
// Iterates draft_ids from scdfl.drafts (manually maintained).
// For each draft, fetches slot_to_roster_id from the draft
// metadata endpoint to resolve original_roster_id per slot,
// then fetches all picks from the picks endpoint.
// Upserts on (draft_id, pick_no).
// ------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Types ---

interface Draft {
  draft_id: string;
  year: number;
  type: string;
}

interface SleeperDraftMetadata {
  slot_to_roster_id: Record<string, number>; // { "1": roster_id, "2": roster_id, ... }
}

interface SleeperDraftPick {
  draft_id: string;
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number;
  player_id: string;
}

interface DraftResultRow {
  draft_id: string;
  pick_no: number;
  round: number;
  draft_slot: number;
  roster_id: number;
  original_roster_id: number;
  player_id: string;
}

// --- Fetchers ---

async function fetchDrafts(): Promise<Draft[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("drafts")
    .select("draft_id, year, type")
    .order("year", { ascending: true });

  if (error) throw new Error(`Failed to fetch drafts: ${error.message}`);
  return data as Draft[];
}

async function fetchDraftMetadata(draftId: string): Promise<SleeperDraftMetadata> {
  const url = `https://api.sleeper.app/v1/draft/${draftId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API error: ${res.status} for ${url}`);
  return res.json();
}

async function fetchDraftPicks(draftId: string): Promise<SleeperDraftPick[]> {
  const url = `https://api.sleeper.app/v1/draft/${draftId}/picks`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper API error: ${res.status} for ${url}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return [];
  return data as SleeperDraftPick[];
}

// --- Transform ---

function shapePicks(
  picks: SleeperDraftPick[],
  slotToRosterId: Record<string, number>
): DraftResultRow[] {
  const rows: DraftResultRow[] = [];

  for (const pick of picks) {
    // Skip any pick without a player — can occur if draft is in progress
    if (!pick.player_id) continue;

    const original_roster_id = slotToRosterId[String(pick.draft_slot)];
    if (original_roster_id === undefined) {
      console.warn(
        `  Warning: no slot_to_roster_id mapping for draft_slot ${pick.draft_slot} in draft ${pick.draft_id}`
      );
      continue;
    }

    rows.push({
      draft_id: pick.draft_id,
      pick_no: pick.pick_no,
      round: pick.round,
      draft_slot: pick.draft_slot,
      roster_id: Number(pick.roster_id),
      original_roster_id,
      player_id: pick.player_id,
    });
  }

  return rows;
}

// --- Write ---

async function upsertDraftResults(rows: DraftResultRow[]): Promise<void> {
  if (rows.length === 0) return;

  const { error } = await supabase
    .schema("scdfl")
    .from("draft_results")
    .upsert(rows, { onConflict: "draft_id,pick_no" });

  if (error) throw new Error(`Upsert failed: ${error.message}`);
}

// --- Main ---

async function syncDraft(draft: Draft): Promise<void> {
  console.log(`\n  Syncing ${draft.year} ${draft.type} draft (${draft.draft_id})...`);

  const metadata = await fetchDraftMetadata(draft.draft_id);
  const slotToRosterId = metadata.slot_to_roster_id;

  if (!slotToRosterId || Object.keys(slotToRosterId).length === 0) {
    console.warn(`  Warning: no slot_to_roster_id found for draft ${draft.draft_id} — skipping.`);
    return;
  }

  const picks = await fetchDraftPicks(draft.draft_id);
  if (picks.length === 0) {
    console.log(`  No picks found — draft may not have started yet.`);
    return;
  }

  const rows = shapePicks(picks, slotToRosterId);
  await upsertDraftResults(rows);

  console.log(`  ✓ ${rows.length} picks upserted.`);
}

async function main() {
  const drafts = await fetchDrafts();
  console.log(`Found ${drafts.length} drafts to sync.`);

  for (const draft of drafts) {
    try {
      await syncDraft(draft);
    } catch (err) {
      console.error(`  ✗ Error syncing draft ${draft.draft_id}:`, err);
    }
  }

  console.log("\nDraft results sync complete.");
}

main();
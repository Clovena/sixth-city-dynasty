import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

// ------------------------------------------------------------
// Syncs the DynastyProcess player ID crosswalk into scdfl.player_ids.
// Source: https://github.com/dynastyprocess/data
// Primary purpose: supplement ESPN IDs missing from Sleeper's
// /players/nfl endpoint, enabling ESPN CDN headshot URLs.
// Also captures platform IDs (MFL, FantasyPros, PFF, etc.)
// not available from Sleeper.
//
// Keyed on sleeper_id — only rows where sleeper_id exists in
// scdfl.players are upserted (FK enforced).
//
// Run cadence: same as sync:players — sparingly, a few times
// per season. Always run sync:players first.
// ------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const DYNASTYPROCESS_URL =
  "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv";

const UPSERT_BATCH_SIZE = 500;

// --- Types ---

interface PlayerIdRow {
  sleeper_id: string;
  gsis_id: string | null;
  espn_id: string | null;
  mfl_id: string | null;
  fantasypros_id: string | null;
  pff_id: string | null;
  pfr_id: string | null;
  ktc_id: string | null;
  rotowire_id: number | null;
  yahoo_id: number | null;
}

// --- CSV Parser ---
// RFC 4180 compliant — handles quoted fields containing commas and newlines.
// Naive split(",") breaks on these and misaligns all subsequent columns.

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && next === "\n") i++; // skip CRLF second byte
        row.push(field);
        field = "";
        if (row.length > 0) rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
  }

  // flush final field/row
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// --- Fetch & Parse ---

function parseNullable(val: string): string | null {
  return val === "NA" || val === "" ? null : val;
}

function parseNullableInt(val: string): number | null {
  if (val === "NA" || val === "") return null;
  const n = parseInt(val);
  return isNaN(n) ? null : n;
}

async function fetchPlayerIds(): Promise<PlayerIdRow[]> {
  console.log("Fetching DynastyProcess crosswalk CSV...");
  const res = await fetch(DYNASTYPROCESS_URL);
  if (!res.ok) throw new Error(`Fetch error: ${res.status}`);
  const text = await res.text();

  const parsed = parseCSV(text);
  if (parsed.length < 2) throw new Error("CSV appears empty or malformed");

  const headers = parsed[0];
  const idx = (name: string) => {
    const i = headers.indexOf(name);
    if (i === -1) throw new Error(`Column "${name}" not found in CSV headers`);
    return i;
  };

  // Resolve column indices once from header row
  const col = {
    sleeper_id:     idx("sleeper_id"),
    gsis_id:        idx("gsis_id"),
    espn_id:        idx("espn_id"),
    mfl_id:         idx("mfl_id"),
    fantasypros_id: idx("fantasypros_id"),
    pff_id:         idx("pff_id"),
    pfr_id:         idx("pfr_id"),
    ktc_id:         idx("ktc_id"),
    rotowire_id:    idx("rotowire_id"),
    yahoo_id:       idx("yahoo_id"),
  };

  const rows: PlayerIdRow[] = [];

  for (let i = 1; i < parsed.length; i++) {
    const cols = parsed[i];
    if (cols.length < headers.length) continue; // skip malformed rows

    const sleeper_id = parseNullable(cols[col.sleeper_id]);
    if (!sleeper_id) continue; // skip rows with no Sleeper ID

    rows.push({
      sleeper_id,
      gsis_id:        parseNullable(cols[col.gsis_id]),
      espn_id:        parseNullable(cols[col.espn_id]),
      mfl_id:         parseNullable(cols[col.mfl_id]),
      fantasypros_id: parseNullable(cols[col.fantasypros_id]),
      pff_id:         parseNullable(cols[col.pff_id]),
      pfr_id:         parseNullable(cols[col.pfr_id]),
      ktc_id:         parseNullable(cols[col.ktc_id]),
      rotowire_id:    parseNullableInt(cols[col.rotowire_id]),
      yahoo_id:       parseNullableInt(cols[col.yahoo_id]),
    });
  }

  return rows;
}

// --- Upsert ---
// Rows whose sleeper_id doesn't exist in scdfl.players will be rejected
// by the FK constraint and collected as errors — no pre-filter needed.

async function upsertPlayerIds(rows: PlayerIdRow[]): Promise<void> {
  console.log(`Upserting ${rows.length} rows in batches of ${UPSERT_BATCH_SIZE}...`);

  let totalUpserted = 0;
  let totalSkipped = 0;

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);

    // Attempt the full batch first
    const { error } = await supabase
      .schema("scdfl")
      .from("player_ids")
      .upsert(batch, { onConflict: "sleeper_id", ignoreDuplicates: false });

    if (error) {
      // FK violations mean some rows reference players not in scdfl.players.
      // Fall back to row-by-row upsert for this batch to skip only bad rows.
      for (const row of batch) {
        const { error: rowError } = await supabase
          .schema("scdfl")
          .from("player_ids")
          .upsert(row, { onConflict: "sleeper_id", ignoreDuplicates: false });

        if (rowError) {
          totalSkipped++;
        } else {
          totalUpserted++;
        }
      }
    } else {
      totalUpserted += batch.length;
    }

    const end = Math.min(i + UPSERT_BATCH_SIZE, rows.length);
    console.log(`  Batch ${i + 1}–${end} processed.`);
  }

  console.log(`  ✓ ${totalUpserted} upserted, ${totalSkipped} skipped (not in scdfl.players).`);
}

// --- Main ---

async function main() {
  const allRows = await fetchPlayerIds();
  console.log(`Parsed ${allRows.length} rows with sleeper_id from crosswalk.`);
  await upsertPlayerIds(allRows);
  console.log("\nPlayer ID crosswalk sync complete.");
}

main();
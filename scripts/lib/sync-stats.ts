import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

// ------------------------------------------------------------
// Syncs weekly NFL player stats into scdfl.nfl_stats.
// Source: nflverse-data GitHub releases
// URL pattern: https://github.com/nflverse/nflverse-data/releases/
//              download/stats_player/stats_player_week_<year>.csv
//
// Iterates years from scdfl.seasons. Preserves both REG and POST
// season_type rows. Detects "Not found" responses (future seasons)
// and skips gracefully.
//
// PK: (gsis_id, season, week) — upsert safe for re-runs and
// mid-season refreshes.
//
// Run cadence: weekly during the season, or on-demand for backfill.
// ------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const NFLVERSE_URL = (year: number) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${year}.csv`;

const UPSERT_BATCH_SIZE = 500;

// --- Types ---

interface Season {
  year: number;
}

interface NflStatRow {
  gsis_id: string;
  season: number;
  week: number;
  season_type: string | null;
  pass_att: number | null;
  pass_comp: number | null;
  pass_yds: number | null;
  pass_tds: number | null;
  rush_att: number | null;
  rush_yds: number | null;
  rush_tds: number | null;
  targets: number | null;
  receptions: number | null;
  rec_yds: number | null;
  rec_tds: number | null;
  fg_att: number | null;
  fg_made: number | null;
  fg_yds: number | null;
  fumbles: number | null;
  fum_lost: number | null;
  solo_tkl: number | null;
  asst_tkl: number | null;
  tfl: number | null;
  qb_hit: number | null;
  pass_defended: number | null;
  sack: number | null;
  interception: number | null;
  forced_fumble: number | null;
  fumble_recovery: number | null;
  safety: number | null;
  idp_td: number | null;
}

// --- CSV Parser ---
// RFC 4180 compliant — handles quoted fields containing commas.

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && next === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1) rows.push(row); // skip blank lines
        row = [];
      } else { field += ch; }
    }
  }
  if (field || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// --- Helpers ---

function n(val: string): number | null {
  if (val === "" || val === "NA") return null;
  const f = parseFloat(val);
  return isNaN(f) ? null : f;
}

function ni(val: string): number | null {
  if (val === "" || val === "NA") return null;
  const i = parseInt(val);
  return isNaN(i) ? null : i;
}

function add(...vals: (number | null)[]): number | null {
  const nums = vals.filter((v): v is number => v !== null);
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
}

// --- Fetch ---

async function fetchSeasons(): Promise<Season[]> {
  const { data, error } = await supabase
    .schema("scdfl")
    .from("seasons")
    .select("year")
    .order("year", { ascending: true });

  if (error) throw new Error(`Failed to fetch seasons: ${error.message}`);
  return data as Season[];
}

async function fetchStatsCSV(year: number): Promise<string | null> {
  const url = NFLVERSE_URL(year);
  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok) {
    console.log(`  HTTP ${res.status} — skipping ${year}.`);
    return null;
  }

  const text = await res.text();

  // nflverse returns a plain "Not found" string for missing seasons
  if (!text.trim().startsWith("player_id")) {
    console.log(`  No data available for ${year} — skipping.`);
    return null;
  }

  return text;
}

// --- Transform ---

function parseStats(csv: string, year: number): NflStatRow[] {
  const parsed = parseCSV(csv);
  if (parsed.length < 2) return [];

  const headers = parsed[0];
  const idx = (name: string) => headers.indexOf(name);

  const col = {
    player_id:              idx("player_id"),         // gsis_id in our schema
    season_type:            idx("season_type"),
    week:                   idx("week"),
    completions:            idx("completions"),
    attempts:               idx("attempts"),
    passing_yards:          idx("passing_yards"),
    passing_tds:            idx("passing_tds"),
    carries:                idx("carries"),
    rushing_yards:          idx("rushing_yards"),
    rushing_tds:            idx("rushing_tds"),
    targets:                idx("targets"),
    receptions:             idx("receptions"),
    receiving_yards:        idx("receiving_yards"),
    receiving_tds:          idx("receiving_tds"),
    fg_att:                 idx("fg_att"),
    fg_made:                idx("fg_made"),
    fg_long:                idx("fg_long"),
    // fumbles: computed from three sources
    rushing_fumbles:        idx("rushing_fumbles"),
    receiving_fumbles:      idx("receiving_fumbles"),
    sack_fumbles:           idx("sack_fumbles"),
    rushing_fumbles_lost:   idx("rushing_fumbles_lost"),
    receiving_fumbles_lost: idx("receiving_fumbles_lost"),
    sack_fumbles_lost:      idx("sack_fumbles_lost"),
    // defense
    def_tackles_solo:       idx("def_tackles_solo"),
    def_tackle_assists:     idx("def_tackle_assists"),
    def_tackles_for_loss:   idx("def_tackles_for_loss"),
    def_qb_hits:            idx("def_qb_hits"),
    def_pass_defended:      idx("def_pass_defended"),
    def_sacks:              idx("def_sacks"),
    def_interceptions:      idx("def_interceptions"),
    def_fumbles_forced:     idx("def_fumbles_forced"),
    fumble_recovery_opp:    idx("fumble_recovery_opp"),
    def_safeties:           idx("def_safeties"),
    def_tds:                idx("def_tds"),
  };

  const rows: NflStatRow[] = [];

  for (let i = 1; i < parsed.length; i++) {
    const c = parsed[i];
    if (c.length < headers.length) continue;

    const gsis_id = c[col.player_id]?.trim();
    if (!gsis_id || gsis_id === "NA" || gsis_id === "") continue;

    const week = ni(c[col.week]);
    if (week === null) continue;

    rows.push({
      gsis_id,
      season: year,
      week,
      season_type: c[col.season_type] || null,
      pass_comp:       ni(c[col.completions]),
      pass_att:        ni(c[col.attempts]),
      pass_yds:        n(c[col.passing_yards]),
      pass_tds:        ni(c[col.passing_tds]),
      rush_att:        ni(c[col.carries]),
      rush_yds:        n(c[col.rushing_yards]),
      rush_tds:        ni(c[col.rushing_tds]),
      targets:         ni(c[col.targets]),
      receptions:      ni(c[col.receptions]),
      rec_yds:         n(c[col.receiving_yards]),
      rec_tds:         ni(c[col.receiving_tds]),
      fg_att:          ni(c[col.fg_att]),
      fg_made:         ni(c[col.fg_made]),
      fg_yds:          ni(c[col.fg_long]),
      fumbles: add(
        ni(c[col.rushing_fumbles]),
        ni(c[col.receiving_fumbles]),
        ni(c[col.sack_fumbles])
      ),
      fum_lost: add(
        ni(c[col.rushing_fumbles_lost]),
        ni(c[col.receiving_fumbles_lost]),
        ni(c[col.sack_fumbles_lost])
      ),
      solo_tkl:        ni(c[col.def_tackles_solo]),
      asst_tkl:        ni(c[col.def_tackle_assists]),
      tfl:             n(c[col.def_tackles_for_loss]),
      qb_hit:          ni(c[col.def_qb_hits]),
      pass_defended:   ni(c[col.def_pass_defended]),
      sack:            n(c[col.def_sacks]),
      interception:    ni(c[col.def_interceptions]),
      forced_fumble:   ni(c[col.def_fumbles_forced]),
      fumble_recovery: ni(c[col.fumble_recovery_opp]),
      safety:          ni(c[col.def_safeties]),
      idp_td:          ni(c[col.def_tds]),
    });
  }

  return rows;
}

// --- Upsert ---

async function upsertStats(rows: NflStatRow[], year: number): Promise<void> {
  if (rows.length === 0) return;

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase
      .schema("scdfl")
      .from("nfl_stats")
      .upsert(batch, { onConflict: "gsis_id,season,week" });

    if (error) throw new Error(`Upsert failed for ${year} batch ${i}: ${error.message}`);
  }
}

// --- Main ---

async function syncYear(year: number): Promise<void> {
  console.log(`\n  Syncing ${year}...`);

  const csv = await fetchStatsCSV(year);
  if (!csv) return;

  const rows = parseStats(csv, year);
  console.log(`  Parsed ${rows.length} player-week rows.`);

  await upsertStats(rows, year);
  console.log(`  ✓ ${year} upserted.`);
}

async function main() {
  const seasons = await fetchSeasons();
  console.log(`Found ${seasons.length} seasons to sync.`);

  for (const { year } of seasons) {
    try {
      await syncYear(year);
    } catch (err) {
      console.error(`  ✗ Error syncing ${year}:`, err);
    }
  }

  console.log("\nNFL stats sync complete.");
}

main();
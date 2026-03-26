/**
 * Fetches data from the Sleeper API and writes it to src/data/.
 *
 * Usage:
 *   npm run fetch           # fetch current season only (default)
 *   npm run fetch -- --all  # fetch all seasons from config.json
 *
 * Raw API responses are cached to src/data/raw/ for inspection.
 * Processed stats are merged into src/data/results.json.
 *
 * Only year, wins, losses, points_for, and points_against are written by this script.
 * The `playoff` and `finish` fields are managed manually in results.json and will
 * never be overwritten — existing values are always preserved.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../src/data/config.json' assert { type: 'json' };
import draftConfigData from '../src/data/draft-config.json' assert { type: 'json' };
const draftConfig = draftConfigData as DraftConfig;
import { getRosters, getMatchups, getTransactions, getNflState, getDraftPicks, type SleeperTransaction } from './lib/sleeper-api.js';
import { buildSeasonStats } from './lib/transform.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface DraftConfigEntry {
  year: number;
  draft_id: string;
  type: string;
}

interface DraftConfig {
  drafts: DraftConfigEntry[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RAW_DIR = join(ROOT, 'src/data/raw');
const DATA_DIR = join(ROOT, 'src/data');

const ALL_SEASONS = process.argv.includes('--all');

// ─── Helpers ──────────────────────────────────────────────────────────────

function saveRaw(filename: string, data: unknown) {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(join(RAW_DIR, filename), JSON.stringify(data, null, 2));
}

function loadResults(): Record<string, Array<Record<string, unknown>>> {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, 'results.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function saveResults(results: Record<string, unknown[]>) {
  writeFileSync(join(DATA_DIR, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`✓ Wrote src/data/results.json`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

const seasonsToFetch = ALL_SEASONS
  ? config.seasons.filter(s => s.league_id)
  : config.seasons.filter(s => s.current && s.league_id);

if (seasonsToFetch.length === 0) {
  console.error('No seasons to fetch. Check config.json league_id fields.');
  process.exit(1);
}

console.log(
  ALL_SEASONS
    ? `Fetching all ${seasonsToFetch.length} seasons...`
    : `Fetching current season (${seasonsToFetch[0].year})...`
);

// Fetch NFL state once — needed to know the current week for the active season
const nflState = await getNflState();
saveRaw('nfl-state.json', nflState);
console.log(`NFL state: season ${nflState.season}, week ${nflState.week} (${nflState.season_type})`);

const allResults = loadResults();

for (const season of seasonsToFetch) {
  console.log(`\n→ Season ${season.year} (league_id: ${season.league_id})`);

  // Pull team rosters
  const rosters = await getRosters(season.league_id);

  saveRaw(`${season.year}-rosters.json`, rosters);
  console.log(`  cached raw response to src/data/raw/`);

  // Pull season stats
  const seasonStats = buildSeasonStats(season.year, rosters);

  // Merge: only overwrite API-derived fields; preserve playoff and finish
  for (const [abbr, stats] of Object.entries(seasonStats)) {
    if (!allResults[abbr]) allResults[abbr] = [];

    const idx = allResults[abbr].findIndex(r => r['year'] === season.year);
    if (idx >= 0) {
      // Entry exists — update only the 5 API fields, leave everything else untouched
      const existing = allResults[abbr][idx];
      allResults[abbr][idx] = {
        ...existing,
        year: stats.year,
        wins: stats.wins,
        losses: stats.losses,
        points_for: stats.points_for,
        points_against: stats.points_against,
      };
    } else {
      // New entry — create with empty playoff/finish for manual completion
      allResults[abbr].push({
        year: stats.year,
        wins: stats.wins,
        losses: stats.losses,
        points_for: stats.points_for,
        points_against: stats.points_against,
        playoff: '',
        finish: '',
      });
      allResults[abbr].sort((a, b) => (a['year'] as number) - (b['year'] as number));
    }
  }

  console.log(`  updated ${Object.keys(seasonStats).length} franchises`);

  // Pull matchups for each regular-season week
  const maxWeek = season.current ? nflState.week : 17;
  const matchupsByWeek: Record<number, unknown> = {};
  for (let week = 1; week <= maxWeek; week++) {
    matchupsByWeek[week] = await getMatchups(season.league_id, week);
  }
  saveRaw(`${season.year}-matchups.json`, matchupsByWeek);
  console.log(`  cached matchups weeks 1–${maxWeek} to src/data/raw/`);

  // Pull transactions for each regular-season week
  const transactionsByWeek: Record<number, SleeperTransaction[]> = {};
  for (let week = 1; week <= maxWeek + 1; week++) {
    transactionsByWeek[week] = await getTransactions(season.league_id, week);
  }
  saveRaw(`${season.year}-transactions.json`, transactionsByWeek);
  console.log(`  cached transactions weeks 1–${maxWeek} to src/data/raw/`);
}

saveResults(allResults);

// ─── Draft data ────────────────────────────────────────────────────────────

if (draftConfig.drafts && draftConfig.drafts.length > 0) {
  console.log(`\nFetching ${draftConfig.drafts.length} draft(s)...`);

  for (const draftEntry of draftConfig.drafts) {
    try {
      const picks = await getDraftPicks(draftEntry.draft_id);
      const filename = `${draftEntry.year}-${draftEntry.type}-draft.json`;
      saveRaw(filename, picks);
      console.log(`  ✓ ${filename}`);
    } catch (err) {
      console.error(`  ✗ Failed to fetch draft ${draftEntry.draft_id}: ${err}`);
    }
  }
}

// ─── Player ID map (opt-in, run with --players) ────────────────────────────

if (process.argv.includes('--players')) {
  console.log('\nFetching player ID map from dynastyprocess crosswalk...');

  const CSV_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';
  const csvRes = await fetch(CSV_URL);
  if (!csvRes.ok) throw new Error(`Failed to fetch crosswalk CSV: ${csvRes.status}`);
  const csvText = await csvRes.text();

  function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  const lines = csvText.trim().split('\n');
  const headers = parseCsvLine(lines[0].replace(/\r$/, ''));

  const sleeperIdx = headers.indexOf('sleeper_id');
  const espnIdx = headers.indexOf('espn_id');
  const nameIdx = headers.indexOf('name');
  const posIdx = headers.indexOf('position');

  if ([sleeperIdx, espnIdx, nameIdx, posIdx].includes(-1)) {
    throw new Error(`Missing expected columns in crosswalk CSV. Found: ${headers.join(', ')}`);
  }

  const map: Record<string, { espn_id?: string; full_name: string; position: string }> = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i].replace(/\r$/, ''));
    const sleeperId = cols[sleeperIdx]?.trim();
    if (!sleeperId || sleeperId === 'NA') continue;

    const espnId = cols[espnIdx]?.trim();
    const name = cols[nameIdx]?.trim();
    const position = cols[posIdx]?.trim();

    if (!name || name === 'NA') continue;

    map[sleeperId] = {
      ...(espnId && espnId !== 'NA' ? { espn_id: espnId } : {}),
      full_name: name,
      position: position && position !== 'NA' ? position : '',
    };
  }

  const withEspn = Object.values(map).filter(p => p.espn_id).length;
  writeFileSync(join(DATA_DIR, 'player-id-map.json'), JSON.stringify(map, null, 2));
  console.log(`✓ Wrote src/data/player-id-map.json (${Object.keys(map).length} players; ${withEspn} with ESPN IDs)`);
}

console.log('\nDone.');

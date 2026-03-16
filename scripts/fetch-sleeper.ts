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
import { getRosters, getMatchups, getNflState, getPlayers } from './lib/sleeper-api.js';
import { buildSeasonStats } from './lib/transform.js';

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
}

saveResults(allResults);

// ─── Player ID map (opt-in, run with --players) ────────────────────────────

if (process.argv.includes('--players')) {
  console.log('\nFetching player ID map from Sleeper (this may take a moment)...');
  const raw = await getPlayers();
  const map: Record<string, { espn_id?: string; full_name: string; position: string }> = {};
  for (const [playerId, player] of Object.entries(raw)) {
    if (!player.full_name) continue;
    map[playerId] = {
      ...(player.espn_id ? { espn_id: String(player.espn_id) } : {}),
      full_name: player.full_name,
      position: player.position ?? '',
    };
  }
  const withEspn = Object.values(map).filter(p => p.espn_id).length;
  writeFileSync(join(DATA_DIR, 'player-id-map.json'), JSON.stringify(map, null, 2));
  console.log(`✓ Wrote src/data/player-id-map.json (${Object.keys(map).length} players; ${withEspn} with ESPN IDs)`);
}

console.log('\nDone.');

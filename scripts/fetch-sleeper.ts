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
import { getRosters } from './lib/sleeper-api.js';
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

const allResults = loadResults();

for (const season of seasonsToFetch) {
  console.log(`\n→ Season ${season.year} (league_id: ${season.league_id})`);

  const rosters = await getRosters(season.league_id);

  saveRaw(`${season.year}-rosters.json`, rosters);
  console.log(`  cached raw response to src/data/raw/`);

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
}

saveResults(allResults);
console.log('\nDone.');

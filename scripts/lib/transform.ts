/**
 * Transforms raw Sleeper API responses into the JSON shapes consumed by the site.
 *
 * Key mapping: Sleeper roster_id → franchise abbr
 * franchises.json `id` is the Sleeper roster_id (1-based integer, matches roster order).
 *
 * Only API-derivable fields are computed here: year, wins, losses, points_for, points_against.
 * The `playoff` and `finish` fields are set manually in results.json and are never
 * overwritten by the fetch script.
 */

import type { SleeperRoster } from './sleeper-api.js';
import franchises from '../../src/data/franchises.json' assert { type: 'json' };

// Build roster_id → franchise abbr lookup using franchises.json `id` field
function buildRosterMap(): Map<number, string> {
  const map = new Map<number, string>();
  for (const f of franchises) {
    map.set(f.id, f.abbr);
  }
  return map;
}

/** Combine integer + decimal parts of Sleeper's split points format. */
export function sleeperPoints(integer: number, decimal: number): number {
  return parseFloat(`${integer}.${String(decimal).padStart(2, '0')}`);
}

/** The fields the fetch script writes. playoff and finish are managed manually. */
export interface ApiSeasonStats {
  year: number;
  wins: number;
  losses: number;
  points_for: number;
  points_against: number;
}

/**
 * Extract per-franchise season stats from Sleeper rosters.
 * Returns only the fields derivable from the API.
 */
export function buildSeasonStats(
  year: number,
  rosters: SleeperRoster[]
): Record<string, ApiSeasonStats> {
  const rosterMap = buildRosterMap();
  const stats: Record<string, ApiSeasonStats> = {};

  for (const roster of rosters) {
    const abbr = rosterMap.get(roster.roster_id);
    if (!abbr) {
      console.warn(`  No franchise found for roster_id ${roster.roster_id} — check franchises.json id fields`);
      continue;
    }

    const s = roster.settings;
    stats[abbr] = {
      year,
      wins: s.wins,
      losses: s.losses,
      points_for: sleeperPoints(s.fpts, s.fpts_decimal),
      points_against: sleeperPoints(s.fpts_against, s.fpts_against_decimal),
    };
  }

  return stats;
}

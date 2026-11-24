import { supabase } from './supabase';
import type { LeaderRow } from './superlatives-awards';

/**
 * Loader for /superlatives. Reads the race the nightly sync wrote
 * (`scdfl.superlative_leaders`) and prefers the frozen ballot list
 * (`scdfl.superlative_leaders_final`) once the season has one.
 *
 * Build-time only (the page is pre-rendered). Nothing is computed here —
 * the methodology lives in `scdfl.compute_superlative_leaders`, see
 * SUPERLATIVES.md and supabase/migrations/20261116150100_superlatives_compute.sql.
 */

export type SuperlativeRace = {
  season: number;
  asOfWeek: number;
  /** True when the rows came from the write-once ballot snapshot. */
  frozen: boolean;
  generatedAt: string | null;
  rows: LeaderRow[];
};

const COLUMNS =
  'season, as_of_week, award_code, rank, player_id, sleeper_id, transaction_id, franchise_abbr, score, headline, detail_lines, flags, payload, generated_at';

/** The latest season with leaders, or null if the table is still empty. */
export async function loadSuperlativeRace(): Promise<SuperlativeRace | null> {
  const { data: latest, error: lErr } = await supabase
    .schema('scdfl')
    .from('superlative_leaders')
    .select('season')
    .order('season', { ascending: false })
    .limit(1);

  if (lErr) throw new Error(`Superlative leaders query failed: ${lErr.message}`);
  const season = latest?.[0]?.season;
  if (!season) return null;

  const [{ data: finalRows, error: fErr }, { data: liveRows, error: rErr }] = await Promise.all([
    supabase
      .schema('scdfl')
      .from('superlative_leaders_final')
      .select(COLUMNS)
      .eq('season', season)
      .order('award_code')
      .order('rank')
      .limit(200),
    supabase
      .schema('scdfl')
      .from('superlative_leaders')
      .select(COLUMNS)
      .eq('season', season)
      .order('award_code')
      .order('rank')
      .limit(200),
  ]);

  if (fErr) throw new Error(`Superlative final query failed: ${fErr.message}`);
  if (rErr) throw new Error(`Superlative leaders query failed: ${rErr.message}`);

  const frozen = (finalRows?.length ?? 0) > 0;
  const rows = ((frozen ? finalRows : liveRows) ?? []) as LeaderRow[];

  return {
    season,
    asOfWeek: rows[0]?.as_of_week ?? 0,
    frozen,
    generatedAt: rows[0]?.generated_at ?? null,
    rows,
  };
}

export type RacePlayer = {
  player_id: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  team: string | null;
  espn_id: string | null;
};

/** Names, positions and headshot ids for every player on the boards. */
export async function loadRacePlayers(playerIds: string[]): Promise<Map<string, RacePlayer>> {
  const ids = [...new Set(playerIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .schema('scdfl')
    .from('v_players')
    .select('player_id, first_name, last_name, position, team, espn_id')
    .in('player_id', ids)
    .limit(500);

  if (error) throw new Error(`Players query failed: ${error.message}`);
  return new Map(((data ?? []) as RacePlayer[]).map(p => [p.player_id, p]));
}

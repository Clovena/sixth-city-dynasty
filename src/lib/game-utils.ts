import { supabase } from './supabase';
import { pad2 } from './format';
import type { SideIdentity } from './franchise-identity';

/**
 * Game/matchup helpers shared across the scores, franchise, history, and
 * recap pages.
 */

export const GAME_TYPE_LABEL: Record<number, string> = {
  0: 'Regular Season',
  1: 'Playoffs',
  [-1]: 'Consolation',
};

/** Canonical recap slug: [week_padded]-[abbr_a]-[abbr_b], teams alphabetised. */
export function buildSlug(abbrA: string, abbrB: string, week: number): string {
  const [first, second] = [abbrA.toLowerCase(), abbrB.toLowerCase()].sort();
  return `${pad2(week)}-${first}-${second}`;
}

/** Recap page href for a game, or null if either side's identity couldn't be resolved. */
export function gameHref(
  year: number,
  week: number,
  a: SideIdentity | null,
  b: SideIdentity | null,
): string | null {
  if (!a || !b) return null;
  return `/games/${year}/${buildSlug(a.abbr, b.abbr, week)}`;
}

/**
 * Sleeper seeds the postseason brackets (weeks 15–17) with placeholder
 * opponents before those games are actually played, arriving as a 0–0 score.
 * Regular season games are always playable; postseason games are only
 * playable once they've actually been scored.
 */
export function isPlayablePostseasonGame(
  gameType: number,
  scoreA: number | null | undefined,
  scoreB: number | null | undefined,
): boolean {
  const notStarted = Number(scoreA ?? 0) === 0 && Number(scoreB ?? 0) === 0;
  return !(gameType !== 0 && notStarted);
}

export type ChampionshipMatchup = {
  year: number;
  roster_id_a: number;
  roster_id_b: number;
  score_a: number;
  score_b: number;
};

/**
 * Every Dynasty Bowl (week 17, game_type = 1) actually played, across all
 * seasons. Excludes the still-0–0 bracket placeholder for a season whose
 * championship hasn't been played yet — callers never need to filter this
 * themselves.
 */
export async function loadChampionshipMatchups(): Promise<ChampionshipMatchup[]> {
  const { data, error } = await supabase
    .schema('scdfl')
    .from('matchups')
    .select('year, roster_id_a, roster_id_b, score_a, score_b')
    .eq('week', 17)
    .eq('game_type', 1)
    .limit(1000);

  if (error) throw new Error(`Championship matchups query failed: ${error.message}`);
  return ((data ?? []) as ChampionshipMatchup[]).filter(m => isPlayablePostseasonGame(1, m.score_a, m.score_b));
}

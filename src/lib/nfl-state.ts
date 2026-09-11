/**
 * Live NFL state, from Sleeper.
 *
 * Read at build time. Pages that lead with "the current week" need to know
 * where the real-world season actually is, which is not something the archive
 * can tell them: `matchups` rows exist for the whole schedule from the moment
 * a Sleeper league is created, so "latest week with data" runs ahead of the
 * week being played.
 *
 * Every field is nullable. A build with no network (or a Sleeper outage) must
 * still produce a page, so callers are expected to fall back to archive-derived
 * behaviour rather than treating this as required data.
 */
export type NflState = {
  /** Calendar year of the season in progress, e.g. 2026. */
  season: number | null;
  /** Week number as Sleeper reports it — 0 during the preseason. */
  week: number | null;
  /** 'pre' | 'regular' | 'post', or null if absent. */
  seasonType: string | null;
};

const EMPTY: NflState = { season: null, week: null, seasonType: null };

export async function loadNflState(): Promise<NflState> {
  try {
    const res = await fetch('https://api.sleeper.app/v1/state/nfl');
    if (!res.ok) return EMPTY;

    const state = await res.json();
    const season = Number(state.season);
    const week = Number(state.week);

    return {
      season: Number.isFinite(season) ? season : null,
      week: Number.isFinite(week) ? week : null,
      seasonType: typeof state.season_type === 'string' ? state.season_type : null,
    };
  } catch {
    // Offline / network failure — the caller falls back to the archive.
    return EMPTY;
  }
}

/**
 * The week a page should lead with, given the live state.
 *
 * Sleeper reports week 0 during the preseason, and its preseason week counter
 * doesn't line up with the regular-season schedule, so both cases resolve to
 * Week 1. Returns null when the state is unusable or is for a different season
 * than the one being displayed.
 */
export function activeWeekFor(state: NflState, year: number): number | null {
  if (state.season === null || state.week === null || state.season !== year) return null;
  return state.seasonType === 'pre' ? 1 : Math.max(state.week, 1);
}

import { supabase } from './supabase';
import { franchiseForYear, activeFranchise, type FranchiseRow } from './franchise-identity';
import { buildSlug } from './game-utils';
import { computePlayoffPicture, type SeedingGame, type SeedingTeam } from './playoff-picture';
import { buildBracket, type BracketView } from './playoff-bracket';

/**
 * One season's standings, schedule state and playoff bracket, in the shape the
 * homepage, `/history/[year]` and `/sim` all need.
 *
 * `seasons` and `results` rows exist from the day a Sleeper league is created,
 * and `matchups` holds the whole schedule from that day too, so where a season
 * actually stands has to be read off the scores rather than off which rows
 * exist. That reading lives here so the three pages can't disagree about it.
 */

/**
 * - `pre`      — nothing scored yet
 * - `regular`  — regular season under way; the bracket is a projection
 * - `post`     — the bracket is set (`game_type = 1` rows exist) but unfinished
 * - `complete` — the Dynasty Bowl has been played
 */
export type SeasonPhase = 'pre' | 'regular' | 'post' | 'complete';

export type PictureTeam = SeedingTeam & {
  /** Era abbr for this season — logos */
  abbr: string;
  /** Current identity — `/franchises/[abbr]` links */
  activeAbbr: string;
  name: string;
  losses: number;
  ties: number;
  pointsAgainst: number;
  /** 0 when outside the field */
  seed: number;
};

/** A regular-season game not yet final, with whatever live score it carries. */
export type RemainingGame = {
  week: number;
  matchupId: number;
  rosterIdA: number;
  rosterIdB: number;
  scoreA: number;
  scoreB: number;
};

export type SeasonPicture = {
  year: number;
  phase: SeasonPhase;
  playoffTeams: number;
  /**
   * Regular-season weeks Sleeper has finalized, read as the most games any team
   * has on its record. A week with live, still-moving scores is not counted —
   * its results are not yet in `results.wins`, and head-to-head shouldn't run
   * ahead of the standings it breaks ties in.
   */
  lockedThrough: number;
  /** Length of the regular season, from the `game_type = 0` schedule. */
  regularWeeks: number;
  teams: PictureTeam[];
  /** Finalized regular-season games, as head-to-head evidence. */
  lockedGames: SeedingGame[];
  remainingGames: RemainingGame[];
  bracket: BracketView;
};

export async function loadSeasonPicture(year: number, franchises: FranchiseRow[]): Promise<SeasonPicture> {
  const [seasonRes, resultsRes, matchupsRes] = await Promise.all([
    supabase
      .schema('scdfl')
      .from('seasons')
      .select('playoff_teams')
      .eq('year', year)
      .single(),
    supabase
      .schema('scdfl')
      .from('results')
      .select('sleeper_id, wins, losses, ties, points_for, points_against, seed')
      .eq('year', year),
    supabase
      .schema('scdfl')
      .from('matchups')
      .select('week, matchup_id, game_type, roster_id_a, roster_id_b, score_a, score_b')
      .eq('year', year)
      .in('game_type', [0, 1])
      .limit(1000),
  ]);

  if (seasonRes.error) throw new Error(`Season query failed: ${seasonRes.error.message}`);
  if (resultsRes.error) throw new Error(`Results query failed: ${resultsRes.error.message}`);
  if (matchupsRes.error) throw new Error(`Matchups query failed: ${matchupsRes.error.message}`);

  const playoffTeams = seasonRes.data.playoff_teams ?? 7;

  const teams: PictureTeam[] = (resultsRes.data ?? []).flatMap(r => {
    const era = franchiseForYear(franchises, r.sleeper_id, year);
    const active = activeFranchise(franchises, r.sleeper_id);
    if (!era && !active) return [];
    return [{
      rosterId: Number(r.sleeper_id),
      conf: (era ?? active)!.conf,
      abbr: (era ?? active)!.abbr,
      activeAbbr: (active ?? era)!.abbr,
      name: (era ?? active)!.name,
      wins: r.wins ?? 0,
      losses: r.losses ?? 0,
      ties: r.ties ?? 0,
      // Postgres numerics can arrive as strings.
      pointsFor: Number(r.points_for ?? 0),
      pointsAgainst: Number(r.points_against ?? 0),
      seed: r.seed ?? 0,
    }];
  });

  const rows = (matchupsRes.data ?? []).filter(m => m.matchup_id);
  const regular = rows.filter(m => m.game_type === 0);
  const postseason = rows.filter(m => m.game_type === 1);
  const isScored = (m: { score_a: number | null; score_b: number | null }) =>
    Number(m.score_a ?? 0) !== 0 || Number(m.score_b ?? 0) !== 0;

  const lockedThrough = Math.max(0, ...teams.map(t => t.wins + t.losses + t.ties));
  const regularWeeks = Math.max(0, ...regular.map(m => m.week));

  const lockedGames: SeedingGame[] = regular
    .filter(m => m.week <= lockedThrough)
    .map(m => ({
      rosterIdA: m.roster_id_a,
      rosterIdB: m.roster_id_b,
      scoreA: Number(m.score_a ?? 0),
      scoreB: Number(m.score_b ?? 0),
    }));

  const remainingGames: RemainingGame[] = regular
    .filter(m => m.week > lockedThrough)
    .sort((a, b) => a.week - b.week || a.matchup_id - b.matchup_id)
    .map(m => ({
      week: m.week,
      matchupId: m.matchup_id,
      rosterIdA: m.roster_id_a,
      rosterIdB: m.roster_id_b,
      scoreA: Number(m.score_a ?? 0),
      scoreB: Number(m.score_b ?? 0),
    }));

  const phase: SeasonPhase =
    postseason.some(m => m.week === 17 && isScored(m)) ? 'complete'
    : postseason.length > 0 ? 'post'
    : lockedThrough > 0 || regular.some(isScored) ? 'regular'
    : 'pre';

  // A set bracket reads the seeds Zac records by hand. Before he has, and all
  // through the regular season, the seeds are derived from the standings.
  const manualSeeds = phase !== 'regular' && teams.some(t => t.seed > 0);
  if (!manualSeeds) {
    for (const t of teams) t.seed = 0;
    for (const { seed, rosterId } of computePlayoffPicture(teams, lockedGames, playoffTeams)) {
      const team = teams.find(t => t.rosterId === rosterId);
      if (team) team.seed = seed;
    }
  }

  const bracket = buildBracket({
    year,
    teams: teams.filter(t => t.seed > 0),
    games: postseason.map(m => ({
      week: m.week,
      rosterIdA: m.roster_id_a,
      rosterIdB: m.roster_id_b,
      scoreA: Number(m.score_a ?? 0),
      scoreB: Number(m.score_b ?? 0),
    })),
    // Per-conference seeds only exist where they were entered by hand.
    shape: playoffTeams >= 8 && manualSeeds ? 'conference8' : 'overall7',
    projected: phase === 'regular',
    slug: buildSlug,
  });

  return { year, phase, playoffTeams, lockedThrough, regularWeeks, teams, lockedGames, remainingGames, bracket };
}

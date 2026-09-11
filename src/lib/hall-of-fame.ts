import { supabase } from './supabase';
import { toRoman, playerName } from './format';
import {
  type FranchiseRow,
  type SideIdentity,
  franchiseForYear,
  activeFranchise,
  franchiseByAbbrForYear,
  identityFor,
} from './franchise-identity';
import { isPlayablePostseasonGame } from './game-utils';

export type { FranchiseRow };

/**
 * Shared Hall of Fame data loaders.
 *
 * The lobby needs a slice of every wing's data and the Champions wing needs all
 * of it, so the per-season podium build lives here rather than being duplicated
 * across pages. Everything runs at build time (all Hall of Fame routes are
 * pre-rendered), so the cost is paid once.
 */

/** One placement on a season's podium, resolved to the identity of that year. */
export type PodiumEntry = {
  /** Identity as branded in that season — drives logos and colors */
  abbr: string;
  name: string;
  owner: string;
  conf: string;
  colors: string[];
  /** Current identity — drives /franchises/[abbr] links */
  activeAbbr: string;
  record: string | null;
  seed: number | null;
  score: number | null;
  opponentScore: number | null;
};

export type SeasonPodium = {
  year: number;
  dynastyBowlLabel: string;
  charity: string | null;
  retreatLocation: string | null;
  champion: PodiumEntry | null;
  runnerUp: PodiumEntry | null;
  third: PodiumEntry | null;
  consolation: PodiumEntry | null;
  consolationRunnerUp: PodiumEntry | null;
  scc: PodiumEntry | null;
  hcc: PodiumEntry | null;
};

type ResultRow = {
  year: number;
  sleeper_id: string;
  finish: string | null;
  playoff: boolean | null;
  wins: number;
  losses: number;
  ties: number;
  seed: number | null;
};

type PostseasonSide = {
  year: number;
  week: number;
  gameType: number;
  rid: number;
  score: number;
  oppRid: number;
  oppScore: number;
  won: boolean;
};

/**
 * Explodes weeks 15–17 into one row per team per game.
 *
 * Sleeper seeds the postseason brackets with placeholder opponents before the
 * games are played; those arrive as 0–0 and are dropped here, the same way
 * /scores and the franchise pages drop them.
 */
function toPostseasonSides(rows: any[]): PostseasonSide[] {
  const sides: PostseasonSide[] = [];

  for (const m of rows) {
    if (!m.matchup_id) continue;
    const a = Number(m.score_a ?? 0);
    const b = Number(m.score_b ?? 0);
    if (!isPlayablePostseasonGame(m.game_type, a, b)) continue;

    sides.push(
      { year: m.year, week: m.week, gameType: m.game_type, rid: m.roster_id_a, score: a, oppRid: m.roster_id_b, oppScore: b, won: a > b },
      { year: m.year, week: m.week, gameType: m.game_type, rid: m.roster_id_b, score: b, oppRid: m.roster_id_a, oppScore: a, won: b > a },
    );
  }

  return sides;
}

/**
 * Loads one podium per completed season: Dynasty Bowl winner and runner-up,
 * third place, consolation champion, and both conference champions.
 *
 * Placement is derived rather than read from `results.finish`, which records
 * regular-season standing for non-playoff teams and does not distinguish the
 * two semifinal losers:
 *
 *  - **3rd place** — winner of the week 17 game between the two teams whose
 *    `finish` is 'Semifinals'.
 *  - **Consolation champion** — the non-playoff team that went undefeated
 *    across the weeks 15–17 consolation bracket (`game_type = -1`). That
 *    bracket has no bearing on `finish`, draft order, or accolades, so the two
 *    genuinely disagree (2025: TOR finished 8th, IQT won the consolation).
 */
export async function loadSeasonPodiums(franchises: FranchiseRow[]): Promise<SeasonPodium[]> {
  const [{ data: seasonRows, error: sErr }, { data: resultRows, error: rErr }, { data: matchupRows, error: mErr }] =
    await Promise.all([
      supabase
        .schema('scdfl')
        .from('seasons')
        .select('year, scc_champion, hcc_champion, charity, retreat_location')
        .order('year'),
      supabase
        .schema('scdfl')
        .from('results')
        .select('year, sleeper_id, finish, playoff, wins, losses, ties, seed')
        .limit(500),
      supabase
        .schema('scdfl')
        .from('matchups')
        .select('year, week, game_type, matchup_id, roster_id_a, roster_id_b, score_a, score_b')
        .gte('week', 15)
        .limit(500),
    ]);

  if (sErr) throw new Error(`Seasons query failed: ${sErr.message}`);
  if (rErr) throw new Error(`Results query failed: ${rErr.message}`);
  if (mErr) throw new Error(`Matchups query failed: ${mErr.message}`);

  const results = (resultRows ?? []) as ResultRow[];
  const sides = toPostseasonSides(matchupRows ?? []);

  const podiums: SeasonPodium[] = [];

  for (const season of seasonRows ?? []) {
    const year = season.year as number;
    const yearSides = sides.filter(s => s.year === year);
    const yearResults = results.filter(r => r.year === year);

    // The Dynasty Bowl anchors the season — no final, no podium (in-progress year).
    const final = yearSides.find(s => s.week === 17 && s.gameType === 1 && s.won);
    if (!final) continue;

    const entry = (rid: number, score: number | null, opponentScore: number | null): PodiumEntry | null => {
      const sleeperId = String(rid);
      const era = franchiseForYear(franchises, sleeperId, year);
      const active = activeFranchise(franchises, sleeperId);
      const identity = era ?? active;
      if (!identity) return null;

      const result = yearResults.find(r => r.sleeper_id === sleeperId);
      const record = result
        ? `${result.wins}–${result.losses}${result.ties ? `–${result.ties}` : ''}`
        : null;

      return {
        abbr: identity.abbr,
        name: identity.name,
        owner: identity.owner,
        conf: identity.conf,
        colors: identity.colors ?? [],
        activeAbbr: active?.abbr ?? identity.abbr,
        record,
        seed: result?.seed ?? null,
        score,
        opponentScore,
      };
    };

    const entryByAbbr = (abbr: string | null): PodiumEntry | null => {
      if (!abbr) return null;
      const era = franchiseByAbbrForYear(franchises, abbr, year);
      if (!era) return null;
      return entry(Number(era.sleeper_id), null, null);
    };

    // ── 3rd place: week 17 game between the two semifinal losers ──────────
    const semiLoserIds = new Set(
      yearResults.filter(r => r.finish === 'Semifinals').map(r => Number(r.sleeper_id)),
    );
    const thirdSide = yearSides.find(
      s => s.week === 17 && s.gameType === -1 && s.won && semiLoserIds.has(s.rid) && semiLoserIds.has(s.oppRid),
    );

    // ── Consolation champion: undefeated non-playoff run through the
    //    game_type = -1 bracket in weeks 15–17 ─────────────────────────────
    const nonPlayoffIds = new Set(
      yearResults.filter(r => r.playoff === false).map(r => Number(r.sleeper_id)),
    );
    const consolationSides = yearSides.filter(s => s.gameType === -1 && nonPlayoffIds.has(s.rid));
    const consolationIds = [...new Set(consolationSides.map(s => s.rid))];
    const consolationWinnerId = consolationIds.find(rid => {
      const games = consolationSides.filter(s => s.rid === rid);
      return games.length > 0 && games.every(s => s.won);
    });
    const consolationFinal =
      consolationWinnerId === undefined
        ? undefined
        : consolationSides.find(s => s.rid === consolationWinnerId && s.week === 17);

    podiums.push({
      year,
      dynastyBowlLabel: `Dynasty Bowl ${toRoman(year - 2020)}`,
      charity: season.charity ?? null,
      retreatLocation: season.retreat_location ?? null,
      champion: entry(final.rid, final.score, final.oppScore),
      runnerUp: entry(final.oppRid, final.oppScore, final.score),
      third: thirdSide ? entry(thirdSide.rid, thirdSide.score, thirdSide.oppScore) : null,
      consolation: consolationFinal
        ? entry(consolationFinal.rid, consolationFinal.score, consolationFinal.oppScore)
        : consolationWinnerId !== undefined
          ? entry(consolationWinnerId, null, null)
          : null,
      consolationRunnerUp: consolationFinal
        ? entry(consolationFinal.oppRid, consolationFinal.oppScore, consolationFinal.score)
        : null,
      scc: entryByAbbr(season.scc_champion),
      hcc: entryByAbbr(season.hcc_champion),
    });
  }

  return podiums.sort((a, b) => b.year - a.year);
}

/** Medal = leading scorer at a position for a season (weeks 1–14), from v_medals. */
export type MedalRow = {
  player_id: string;
  position: string;
  sleeper_id: string;
  year: number;
  games_started: number;
  fpts: number;
};

export async function loadMedals(): Promise<MedalRow[]> {
  const { data, error } = await supabase
    .schema('scdfl')
    .from('v_medals')
    .select('player_id, position, sleeper_id, year, games_started, fpts')
    .limit(500);

  if (error) throw new Error(`Medals query failed: ${error.message}`);
  return (data ?? []) as MedalRow[];
}

/* ────────────────────────────────────────────────────────────────────────────
   Single-game record books
   ──────────────────────────────────────────────────────────────────────────── */

export type TeamScoreRecord = {
  score: number;
  opponentScore: number;
  year: number;
  week: number;
  gameType: number;
  team: SideIdentity | null;
  opponent: SideIdentity | null;
};

export type PlayerScoreRecord = {
  points: number;
  playerId: string;
  name: string;
  position: string;
  year: number;
  week: number;
  gameType: number | null;
  team: SideIdentity | null;
  opponent: SideIdentity | null;
};

/**
 * Highest single-game team totals and individual starts, all-time.
 *
 * Sleeper seeds the postseason brackets with placeholder opponents before those
 * games happen; they arrive as 0–0 and are dropped here, matching /scores and
 * the franchise pages.
 */
export async function loadRecords(
  franchises: FranchiseRow[],
  topN = 10,
): Promise<{ teamScores: TeamScoreRecord[]; playerScores: PlayerScoreRecord[] }> {
  const [{ data: matchupRows, error: mErr }, { data: topStarts, error: sErr }] = await Promise.all([
    // ~580 rows across all seasons, so one padded read covers the table.
    supabase
      .schema('scdfl')
      .from('matchups')
      .select('year, week, matchup_id, game_type, roster_id_a, roster_id_b, score_a, score_b')
      .limit(1000),
    // The starts view is ~17k rows — order and slice server-side.
    supabase
      .schema('scdfl')
      .from('v_player_starts')
      .select('year, week, roster_id, player_id, points')
      .order('points', { ascending: false })
      .limit(topN),
  ]);

  if (mErr) throw new Error(`Matchups query failed: ${mErr.message}`);
  if (sErr) throw new Error(`Player starts query failed: ${sErr.message}`);

  const starts = topStarts ?? [];

  const { data: playerRows, error: pErr } = starts.length
    ? await supabase
        .schema('scdfl')
        .from('players')
        .select('player_id, first_name, last_name, position')
        .in('player_id', starts.map(s => s.player_id))
    : { data: [], error: null };

  if (pErr) throw new Error(`Players query failed: ${pErr.message}`);

  const playerById = new Map((playerRows ?? []).map(p => [p.player_id, p]));

  const games = (matchupRows ?? []).filter(m => {
    if (!m.matchup_id) return false;
    if (m.score_a === null || m.score_b === null) return false;
    return isPlayablePostseasonGame(m.game_type, m.score_a, m.score_b);
  });

  const teamSides: TeamScoreRecord[] = [];

  for (const m of games) {
    const a = identityFor(franchises, m.roster_id_a, m.year);
    const b = identityFor(franchises, m.roster_id_b, m.year);
    const base = { year: m.year, week: m.week, gameType: m.game_type };
    teamSides.push(
      { ...base, score: Number(m.score_a), opponentScore: Number(m.score_b), team: a, opponent: b },
      { ...base, score: Number(m.score_b), opponentScore: Number(m.score_a), team: b, opponent: a },
    );
  }

  const playerScores: PlayerScoreRecord[] = starts.map(start => {
    const player = playerById.get(start.player_id);

    // The starts view carries no opponent, so recover the other side of the game.
    const game = games.find(
      g => g.year === start.year && g.week === start.week &&
        (g.roster_id_a === start.roster_id || g.roster_id_b === start.roster_id),
    );
    const opponentId = game
      ? (game.roster_id_a === start.roster_id ? game.roster_id_b : game.roster_id_a)
      : null;

    return {
      points: Number(start.points),
      playerId: start.player_id,
      name: playerName(player?.first_name, player?.last_name, start.player_id),
      position: player?.position ?? '—',
      year: start.year,
      week: start.week,
      gameType: game?.game_type ?? null,
      team: identityFor(franchises, start.roster_id, start.year),
      opponent: opponentId === null ? null : identityFor(franchises, opponentId, start.year),
    };
  });

  return {
    teamScores: teamSides.sort((x, y) => y.score - x.score).slice(0, topN),
    playerScores,
  };
}

/** Position display order shared by the Medals wing and its filters. */
export const MEDAL_POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];

/** v_medals reports NFL positions; roster-slots uses fantasy ones (K vs. PK). */
export const MEDAL_POSITION_COLOR: Record<string, string> = {
  QB: 'qb',
  RB: 'rb',
  WR: 'wr',
  TE: 'te',
  K: 'pk',
  DL: 'idp',
  LB: 'idp',
  DB: 'idp',
};

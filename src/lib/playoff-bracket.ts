/**
 * Resolves a season's playoff bracket into its seven matchup slots.
 *
 * Shared by the homepage, `/history/[year]` and `/sim`, all of which render it
 * through `src/components/PlayoffBracket.astro`. Pure: the caller supplies the
 * seeded teams and the postseason games, and the recap slug builder.
 *
 * Two shapes have been played:
 *  - `overall7` (2023–): one 1..7 seeding; seed 1 has a bye, then 4v5 on the
 *    left, 2v7 and 3v6 on the right.
 *  - `conference8` (2021–2022): `results.seed` is a per-conference seed; each
 *    conference plays 1v4 and 2v3 on its own side.
 */

export type BracketTeam = {
  rosterId: number;
  /** Overall seed (overall7) or conference seed (conference8) */
  seed: number;
  conf: string;
  /** Era abbr for that season — logos and slugs */
  abbr: string;
};

/** A `game_type = 1` row. */
export type BracketGame = {
  week: number;
  rosterIdA: number;
  rosterIdB: number;
  scoreA: number;
  scoreB: number;
};

export type BracketShape = 'overall7' | 'conference8';

export type BracketMatchup = {
  top: BracketTeam | null;
  bottom: BracketTeam | null;
  /** The top team advances without playing; there is no bottom slot. */
  bye: boolean;
  /** Recap page, only when the game actually exists in `matchups`. */
  href: string | null;
};

export type BracketView = {
  shape: BracketShape;
  /** Seeded from live standings rather than a set bracket. */
  projected: boolean;
  leftTop: BracketMatchup;
  leftBottom: BracketMatchup;
  rightTop: BracketMatchup;
  rightBottom: BracketMatchup;
  leftSemi: BracketMatchup;
  rightSemi: BracketMatchup;
  champion: BracketTeam | null;
  runnerUp: BracketTeam | null;
  finalHref: string | null;
};

const ROUND_ONE = 15;
const SEMIFINAL = 16;
const FINAL = 17;

export function buildBracket(input: {
  year: number;
  teams: BracketTeam[];
  games: BracketGame[];
  shape: BracketShape;
  projected: boolean;
  /** `buildSlug` from game-utils, injected so this module stays import-free. */
  slug: (abbrA: string, abbrB: string, week: number) => string;
}): BracketView {
  const { year, teams, games, shape, projected, slug } = input;

  const bySeed = (seed: number) => teams.find(t => t.seed === seed) ?? null;
  const byConfSeed = (conf: string, seed: number) =>
    teams.find(t => t.conf === conf && t.seed === seed) ?? null;

  // The game between two teams in a given week. Sleeper files the bracket with
  // 0–0 placeholders before it is played, so a result needs a score on it.
  function gameBetween(a: BracketTeam | null, b: BracketTeam | null, week: number) {
    if (!a || !b) return null;
    return games.find(g =>
      g.week === week &&
      ((g.rosterIdA === a.rosterId && g.rosterIdB === b.rosterId) ||
       (g.rosterIdA === b.rosterId && g.rosterIdB === a.rosterId)),
    ) ?? null;
  }

  function winnerOf(a: BracketTeam | null, b: BracketTeam | null, week: number): BracketTeam | null {
    if (a && !b) return a;
    const game = gameBetween(a, b, week);
    if (!game || (game.scoreA === 0 && game.scoreB === 0)) return null;
    const aIsA = game.rosterIdA === a!.rosterId;
    const aScore = aIsA ? game.scoreA : game.scoreB;
    const bScore = aIsA ? game.scoreB : game.scoreA;
    return aScore > bScore ? a : b;
  }

  function hrefFor(a: BracketTeam | null, b: BracketTeam | null, week: number): string | null {
    return gameBetween(a, b, week) ? `/games/${year}/${slug(a!.abbr, b!.abbr, week)}` : null;
  }

  function matchup(top: BracketTeam | null, bottom: BracketTeam | null, week: number, bye = false): BracketMatchup {
    return { top, bottom, bye, href: bye ? null : hrefFor(top, bottom, week) };
  }

  const confs = [...new Set(teams.map(t => t.conf))].sort().reverse(); // SCC left, HCC right

  const leftTop = shape === 'conference8'
    ? matchup(byConfSeed(confs[0], 1), byConfSeed(confs[0], 4), ROUND_ONE)
    : matchup(bySeed(1), null, ROUND_ONE, true);
  const leftBottom = shape === 'conference8'
    ? matchup(byConfSeed(confs[0], 2), byConfSeed(confs[0], 3), ROUND_ONE)
    : matchup(bySeed(4), bySeed(5), ROUND_ONE);
  const rightTop = shape === 'conference8'
    ? matchup(byConfSeed(confs[1], 1), byConfSeed(confs[1], 4), ROUND_ONE)
    : matchup(bySeed(2), bySeed(7), ROUND_ONE);
  const rightBottom = shape === 'conference8'
    ? matchup(byConfSeed(confs[1], 2), byConfSeed(confs[1], 3), ROUND_ONE)
    : matchup(bySeed(3), bySeed(6), ROUND_ONE);

  const advance = (m: BracketMatchup) => winnerOf(m.top, m.bottom, ROUND_ONE);
  const leftSemi = matchup(advance(leftTop), advance(leftBottom), SEMIFINAL);
  const rightSemi = matchup(advance(rightTop), advance(rightBottom), SEMIFINAL);

  // The final is read straight from its row rather than from semifinal
  // winners, so a bracket with a gap upstream still names its champion.
  const final = games.find(g => g.week === FINAL && (g.scoreA !== 0 || g.scoreB !== 0));
  let champion: BracketTeam | null = null;
  let runnerUp: BracketTeam | null = null;
  if (final) {
    const aWins = final.scoreA > final.scoreB;
    champion = teams.find(t => t.rosterId === (aWins ? final.rosterIdA : final.rosterIdB)) ?? null;
    runnerUp = teams.find(t => t.rosterId === (aWins ? final.rosterIdB : final.rosterIdA)) ?? null;
  }

  return {
    shape,
    projected,
    leftTop,
    leftBottom,
    rightTop,
    rightBottom,
    leftSemi,
    rightSemi,
    champion,
    runnerUp,
    finalHref: hrefFor(champion, runnerUp, FINAL),
  };
}

// ── Simulated playoffs (/sim) ───────────────────────────────────────────────

/**
 * The six games a reader calls in a simulated `overall7` bracket, in the order
 * they have to be decided. Keys match the `data-slot` prefixes PlayoffBracket
 * renders (`r1lb-top`, `sfr-bottom`, `final-0`, …).
 */
export const PLAYOFF_PICK_KEYS = ['r1lb', 'r1rt', 'r1rb', 'sfl', 'sfr', 'final'] as const;
export type PlayoffPickKey = typeof PLAYOFF_PICK_KEYS[number];

/** Each game's two roster ids (null until both are known) and its winner. */
export type SimulatedBracket = {
  games: Record<PlayoffPickKey, [number | null, number | null]>;
  winners: Record<PlayoffPickKey, number | null>;
};

/**
 * Plays a simulated `overall7` bracket forward from the seeds and the reader's
 * picks — the same shape `buildBracket` draws: seed 1 on a bye, 4v5 into its
 * semifinal, 2v7 and 3v6 into the other, semifinal winners into the final.
 * There is no reseeding.
 *
 * A pick only counts while its team is still in that game. Change a regular-
 * season result and the seeds can move, so a pick for a team that is no longer
 * there is dropped, along with everything downstream of it; `picks` is pruned
 * in place so the caller persists only what still applies.
 */
export function simulateBracket(
  rosterBySeed: Map<number, number>,
  picks: Map<PlayoffPickKey, number>,
): SimulatedBracket {
  const seed = (n: number) => rosterBySeed.get(n) ?? null;
  const games = {} as SimulatedBracket['games'];
  const winners = {} as SimulatedBracket['winners'];

  function play(key: PlayoffPickKey, a: number | null, b: number | null): number | null {
    games[key] = [a, b];
    const pick = picks.get(key);
    const valid = a !== null && b !== null && (pick === a || pick === b);
    if (!valid) picks.delete(key);
    winners[key] = valid ? pick! : null;
    return winners[key];
  }

  const leftQuarter = play('r1lb', seed(4), seed(5));
  const rightTop = play('r1rt', seed(2), seed(7));
  const rightBottom = play('r1rb', seed(3), seed(6));
  const leftFinalist = play('sfl', seed(1), leftQuarter);
  const rightFinalist = play('sfr', rightTop, rightBottom);
  play('final', leftFinalist, rightFinalist);

  return { games, winners };
}

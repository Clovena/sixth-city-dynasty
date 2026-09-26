/**
 * Live playoff seeding for an in-progress season.
 *
 * A completed season carries its seeds in `results.seed`, set by hand once the
 * bracket is known. An active season has `seed IS NULL` for every team, so the
 * seeding has to be derived from the standings and the games played so far.
 *
 * The league's seeding rules, in order:
 *
 *  1. Each conference's leader is the team with the most wins in that
 *     conference. A tie is broken by head-to-head among *only* the tied
 *     same-conference teams, then by points for.
 *  2. The two conference leaders take seeds 1 and 2, ordered by record, then
 *     head-to-head against each other, then points for.
 *  3. Seeds 3 through the last playoff berth are wild cards, ranked purely on
 *     win total with no regard for conference. Ties are broken by head-to-head,
 *     then points for.
 *  4. When more than two teams are tied for a wild-card spot, the tiebreaks run
 *     *within* each conference first to produce one representative per
 *     conference; those representatives are then compared to each other. The
 *     spot is awarded, and the procedure restarts on whoever is left — the same
 *     iterative shape the NFL uses.
 *
 * Everything here is pure; the caller supplies the standings and the games.
 */

/** A team's standing, reduced to what seeding actually depends on. */
export type SeedingTeam = {
  /** `matchups.roster_id_a/b`, equal to `franchises.id` */
  rosterId: number;
  conf: string;
  wins: number;
  pointsFor: number;
};

/** One played regular-season game, as head-to-head evidence. */
export type SeedingGame = {
  rosterIdA: number;
  rosterIdB: number;
  scoreA: number;
  scoreB: number;
};

/**
 * A team's win share against a specific set of opponents, or null when it has
 * not played any of them yet.
 *
 * Ties count as half a win, matching how the standings treat them.
 */
function headToHeadShare(rosterId: number, group: number[], games: SeedingGame[]): number | null {
  const opponents = new Set(group.filter(id => id !== rosterId));
  let played = 0;
  let credit = 0;

  for (const game of games) {
    const isA = game.rosterIdA === rosterId;
    const isB = game.rosterIdB === rosterId;
    if (!isA && !isB) continue;

    const opponentId = isA ? game.rosterIdB : game.rosterIdA;
    if (!opponents.has(opponentId)) continue;

    const mine = isA ? game.scoreA : game.scoreB;
    const theirs = isA ? game.scoreB : game.scoreA;

    played += 1;
    if (mine > theirs) credit += 1;
    else if (mine === theirs) credit += 0.5;
  }

  return played === 0 ? null : credit / played;
}

/**
 * Orders a set of teams by head-to-head within that same set, then points for.
 *
 * Teams that haven't met anyone in the group score a neutral 0.5, so they sit
 * below a team that has won inside the group and above one that has lost there.
 * Early in a season almost nothing has been decided head-to-head, which is why
 * points for does most of the work.
 */
function rankByTiebreak(teams: SeedingTeam[], games: SeedingGame[]): SeedingTeam[] {
  const ids = teams.map(t => t.rosterId);

  return [...teams].sort((x, y) => {
    const sx = headToHeadShare(x.rosterId, ids, games) ?? 0.5;
    const sy = headToHeadShare(y.rosterId, ids, games) ?? 0.5;
    if (sx !== sy) return sy - sx;
    return y.pointsFor - x.pointsFor;
  });
}

/**
 * Picks the single best team out of a tied group.
 *
 * Rule 4: a group of three or more spanning both conferences is reduced to one
 * representative per conference before those are compared. A group inside one
 * conference — or one already down to two teams — is settled directly.
 */
function pickBest(teams: SeedingTeam[], games: SeedingGame[]): SeedingTeam {
  if (teams.length === 1) return teams[0];

  const confs = [...new Set(teams.map(t => t.conf))];

  if (teams.length > 2 && confs.length > 1) {
    const representatives = confs.map(
      conf => rankByTiebreak(teams.filter(t => t.conf === conf), games)[0],
    );
    // With the league's two conferences this always lands on a pair. The guard
    // is for a hypothetical third conference, where reducing a group of three
    // one-team conferences would return the same three and spin forever.
    if (representatives.length < teams.length) return pickBest(representatives, games);
  }

  return rankByTiebreak(teams, games)[0];
}

/** Fully orders a tied group by awarding one spot at a time (rule 4). */
function orderTiedGroup(teams: SeedingTeam[], games: SeedingGame[]): SeedingTeam[] {
  const ordered: SeedingTeam[] = [];
  let remaining = [...teams];

  while (remaining.length > 0) {
    const best = pickBest(remaining, games);
    ordered.push(best);
    remaining = remaining.filter(t => t.rosterId !== best.rosterId);
  }

  return ordered;
}

/** Which conference each berth came from, so the bracket can be explained. */
export type PlayoffSeed = {
  seed: number;
  rosterId: number;
  /** True for the two conference leaders (seeds 1 and 2). */
  conferenceLeader: boolean;
};

/**
 * Derives the current playoff field, seeded 1..`playoffTeams`.
 *
 * Returns seeds in order. Teams outside the field are simply absent.
 */
export function computePlayoffPicture(
  teams: SeedingTeam[],
  games: SeedingGame[],
  playoffTeams = 7,
): PlayoffSeed[] {
  if (teams.length === 0) return [];

  // ── 1. Conference leaders ────────────────────────────────────────────────
  const confs = [...new Set(teams.map(t => t.conf))].sort();
  const leaders: SeedingTeam[] = [];

  for (const conf of confs) {
    const confTeams = teams.filter(t => t.conf === conf);
    if (confTeams.length === 0) continue;

    const maxWins = Math.max(...confTeams.map(t => t.wins));
    const tied = confTeams.filter(t => t.wins === maxWins);
    leaders.push(rankByTiebreak(tied, games)[0]);
  }

  // ── 2. Seeds 1 and 2: record, then head-to-head, then points for ─────────
  const leaderIds = leaders.map(l => l.rosterId);
  const topSeeds = [...leaders].sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    const sx = headToHeadShare(x.rosterId, leaderIds, games) ?? 0.5;
    const sy = headToHeadShare(y.rosterId, leaderIds, games) ?? 0.5;
    if (sx !== sy) return sy - sx;
    return y.pointsFor - x.pointsFor;
  });

  // ── 3. Wild cards: win total across both conferences ─────────────────────
  const leaderIdSet = new Set(leaderIds);
  const contenders = teams.filter(t => !leaderIdSet.has(t.rosterId));
  const winTotals = [...new Set(contenders.map(t => t.wins))].sort((a, b) => b - a);

  const wildCards: SeedingTeam[] = [];
  for (const wins of winTotals) {
    wildCards.push(...orderTiedGroup(contenders.filter(t => t.wins === wins), games));
  }

  return [...topSeeds, ...wildCards].slice(0, playoffTeams).map((team, i) => ({
    seed: i + 1,
    rosterId: team.rosterId,
    conferenceLeader: leaderIdSet.has(team.rosterId),
  }));
}

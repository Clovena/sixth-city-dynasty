// Matchup labeling, pure functions only.
//
// Two kinds of label (spec §5.2, §5.3, §18.5):
//  - regular season: Bowl Game / Rivalry tags from scdfl.spotlight_games
//  - playoffs: round labels derived from Sleeper's bracket JSON

import { ordinal, toRoman } from './util.ts';

// ── Spotlight tags (regular season) ─────────────────────────────────────────

export type SpotlightGame = {
  name: string;
  type: 'bowl-game' | 'rivalry';
  team_a: string; // franchise abbr
  team_b: string;
};

// Label for one pairing, or null. Abbr order doesn't matter.
// Rivalries only fire in the final regular-season week (week 14) and render
// as "Rivalry Week · {name}"; bowls fire whenever the pair meets.
export function spotlightLabel(
  games: SpotlightGame[],
  week: number,
  regularSeasonWeeks: number,
  abbrA: string,
  abbrB: string,
): string | null {
  const match = (g: SpotlightGame) =>
    (g.team_a === abbrA && g.team_b === abbrB) ||
    (g.team_a === abbrB && g.team_b === abbrA);

  if (week === regularSeasonWeeks) {
    const rivalry = games.find((g) => g.type === 'rivalry' && match(g));
    if (rivalry) return `Rivalry Week · ${rivalry.name}`;
  }
  const bowl = games.find((g) => g.type === 'bowl-game' && match(g));
  return bowl ? bowl.name : null;
}

// ── Playoff brackets ────────────────────────────────────────────────────────

// One game as Sleeper's bracket endpoints return it: `r` = round, `m` = game
// id within the bracket, `t1`/`t2` = roster IDs (null until known), `p` =
// placement decided by this game (1 = championship, 3 = third place, ...).
// `t1_from`/`t2_from` say where a team came from: {w: m} = winner of game m,
// {l: m} = loser of game m.
export type BracketGame = {
  r: number;
  m: number;
  t1: number | null;
  t2: number | null;
  p?: number;
  t1_from?: { w?: number; l?: number };
  t2_from?: { w?: number; l?: number };
};

export type PlayoffPairing = {
  rosterIdA: number;
  rosterIdB: number;
  label: string;
  consolation: boolean;
};

const cameFromALoss = (g: BracketGame) =>
  g.t1_from?.l !== undefined || g.t2_from?.l !== undefined;

// Label one winners-bracket game (spec §18.5: label by origin, not round).
//  - p games: 1 → Dynasty Bowl, 3 → Third-Place Game, else "{p}th-Place Game"
//  - no p, fed by at least one loser: a placement-path game. Trace forward to
//    the p game its winner feeds → "5th-Place Semifinal" (2025-verified).
//  - no p, pure winners path: Quarterfinal / Semifinal relative to the final.
export function labelWinnersGame(
  g: BracketGame,
  bracket: BracketGame[],
  dynastyBowlName: string,
): string {
  if (g.p === 1) return dynastyBowlName;
  if (g.p === 3) return 'Third-Place Game';
  if (g.p !== undefined) return `${ordinal(g.p)}-Place Game`;

  if (cameFromALoss(g)) {
    const next = bracket.find((h) =>
      h.r === g.r + 1 && (h.t1_from?.w === g.m || h.t2_from?.w === g.m)
    );
    if (next?.p !== undefined) return `${ordinal(next.p)}-Place Semifinal`;
    return 'Placement Game';
  }

  const maxRound = Math.max(...bracket.map((b) => b.r));
  if (g.r === maxRound - 1) return 'Semifinal';
  if (g.r === maxRound - 2) return 'Quarterfinal';
  return `Round ${g.r}`;
}

// Losers bracket = consolation. Its own p=1 is the consolation final.
export function labelLosersGame(g: BracketGame): string {
  if (g.p === 1) return 'Consolation Final';
  if (g.p !== undefined) return `Consolation ${ordinal(g.p)} Place`;
  return 'Consolation';
}

// All pollable pairings for one playoff week. Round r is played in week
// `playoffWeekStart + r − 1`; only games where both teams are known are
// included (spec §5.3 / §18.6 — an empty result at POST time is an alert).
export function playoffPairingsForWeek(
  winners: BracketGame[],
  losers: BracketGame[],
  playoffWeekStart: number,
  week: number,
  includeConsolation: boolean,
  season: number,
): PlayoffPairing[] {
  const round = week - playoffWeekStart + 1;
  // Dynasty Bowl numbering matches the site: toRoman(year - 2020) → 2026 = VI
  const bowlName = `Dynasty Bowl ${toRoman(season - 2020)}`;

  const ready = (g: BracketGame) =>
    g.r === round && g.t1 !== null && g.t2 !== null;

  const out: PlayoffPairing[] = winners.filter(ready).map((g) => ({
    rosterIdA: g.t1 as number,
    rosterIdB: g.t2 as number,
    label: labelWinnersGame(g, winners, bowlName),
    consolation: false,
  }));

  if (includeConsolation) {
    for (const g of losers.filter(ready)) {
      out.push({
        rosterIdA: g.t1 as number,
        rosterIdB: g.t2 as number,
        label: labelLosersGame(g),
        consolation: true,
      });
    }
  }
  return out;
}

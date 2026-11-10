// Where pairings and results come from, per league and week (spec §5).
// DFL: scdfl.matchups for weeks 1–14, Sleeper brackets for 15–17, Sleeper
// matchups for results. pickems.manual_matchups overrides playoff pairings
// as the emergency fallback (§5.3).

import { sql } from './db.ts';
import { getBrackets, getLeague, getWeekMatchups } from './sleeper.ts';
import { playoffPairingsForWeek, type SpotlightGame, spotlightLabel } from './labels.ts';

export type Pairing = {
  slot: number;
  teamAKey: string;
  teamBKey: string;
  label: string | null;
};

type LeagueRow = {
  key: string;
  season: number;
  matchup_source: string;
  results_source: string;
  regular_season_weeks: number;
  include_consolation: boolean;
};

// The Sleeper league id for a DFL season comes from scdfl.seasons — never
// hard-coded (spec §1).
async function sleeperLeagueId(season: number): Promise<string> {
  const rows = await sql`
    select league_id from scdfl.seasons where year = ${season}`;
  if (!rows[0]?.league_id) {
    throw new Error(`no scdfl.seasons.league_id for ${season}`);
  }
  return rows[0].league_id;
}

// Regular-season pairings from scdfl.matchups with the season-aware
// franchise join (reserved words "from"/"to" quoted; roster_id cast to text
// — repo SQL rules, spec §17). Verified live against weeks 10/11/14 of 2026.
async function scdflPairings(season: number, week: number, regularSeasonWeeks: number): Promise<Pairing[]> {
  const rows = await sql`
    select m.matchup_id as slot,
           m.roster_id_a, fa.abbr as abbr_a,
           m.roster_id_b, fb.abbr as abbr_b
    from scdfl.matchups m
    join scdfl.franchises fa on fa.sleeper_id = m.roster_id_a::text
                            and m.year between fa."from" and coalesce(fa."to", 9999)
    join scdfl.franchises fb on fb.sleeper_id = m.roster_id_b::text
                            and m.year between fb."from" and coalesce(fb."to", 9999)
    where m.year = ${season} and m.week = ${week} and m.game_type = 0
    order by m.matchup_id`;

  const games = await sql`
    select g.name, g.type, g.team_a, g.team_b
    from scdfl.spotlight_games g
    join scdfl.spotlight_game_years y on y.slug = g.slug
    where y.year = ${season}`;

  return rows.map((r) => ({
    slot: r.slot,
    teamAKey: String(r.roster_id_a),
    teamBKey: String(r.roster_id_b),
    label: spotlightLabel(
      games as unknown as SpotlightGame[],
      week,
      regularSeasonWeeks,
      r.abbr_a,
      r.abbr_b,
    ),
  }));
}

async function manualPairings(league: LeagueRow, week: number): Promise<Pairing[]> {
  const rows = await sql`
    select slot, team_a_key, team_b_key, label
    from pickems.manual_matchups
    where league_key = ${league.key} and season = ${league.season} and week = ${week}
    order by slot`;
  return rows.map((r) => ({
    slot: r.slot,
    teamAKey: r.team_a_key,
    teamBKey: r.team_b_key,
    label: r.label ?? null,
  }));
}

async function bracketPairings(league: LeagueRow, week: number): Promise<Pairing[]> {
  const leagueId = await sleeperLeagueId(league.season);
  const lg = await getLeague(leagueId);
  const start = lg.settings.playoff_week_start ?? league.regular_season_weeks + 1;
  const { winners, losers } = await getBrackets(leagueId);
  return playoffPairingsForWeek(
    winners,
    losers,
    start,
    week,
    league.include_consolation,
    league.season,
  ).map((p, i) => ({
    slot: i + 1,
    teamAKey: String(p.rosterIdA),
    teamBKey: String(p.rosterIdB),
    label: p.label,
  }));
}

// May return [] (bracket not advanced yet) — the POST step treats that as
// "alert once and retry each tick until lock" (§18.6).
export async function pairingsFor(league: LeagueRow, week: number): Promise<Pairing[]> {
  if (week <= league.regular_season_weeks) {
    return await scdflPairings(league.season, week, league.regular_season_weeks);
  }
  // Playoffs: hand-entered rows beat the bracket, so Zac can rescue a week
  // where Sleeper's bracket shape surprises us.
  const manual = await manualPairings(league, week);
  if (manual.length > 0) return manual;
  return await bracketPairings(league, week);
}

// Final points per team_key (= roster_id as text) for grading (§5.4). Match
// polls by roster pair, never by Sleeper's matchup_id.
export async function resultsFor(league: LeagueRow, week: number): Promise<Record<string, number>> {
  if (league.results_source !== 'sleeper') {
    // 'scdfl' is designed for but deliberately switched off in v1 (§5.4).
    throw new Error(`results_source ${league.results_source} not implemented`);
  }
  const leagueId = await sleeperLeagueId(league.season);
  const rows = await getWeekMatchups(leagueId, week);
  return Object.fromEntries(rows.map((r) => [String(r.roster_id), r.points]));
}

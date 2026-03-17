/**
 * Typed wrappers for the Sleeper Fantasy Football API.
 * All endpoints are public — no authentication required.
 * Docs: https://docs.sleeper.com/
 */

const BASE = 'https://api.sleeper.app/v1';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Sleeper API error ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

// ─── Raw API shapes ────────────────────────────────────────────────────────

export interface SleeperNflState {
  week: number;           // current NFL week (1-indexed)
  season: string;         // e.g. "2026"
  season_type: string;    // 'pre', 'regular', 'post'
  display_week: number;
  [key: string]: unknown;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  status: string; // 'pre_draft' | 'drafting' | 'in_season' | 'complete'
  total_rosters: number;
  settings: Record<string, number>;
  scoring_settings: Record<string, number>;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string;        // maps to SleeperUser.user_id
  league_id: string;
  players: string[] | null;
  starters: string[] | null;
  settings: {
    wins: number;
    losses: number;
    ties: number;
    fpts: number;          // points for (integer part)
    fpts_decimal: number;  // points for (decimal part, 0–99)
    fpts_against: number;
    fpts_against_decimal: number;
    waiver_position: number;
    waiver_budget_used: number;
    total_moves: number;
    streak?: number;
  };
  metadata?: {
    streak?: string;
    record?: string;
  };
}

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string | null;
  metadata?: {
    team_name?: string;
    [key: string]: unknown;
  };
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number;      // same matchup_id == these two teams played each other
  points: number;
  custom_points: number | null;
  players: string[] | null;
  starters: string[] | null;
  players_points?: Record<string, number>;
  starters_points?: number[];
}

// Playoff bracket node
export interface SleeperBracketMatch {
  r: number;               // round number
  m: number;               // match number within round
  t1: number | null;       // roster_id of team 1
  t2: number | null;       // roster_id of team 2
  w: number | null;        // roster_id of winner
  l: number | null;        // roster_id of loser
  t1_from?: { w?: number; l?: number };
  t2_from?: { w?: number; l?: number };
}

// ─── Endpoint functions ────────────────────────────────────────────────────

/** Current NFL state — week, season, season_type, etc. */
export const getNflState = () =>
  get<SleeperNflState>('/state/nfl');

/** Full league info for a given league_id. */
export const getLeague = (leagueId: string) =>
  get<SleeperLeague>(`/league/${leagueId}`);

/** All rosters in a league, including win/loss/points settings. */
export const getRosters = (leagueId: string) =>
  get<SleeperRoster[]>(`/league/${leagueId}/rosters`);

/** All users (owners) in a league. */
export const getUsers = (leagueId: string) =>
  get<SleeperUser[]>(`/league/${leagueId}/users`);

/** All matchups for a given week (1-indexed). Returns two entries per game sharing matchup_id. */
export const getMatchups = (leagueId: string, week: number) =>
  get<SleeperMatchup[]>(`/league/${leagueId}/matchups/${week}`);

/** Winners bracket (full playoff tree). */
export const getWinnersBracket = (leagueId: string) =>
  get<SleeperBracketMatch[]>(`/league/${leagueId}/winners_bracket`);

/** Losers bracket (consolation playoff tree). */
export const getLosersBracket = (leagueId: string) =>
  get<SleeperBracketMatch[]>(`/league/${leagueId}/losers_bracket`);


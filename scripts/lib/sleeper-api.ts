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

// Transaction (waiver, trade, free agent, etc.)
export interface SleeperDraftPick {
  round: number;
  season: string;
  league_id: string | null;
  roster_id: number;
  owner_id: number;
  previous_owner_id: number;
}

export interface SleeperTransaction {
  status: string;                           // e.g., 'complete', 'pending', 'failed'
  type: string;                             // e.g., 'waiver', 'trade', 'free_agent'
  metadata: { notes?: string } | null;
  created: number;                          // unix timestamp
  settings: {
    seq?: number;                           // waiver sequence
    waiver_bid?: number;                    // waiver bid amount
    is_counter?: number;                    // trade counter flag
  } | null;
  leg: number;                              // week/leg number
  draft_picks: SleeperDraftPick[];
  creator: string;                          // user_id
  transaction_id: string;
  adds: Record<string, number> | null;      // player_id -> roster_id
  drops: Record<string, number> | null;     // player_id -> roster_id
  consenter_ids: number[];                  // roster_ids of transaction consenters
  roster_ids: number[];                     // affected roster_ids
  status_updated: number;                   // unix timestamp
  waiver_budget: unknown[];                 // always empty array in observed data
}

// Draft pick result from /draft/{draft_id}/picks endpoint
export interface SleeperDraftPickResult {
  player_id: string;
  picked_by: string;                        // user_id of the manager who made the pick
  roster_id: string;                        // roster_id of the team that made the pick
  round: number;
  draft_slot: number;                       // column on the draft board (maps to draft-slots.json)
  pick_no: number;                          // overall pick number
  metadata: {
    team: string;
    status?: string;
    sport: string;
    position: string;
    player_id: string;
    number?: string;
    news_updated?: string;
    last_name: string;
    injury_status?: string;
    first_name: string;
    [key: string]: unknown;
  };
  is_keeper: boolean | null;
  draft_id: string;
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

/** All transactions for a given round/week (1-indexed). */
export const getTransactions = (leagueId: string, round: number) =>
  get<SleeperTransaction[]>(`/league/${leagueId}/transactions/${round}`);

/** All draft picks for a given draft_id. */
export const getDraftPicks = (draftId: string) =>
  get<SleeperDraftPickResult[]>(`/draft/${draftId}/picks`);

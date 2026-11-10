// Sleeper API client. Public, no key needed; be a polite guest — a handful
// of calls per week, 10 s timeout, one retry (spec §5.5).

const API = 'https://api.sleeper.app/v1';

async function fetchJson(path: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`sleeper ${res.status} on ${path}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

export async function getLeague(leagueId: string) {
  return await fetchJson(`/league/${leagueId}`) as {
    settings: { playoff_week_start?: number };
  };
}

// One entry per roster per week; `points` is the final fantasy score once
// games are done — and 0 before/at kickoff, hence the §5.4 finality guard.
export async function getWeekMatchups(leagueId: string, week: number) {
  return await fetchJson(`/league/${leagueId}/matchups/${week}`) as
    { roster_id: number; matchup_id: number | null; points: number }[];
}

export async function getBrackets(leagueId: string) {
  const [winners, losers] = await Promise.all([
    fetchJson(`/league/${leagueId}/winners_bracket`),
    fetchJson(`/league/${leagueId}/losers_bracket`),
  ]);
  return { winners, losers } as {
    winners: import('./labels.ts').BracketGame[];
    losers: import('./labels.ts').BracketGame[];
  };
}

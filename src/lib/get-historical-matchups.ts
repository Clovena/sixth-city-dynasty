import { supabase } from './supabase';

interface HistoricalMatchup {
  year: number;
  week: number;
  teamAId: number;
  teamBId: number;
  teamAScore: number;
  teamBScore: number;
}

export async function getHistoricalMatchups(
  teamAAbbr: string,
  teamBAbbr: string
): Promise<HistoricalMatchup[]> {
  // Resolve abbr → sleeper_id (which matches roster_id in matchups)
  const { data: franchiseRows, error: fError } = await supabase
    .schema('scdfl')
    .from('franchises')
    .select('id, abbr')
    .is('to', null)
    .in('abbr', [teamAAbbr, teamBAbbr]);

  if (fError || !franchiseRows) return [];

  const teamA = franchiseRows.find(f => f.abbr === teamAAbbr);
  const teamB = franchiseRows.find(f => f.abbr === teamBAbbr);

  if (!teamA || !teamB) return [];

  const idA = teamA.id;
  const idB = teamB.id;

  // Fetch all matchups between these two teams
  const { data: matchupRows, error: mError } = await supabase
    .schema('scdfl')
    .from('matchups')
    .select('year, week, roster_id_a, roster_id_b, score_a, score_b')
    .not('matchup_id', 'is', null)
    .or(
      `and(roster_id_a.eq.${idA},roster_id_b.eq.${idB}),and(roster_id_a.eq.${idB},roster_id_b.eq.${idA})`
    )
    .order('year', { ascending: false })
    .order('week', { ascending: false });

  if (mError || !matchupRows) return [];

  return matchupRows.map(row => {
    // Normalize so teamA/teamB scores match the caller's abbr order
    const aIsFirst = row.roster_id_a === idA;
    return {
      year: row.year,
      week: row.week,
      teamAId: idA,
      teamBId: idB,
      teamAScore: aIsFirst ? (row.score_a || 0) : (row.score_b || 0),
      teamBScore: aIsFirst ? (row.score_b || 0) : (row.score_a || 0),
    };
  });
}
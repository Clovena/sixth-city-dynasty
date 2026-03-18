import { glob } from 'astro/loaders';
import franchises from '../data/franchises.json';

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
  const teamA = franchises.find(f => f.abbr === teamAAbbr);
  const teamB = franchises.find(f => f.abbr === teamBAbbr);

  if (!teamA || !teamB) {
    return [];
  }

  const teamAId = teamA.id;
  const teamBId = teamB.id;
  const results: HistoricalMatchup[] = [];

  // Load all matchup files
  const matchupFiles = import.meta.glob<Record<string, Array<{
    roster_id: number;
    matchup_id: number | null;
    points: number;
    custom_points: number | null;
  }>>>('/src/data/raw/*-matchups.json', { eager: true });

  for (const [path, data] of Object.entries(matchupFiles)) {
    const yearMatch = path.match(/(\d{4})-matchups\.json/);
    if (!yearMatch) continue;

    const year = parseInt(yearMatch[1]);
    const matchups = data.default || data;

    // Iterate through each week
    for (const [weekStr, weekData] of Object.entries(matchups)) {
      const week = parseInt(weekStr);
      if (!Array.isArray(weekData)) continue;

      // Find entries for both teams in this week
      const teamAEntry = weekData.find(entry => entry.roster_id === teamAId);
      const teamBEntry = weekData.find(entry => entry.roster_id === teamBId);

      // Check if they played each other (same matchup_id)
      if (
        teamAEntry &&
        teamBEntry &&
        teamAEntry.matchup_id === teamBEntry.matchup_id &&
        teamAEntry.matchup_id !== null
      ) {
        const teamAScore = teamAEntry.custom_points ?? teamAEntry.points ?? 0;
        const teamBScore = teamBEntry.custom_points ?? teamBEntry.points ?? 0;

        results.push({
          year,
          week,
          teamAId,
          teamBId,
          teamAScore,
          teamBScore,
        });
      }
    }
  }

  // Sort by year descending, then week descending
  results.sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return b.week - a.week;
  });

  return results;
}

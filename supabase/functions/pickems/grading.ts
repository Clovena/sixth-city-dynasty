// Grading, pure. Input: a poll's two team keys and a map of team_key →
// final points. Output: who won, or why we can't say yet (spec §5.4).

export type Grade =
  | { status: 'won'; winnerKey: string }
  | { status: 'void' } // exact tie: nobody credited or charged
  | { status: 'not_final' }; // missing or still-0–0 scores → retry later

export function gradeMatchup(
  teamAKey: string,
  teamBKey: string,
  pointsByKey: Record<string, number | undefined>,
): Grade {
  const a = pointsByKey[teamAKey];
  const b = pointsByKey[teamBKey];
  if (a === undefined || b === undefined) return { status: 'not_final' };
  // Finality guard: Sleeper reports 0–0 for unplayed matchups, so a double
  // zero means "no data yet", never a real final (spec §5.4).
  if (a === 0 && b === 0) return { status: 'not_final' };
  if (a === b) return { status: 'void' };
  return { status: 'won', winnerKey: a > b ? teamAKey : teamBKey };
}

// Reminder recipients (spec §10.3, §18.2): players flagged remind=true who
// have voted on fewer polls than exist this week. picksByUser may come from
// live (pre-finalization) voter lists — approximate is fine for a nudge.
export type MissingPicker = { userId: string; picked: number; total: number };

export function missingPickers(
  eligible: { userId: string; remind: boolean }[],
  pollCount: number,
  picksByUser: Map<string, number>,
): MissingPicker[] {
  return eligible
    .filter((p) => p.remind)
    .map((p) => ({
      userId: p.userId,
      picked: picksByUser.get(p.userId) ?? 0,
      total: pollCount,
    }))
    .filter((p) => p.picked < p.total);
}
